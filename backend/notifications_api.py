"""The GitHub tab's Notifications page (github_searcher/notifications.py): GitHub's own notifications for you.

POST /api/notifications/{id}/read marks one read (opening it does that), /api/notifications/{id}/done takes it out
(GitHub's Done), /api/notifications/read_all marks every one read, /api/notifications/refresh reads them again now.

keep_notifications(), which the app runs in the background, reads them every REFRESH_SECONDS and at once when you sign
in or out. They reach the browser through /api/live (topic "notifications").
"""

import asyncio
import time

from fastapi import APIRouter, HTTPException

from backend.shared import github_account, notifications
from github_searcher.notifications import REFRESH_SECONDS

router = APIRouter(prefix="/api")

CHECK_SECONDS = 5


@router.post("/notifications/refresh")
def refresh() -> dict:
    notifications.refresh()
    return {"ok": True}


@router.post("/notifications/read_all")
def read_all() -> dict:
    try:
        notifications.mark_all_read()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {"ok": True}


@router.post("/notifications/{thread_id}/{action}")
def change(thread_id: str, action: str) -> dict:
    if not thread_id.isdigit():
        raise HTTPException(status_code=400, detail="That isn't a notification.")
    try:
        if action == "read":
            notifications.mark_read(thread_id)
        elif action == "done":
            notifications.done(thread_id)
        else:
            raise HTTPException(status_code=404, detail=f"Unknown action {action}.")
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {"ok": True}


async def keep_notifications() -> None:
    """Runs as long as the backend. A failed read shows its error on the page and is tried again next round."""
    last = None
    # The login they were last read for: a sign in or out reads them again at once.
    read_for = "none yet"
    while True:
        login = github_account.status().get("login")
        if last is None or login != read_for or time.monotonic() - last > REFRESH_SECONDS:
            last = time.monotonic()
            read_for = login
            try:
                await asyncio.to_thread(notifications.refresh)
            except Exception as error:
                print(f"[notifications] could not read them: {error}")
        await asyncio.sleep(CHECK_SECONDS)
