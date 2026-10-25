"""The Guide: the round button at the bottom right of every page (github_searcher/guide.py, frontend/src/Guide.tsx).

The browser sends a message with the page the user is on, follows the chat with GET /api/guide while a turn runs, and
does the page actions the Guide asks for (pending), posting what happened to /api/guide/result. Its turns run on the
event loop, so the endpoints are `async def`.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import guide

router = APIRouter(prefix="/api")


class MessageRequest(BaseModel):
    text: str
    page: str  # the page the user is on, as the browser read it
    tab: str  # the browser tab it came from, where the page actions happen


class ResultRequest(BaseModel):
    id: int  # the page action's id
    ok: bool
    text: str  # the page after it, or why it couldn't be done


@router.get("/guide")
async def guide_chat() -> dict:
    """The conversation, whether a turn runs, and the page action waiting for the browser."""
    return guide.chat()


@router.post("/guide")
async def message_guide(body: MessageRequest) -> dict:
    """Starts a turn with the message and answers at once; GET the chat to follow it."""
    try:
        guide.send(body.text, body.page, body.tab)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/guide/result")
async def guide_result(body: ResultRequest) -> dict:
    guide.result(body.id, body.ok, body.text)
    return {}


@router.post("/guide/stop")
async def stop_guide() -> dict:
    await guide.interrupt()
    return {}


@router.delete("/guide")
async def clear_guide() -> dict:
    """A new conversation."""
    try:
        guide.clear()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
