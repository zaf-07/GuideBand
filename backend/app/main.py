from datetime import datetime, timedelta, timezone
from uuid import uuid4
from fastapi import FastAPI, WebSocket
from pydantic import BaseModel, Field
from .planner import plan
from .services.wearable import status as wearable_status

app = FastAPI(title='GuideBand Local API', version='0.1.0')
tasks: dict[str, dict] = {}

class Command(BaseModel):
    text: str = Field(min_length=1, max_length=500)

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    delay_minutes: int = Field(ge=0, le=1440)

@app.get('/health')
def health(): return {'status':'ok','time':datetime.now(timezone.utc).isoformat(),'raw_media_storage':False}

@app.get('/system/status')
def system_status(): return {'wearable':wearable_status(),'modules':{'commands':'ready','journey':'demo','bridge':'ready','vision':'not_loaded'}}

@app.post('/commands/plan')
def command_plan(command: Command): return plan(command.text)

@app.post('/tasks', status_code=201)
def create_task(data: TaskCreate):
    task={'id':str(uuid4()),'title':data.title,'due_at':(datetime.now(timezone.utc)+timedelta(minutes=data.delay_minutes)).isoformat(),'status':'scheduled'};tasks[task['id']]=task;return task

@app.get('/tasks')
def list_tasks(): return list(tasks.values())

@app.websocket('/events')
async def events(ws: WebSocket):
    await ws.accept();await ws.send_json({'event':'connected','timestamp':datetime.now(timezone.utc).isoformat()})
    while True:
        message=await ws.receive_text();await ws.send_json({'event':'ack','message':message,'timestamp':datetime.now(timezone.utc).isoformat()})
