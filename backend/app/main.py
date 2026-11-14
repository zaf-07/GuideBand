import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import load_env
from .planner import plan
from .services import bridge, llm, vision
from .services.assistant import Assistant
from .services.memory import Memory
from .services.payments import CATALOGUE, Orders, money
from .services.wearable import status as wearable_status

load_env()

MAX_IMAGE_BYTES = int(os.getenv('MAX_IMAGE_BYTES', str(4 * 1024 * 1024)))
IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp'}
DEFAULT_ORIGINS = 'http://localhost:4173,http://127.0.0.1:4173,http://localhost:8000,http://127.0.0.1:8000,https://zaf-07.github.io'

app = FastAPI(title='GuideBand Local API', version='0.3.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv('CORS_ORIGINS', DEFAULT_ORIGINS).split(',')],
    allow_methods=['GET', 'POST', 'DELETE'],
    allow_headers=['*'],
)
tasks: dict[str, dict] = {}
memory = Memory()
orders = Orders()
assistant = Assistant(memory, orders)

class Command(BaseModel):
    text: str = Field(min_length=1, max_length=500)

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    delay_minutes: int = Field(ge=0, le=1440)

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

async def read_image(image: UploadFile) -> bytes:
    if image.content_type not in IMAGE_TYPES:
        raise HTTPException(415, 'Send a JPEG, PNG or WebP image')
    body = await image.read(MAX_IMAGE_BYTES + 1)
    if len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(413, 'Image is too large')
    return body

async def detect(body: bytes) -> list[dict]:
    try:
        return await asyncio.to_thread(vision.detector.detect, body)
    except vision.VisionError as error:
        raise HTTPException(422, str(error)) from error

@app.get('/health')
def health(): return {'status':'ok','time':now(),'raw_media_storage':False}

@app.get('/system/status')
def system_status():
    stripe_key = os.getenv('STRIPE_SECRET_KEY', '')
    return {
        'wearable': wearable_status(),
        'modules': {'commands':'ready','journey':'demo','bridge':'ready','vision':vision.detector.status()['state']},
        'vision': {'detector': vision.detector.status(), 'cloud_providers': vision.configured_providers(), 'model': llm.model()},
        'payments': {'mode': 'stripe_test' if stripe_key.startswith('sk_test_') else ('refused_live_key' if stripe_key else 'simulated'),
                     'menu': [{'item': name, 'price': money(cents)} for name, cents in CATALOGUE.values()]},
        'memory': {'notes': len(memory.notes(1000)), 'objects': len(memory.sightings())},
    }

@app.post('/commands/plan')
def command_plan(command: Command): return plan(command.text)

# ---------- See ----------

@app.post('/vision/analyze')
async def vision_analyze(
    image: UploadFile = File(...),
    question: str = Form('', max_length=300),
    describe: bool = Form(True),
):
    """One camera frame in, spoken-ready text out. The frame is never stored.

    `warnings` always come from the local detector. With `describe=false` the
    cloud is skipped entirely, which is the fast path for a continuous stream.
    """
    body = await read_image(image)
    started = time.monotonic()
    detections = await detect(body)
    memory.record_detections(detections)
    detect_ms = int((time.monotonic() - started) * 1000)
    result = {
        'event': 'scene',
        'timestamp': now(),
        'warnings': vision.hazard_warnings(detections),
        'detections': detections,
        'detector': vision.detector.status()['state'],
        'description': None,
        'provider': None,
        'failed_providers': [],
    }
    if describe:
        answer = await vision.describe(body, image.content_type, question, detections)
        result.update(description=answer['text'], provider=answer['provider'], failed_providers=answer['failed_providers'])
    result['latency_ms'] = {'detect': detect_ms, 'total': int((time.monotonic() - started) * 1000)}
    return result

# ---------- Assistant: see, remember, act ----------

@app.post('/assistant')
async def assistant_respond(
    text: str = Form(..., min_length=1, max_length=300),
    session: str = Form('default', max_length=64),
    image: UploadFile | None = File(None),
):
    """One spoken sentence in, one spoken reply out. `image` is the current camera frame, if any."""
    started = time.monotonic()
    body = await read_image(image) if image is not None else None
    try:
        reply = await assistant.respond(session, text, body, image.content_type if image is not None else 'image/jpeg')
    except vision.VisionError as error:
        raise HTTPException(422, str(error)) from error
    reply['timestamp'] = now()
    reply['latency_ms'] = int((time.monotonic() - started) * 1000)
    return reply

# ---------- Remember ----------

@app.post('/memory/observe')
async def memory_observe(image: UploadFile = File(...)):
    """Quietly turn the current frame into a text note. The frame is discarded."""
    body = await read_image(image)
    detections = await detect(body)
    memory.record_detections(detections)
    return await memory.snapshot(body, image.content_type, vision.local_description(detections))

@app.get('/memory')
def memory_list(): return {'notes': memory.notes(), 'objects': memory.sightings(), 'stores_media': False}

@app.delete('/memory')
def memory_clear():
    memory.clear()
    return {'status': 'cleared'}

# ---------- Bridge ----------

@app.post('/bridge/sign')
async def bridge_sign(images: list[UploadFile] = File(...)):
    """Experimental: a few frames of signing in, a cautious English reading out."""
    if not llm.configured():
        raise HTTPException(503, 'Sign reading needs the cloud vision model')
    frames = [(await read_image(image), image.content_type) for image in images[:bridge.MAX_FRAMES]]
    return await bridge.read_sign(frames)

# ---------- Tasks and events ----------

@app.post('/tasks', status_code=201)
def create_task(data: TaskCreate):
    task={'id':str(uuid4()),'title':data.title,'due_at':(datetime.now(timezone.utc)+timedelta(minutes=data.delay_minutes)).isoformat(),'status':'scheduled'};tasks[task['id']]=task;return task

@app.get('/tasks')
def list_tasks(): return list(tasks.values())

@app.websocket('/events')
async def events(ws: WebSocket):
    await ws.accept();await ws.send_json({'event':'connected','timestamp':now()})
    while True:
        message=await ws.receive_text();await ws.send_json({'event':'ack','message':message,'timestamp':now()})

# Serve the web app from the same origin, so one address (and one HTTPS
# certificate or tunnel) covers both the page and the API on a phone.
WEB_DIR = Path(__file__).resolve().parents[2] / 'web'
if WEB_DIR.is_dir():
    app.mount('/', StaticFiles(directory=WEB_DIR, html=True), name='web')
