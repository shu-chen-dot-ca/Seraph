"""Sherpa: the round button at the bottom right of every page (github_searcher/sherpa.py, frontend/src/Sherpa.tsx).

The browser sends a message with the page the user is on, follows the chat with GET /api/sherpa while a turn runs, and
does the page actions Sherpa asks for (pending), posting what happened to /api/sherpa/result. Its turns run on the
event loop, so the endpoints are `async def`.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import sherpa

router = APIRouter(prefix="/api")


class MessageRequest(BaseModel):
    text: str
    page: str  # the page the user is on, as the browser read it
    tab: str  # the browser tab it came from, where the page actions happen


class ResultRequest(BaseModel):
    id: int  # the page action's id
    ok: bool
    text: str  # the page after it, or why it couldn't be done


@router.get("/sherpa")
async def sherpa_chat() -> dict:
    """The conversation, whether a turn runs, and the page action waiting for the browser."""
    return sherpa.chat()


@router.post("/sherpa")
async def message_sherpa(body: MessageRequest) -> dict:
    """Starts a turn with the message and answers at once; GET the chat to follow it."""
    try:
        sherpa.send(body.text, body.page, body.tab)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/sherpa/result")
async def sherpa_result(body: ResultRequest) -> dict:
    sherpa.result(body.id, body.ok, body.text)
    return {}


@router.post("/sherpa/stop")
async def stop_sherpa() -> dict:
    await sherpa.interrupt()
    return {}


@router.delete("/sherpa")
async def clear_sherpa() -> dict:
    """A new conversation."""
    try:
        sherpa.clear()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
