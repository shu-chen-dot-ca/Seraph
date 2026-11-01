"""Updates of the live copy (github_searcher/updates.py): Update in the header and Settings → About.

GET /api/health answers once the app has started: deploy/switch.sh waits for it after a switch, then watches it for the
new release's first minutes. "errors" is how many errors the app reported since it started (github_searcher/crashes.py):
switch.sh takes the release back when they climb.
POST /api/updates/check checks GitHub for a newer release now (Check for updates).
POST /api/updates/restart restarts on the release that is ready (Restart in the Update dialog).
POST /api/updates/previous goes back to the release before this one, with data/ from before the update (Previous version).

Restart and Previous version answer at once. The switch waits first, up to a minute, for a moment when no agent is in
the middle of a tool call, so none is cut off half-way through a command. An agent's turn that is still going is cut
off like on any restart, and the agent carries on after it (Agents.stop and start). VMs, and the runs in them, keep going.

keep_updates(), which the app runs in the background, checks every CHECK_SECONDS, and at once when asked (Check for
updates, or a Release on the app's own repo: backend/projects_api.py). A newer release that is ready (it passed its
check, updates.py) is installed by itself, the way Restart does it. The state reaches the browser through /api/live
(topic "updates").
"""

import asyncio
import time

from fastapi import APIRouter, HTTPException

from backend.shared import agents, crashes, updates
from github_searcher.updates import CHECK_SECONDS, HOME

router = APIRouter(prefix="/api")

# The most the switch waits for agents to finish their tool calls.
QUIET_SECONDS = 60
# The switch that waits for its moment: kept here, so it isn't dropped while it waits.
waiting = []


@router.get("/health")
def health() -> dict:
    return {"ok": True, "version": updates.running, "errors": crashes.since_start}


@router.post("/updates/check")
def check() -> dict:
    if HOME == "":
        raise HTTPException(status_code=400, detail="This is the dev copy: updates are for the live copy (deploy/install.sh).")
    updates.asked = True
    return {"ok": True}


@router.post("/updates/restart")
async def restart() -> dict:
    if updates.ready is None:
        raise HTTPException(status_code=400, detail="No update is ready.")
    if updates.restarting:
        raise HTTPException(status_code=400, detail="Already restarting.")
    updates.restarting = True
    updates.version += 1
    waiting.append(asyncio.get_running_loop().create_task(switch_when_quiet(updates.ready, "")))
    return {"ok": True}


@router.post("/updates/previous")
async def previous() -> dict:
    tag, backup = updates.previous()
    if tag is None:
        raise HTTPException(status_code=400, detail="There is no version before this one.")
    if updates.restarting:
        raise HTTPException(status_code=400, detail="Already restarting.")
    updates.restarting = True
    updates.version += 1
    waiting.append(asyncio.get_running_loop().create_task(switch_when_quiet(tag, backup)))
    return {"ok": True}


async def switch_when_quiet(tag: str, restore: str) -> None:
    """Waits for a moment when no agent is in a tool call (at most QUIET_SECONDS), then switches to release tag."""
    for _ in range(QUIET_SECONDS):
        in_tool = False
        for agent in agents.agents.values():
            # A tool call is going while its line is the agent's last one (its result comes after it).
            if agent.busy and len(agent.history) > 0 and agent.history[-1]["type"] == "tool":
                in_tool = True
        if not in_tool:
            break
        await asyncio.sleep(1)
    try:
        await asyncio.to_thread(updates.switch, tag, restore)
    except Exception as error:
        updates.restarting = False
        updates.error = str(error)
        updates.version += 1


async def keep_updates() -> None:
    """Runs as long as the backend, in the live copy only. A failed check shows its error in Settings → About."""
    if HOME == "":
        return
    last = None
    while True:
        if last is None or updates.asked or time.monotonic() - last > CHECK_SECONDS:
            last = time.monotonic()
            updates.asked = False
            await asyncio.to_thread(updates.check)
            # Ready: installed now (constant development; switch.sh takes it back if it goes wrong).
            if updates.ready is not None and not updates.restarting:
                updates.restarting = True
                updates.version += 1
                waiting.append(asyncio.get_running_loop().create_task(switch_when_quiet(updates.ready, "")))
        await asyncio.sleep(5)
