import asyncio
import os
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import load_env
from .planner import plan
from .services import vision
from .services.wearable import status as wearable_status

load_env()

MAX_IMAGE_BYTES = int(os.getenv('MAX_IMAGE_BYTES', str(4 * 1024 * 1024)))
IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp'}

app = FastAPI(title='GuideBand Local API', version='0.2.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv('CORS_ORIGINS', 'http://localhost:4173,http://127.0.0.1:4173').split(',')],
    allow_methods=['GET', 'POST'],
    allow_headers=['*'],
)
tasks: dict[str, dict] = {}

class Command(BaseModel):
    text: str = Field(min_length=1, max_length=500)

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    delay_minutes: int = Field(ge=0, le=1440)

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

@app.get('/health')
def health(): return {'status':'ok','time':now(),'raw_media_storage':False}

@app.get('/system/status')
def system_status():
    return {
        'wearable': wearable_status(),
        'modules': {'commands':'ready','journey':'demo','bridge':'ready','vision':vision.detector.status()['state']},
        'vision': {'detector': vision.detector.status(), 'cloud_providers': vision.configured_providers()},
    }

@app.post('/commands/plan')
def command_plan(command: Command): return plan(command.text)

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
    if image.content_type not in IMAGE_TYPES:
        raise HTTPException(415, 'Send a JPEG, PNG or WebP image')
    body = await image.read(MAX_IMAGE_BYTES + 1)
    if len(body) > MAX_IMAGE_BYTES:
        raise HTTPException(413, 'Image is too large')
    started = time.monotonic()
    try:
        detections = await asyncio.to_thread(vision.detector.detect, body)
    except vision.VisionError as error:
        raise HTTPException(422, str(error)) from error
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
