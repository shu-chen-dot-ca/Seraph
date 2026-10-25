"""Sherpa: the round button at the bottom right of every page (github_searcher/sherpa.py, frontend/src/Sherpa.tsx).

The browser sends a message with the page the user is on, follows the chat with GET /api/sherpa while a turn runs, and
does the page actions Sherpa asks for (pending), posting what happened to /api/sherpa/result. The history lists the
kept chats; one can be opened again or deleted, and New chat opens an empty one. Its turns run on the event loop, so
the endpoints are `async def`.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.shared import sherpa

router = APIRouter(prefix="/api")


class MessageRequest(BaseModel):
    text: str
    page: str  # the page the user is on, as the browser read it
    tab: str  # the browser tab it came from, where the page actions happen


class QueuedRequest(BaseModel):
    index: int  # where it waits, oldest first
    text: str  # its text, to make sure it is that one


class ResultRequest(BaseModel):
    id: int  # the page action's id
    ok: bool
    text: str  # the page after it, or why it couldn't be done
    image: str = ""  # a screenshot of the app, as base64 JPEG


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
    sherpa.result(body.id, body.ok, body.text, body.image)
    return {}


@router.post("/sherpa/stop")
async def stop_sherpa() -> dict:
    await sherpa.interrupt()
    return {}


@router.post("/sherpa/queue/cancel")
async def cancel_queued_message(body: QueuedRequest) -> dict:
    """Takes a queued message out before it goes in."""
    try:
        sherpa.cancel_queued(body.index, body.text)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.post("/sherpa/new")
async def new_sherpa_chat() -> dict:
    """Opens a new, empty chat; the one before stays in the history."""
    try:
        sherpa.new_chat()
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.get("/sherpa/chats")
async def sherpa_chats() -> dict:
    """The history: every chat, the newest first."""
    return {"chats": sherpa.chats()}


@router.post("/sherpa/chats/{chat_id}/open")
async def open_sherpa_chat(chat_id: str) -> dict:
    try:
        sherpa.open_chat(chat_id)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@router.delete("/sherpa/chats/{chat_id}")
async def delete_sherpa_chat(chat_id: str) -> dict:
    try:
        sherpa.delete_chat(chat_id)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}
