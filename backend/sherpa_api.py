"""Sherpa, the round button at the bottom right of every page (frontend/src/Sherpa.tsx, github_searcher/sherpa.py):
the helper that does things in the app for you, many at once.

GET /api/sherpa is its chat as it stands: {"history", "busy", "queued", "cost_usd"}; the panel asks for it every second
while it is open. POST /api/sherpa/send sends your message with the page you are on (it waits while a turn runs),
POST /api/sherpa/stop stops the turn (and drops what waits), POST /api/sherpa/new starts the chat over. Sherpa's turns
run on the event loop, so these are `async def`.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import sherpa

router = APIRouter(prefix="/api")


class SendRequest(BaseModel):
    text: str
    page: str = ""


@router.get("/sherpa")
def chat() -> dict:
    return sherpa.state()


@router.post("/sherpa/send")
async def send(body: SendRequest) -> dict:
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="The message is empty.")
    sherpa.send(body.text.strip(), body.page)
    return sherpa.state()


@router.post("/sherpa/stop")
async def stop() -> dict:
    await sherpa.stop()
    return sherpa.state()


@router.post("/sherpa/new")
async def new_chat() -> dict:
    try:
        sherpa.new_chat()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return sherpa.state()
