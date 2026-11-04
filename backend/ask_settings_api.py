"""Settings → Asking: how the agents' questions in the Inbox wait for you (github_searcher/inbox.py has how they work).

- GET /api/ask_settings: {"timer_minutes", "must_wait": [...]}. timer_minutes is how long a timed question (one with
  options and the agent's recommendation) waits before the app answers it with that recommendation. must_wait is the
  kinds of question that always wait for you instead: some of money, sensitive, github and delete (all of them until
  you switch some off). A question without options always waits.
- PUT /api/ask_settings with both changes them: timer_minutes from 1 to 1440 (a day), must_wait only those four. Questions
  already asked keep their deadline.

Kept in DATA_DIR/ask_settings.json, read again whenever an agent asks.
"""

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from github_searcher.inbox import ASK_SETTINGS_FILE, MUST_WAIT, TIMER_MINUTES

router = APIRouter(prefix="/api")


class AskSettingsRequest(BaseModel):
    timer_minutes: int
    must_wait: list[str]


@router.get("/ask_settings")
def get_ask_settings() -> dict:
    settings = {"timer_minutes": TIMER_MINUTES, "must_wait": list(MUST_WAIT)}
    if ASK_SETTINGS_FILE.is_file():
        settings.update(json.loads(ASK_SETTINGS_FILE.read_text()))
    return settings


@router.put("/ask_settings")
def put_ask_settings(body: AskSettingsRequest) -> dict:
    if body.timer_minutes < 1 or body.timer_minutes > 1440:
        raise HTTPException(status_code=400, detail="The timer is 1 to 1440 minutes.")
    for name in body.must_wait:
        if name not in MUST_WAIT:
            raise HTTPException(status_code=400, detail=f"Unknown kind of question {name!r}, use some of: {', '.join(MUST_WAIT)}.")
    # In MUST_WAIT's order, each once.
    settings = {"timer_minutes": body.timer_minutes, "must_wait": [name for name in MUST_WAIT if name in body.must_wait]}
    ASK_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Write, then rename: a crash never leaves half a file.
    temporary = ASK_SETTINGS_FILE.with_name(ASK_SETTINGS_FILE.name + ".tmp")
    temporary.write_text(json.dumps(settings, indent=2))
    temporary.replace(ASK_SETTINGS_FILE)
    return settings
