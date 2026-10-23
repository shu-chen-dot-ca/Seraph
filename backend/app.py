"""The backend: one FastAPI app that serves everything under /api.

The pieces are made once in backend/shared.py (the Repos, Issues and Tracked lists,
jobs, the inbox, the VMs, the VM queue and the agents), and each page has its
own router in backend/*_api.py.

The browser never polls. It keeps one websocket open on /api/live, gets every
topic when it connects, then only the topics that changed. Every store has a
`version` number that goes up on each change, so finding the changes is a
cheap comparison every 250 ms.

Only this machine's own pages may use the API: the Host must be localhost or
127.0.0.1 (no DNS rebinding), and a request or websocket with an Origin must
come from a page on localhost or 127.0.0.1 (the Vite dev server, on whatever
port it picked). Pages from anywhere else, like a VM's desktop page (which the
agent controls) or another website, get 403.
"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from backend import agents_api, images_api, inbox_api, issues_api, repos_api, tracked_api, vms_api
from backend.shared import agents, images, inbox, issue_facts, issues, jobs, repos, tracked, tracked_issues, vms

# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

LOCAL_HOSTS = ["localhost", "127.0.0.1"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Agents run on this event loop, so they start here and not at import.
    await agents.start()
    facts_keeper = asyncio.create_task(issues_api.keep_facts())
    tracked_keeper = asyncio.create_task(tracked_api.keep_tracked())
    yield
    facts_keeper.cancel()
    tracked_keeper.cancel()
    await agents.stop()


app = FastAPI(lifespan=lifespan)
app.include_router(inbox_api.router)
app.include_router(issues_api.router)
app.include_router(repos_api.router)
app.include_router(tracked_api.router)
app.include_router(agents_api.router)
app.include_router(vms_api.router)
app.include_router(images_api.router)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOCAL_HOSTS)


@app.middleware("http")
async def check_origin(request: Request, call_next):
    """Browsers send Origin with every POST, PUT and DELETE (also no-cors ones): only local pages may call."""
    origin = request.headers.get("origin")
    if origin is not None and urlsplit(origin).hostname not in LOCAL_HOSTS:
        return JSONResponse(status_code=403, content={"detail": "Only pages on this machine may use the API."})
    return await call_next(request)


@app.exception_handler(httpx.HTTPStatusError)
def github_error(request: Request, error: httpx.HTTPStatusError) -> JSONResponse:
    """GitHub's own message (rate limit, not found, ...) instead of a bare 500."""
    try:
        message = error.response.json().get("message", "GitHub request failed.")
    except ValueError:
        message = "GitHub request failed."
    return JSONResponse(status_code=error.response.status_code, content={"detail": message})


@app.websocket("/api/live")
async def live(websocket: WebSocket) -> None:
    """Sends every topic once, then each topic again whenever its version changes."""
    # Websockets skip the http middleware, and browsers let any page open one: checked here.
    origin = websocket.headers.get("origin")
    if origin is not None and urlsplit(origin).hostname not in LOCAL_HOSTS:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    # The version of each topic this browser has; None until it is sent.
    sent = {"repos": None, "issues": None, "tracked": None, "jobs": None, "inbox": None, "agents": None, "vms": None, "images": None}
    while True:
        # The version is noted before the data is read: a change in between is sent again next tick, never lost.
        messages = []
        if sent["repos"] != repos.version:
            sent["repos"] = repos.version
            data = {"items": repos.items(), "can_undo": repos.can_undo(), "can_redo": repos.can_redo()}
            messages.append({"topic": "repos", "data": data})
        # Issues carry their facts (issue_facts.py), so the topic changes when either does.
        if sent["issues"] != (issues.version, issue_facts.version):
            sent["issues"] = (issues.version, issue_facts.version)
            facts = issue_facts.all()
            items = issues.items()
            for item in items:
                item["facts"] = facts.get(item["id"])
            data = {"items": items, "can_undo": issues.can_undo(), "can_redo": issues.can_redo()}
            messages.append({"topic": "issues", "data": data})
        # Each tracked repo carries its latest check (tracked_issues.py), like issues carry their facts.
        if sent["tracked"] != (tracked.version, tracked_issues.version):
            sent["tracked"] = (tracked.version, tracked_issues.version)
            checks = tracked_issues.all()
            items = tracked.items()
            for item in items:
                item["check"] = checks.get(item["full_name"])
            data = {"items": items, "can_undo": tracked.can_undo(), "can_redo": tracked.can_redo()}
            messages.append({"topic": "tracked", "data": data})
        if sent["jobs"] != jobs.version:
            sent["jobs"] = jobs.version
            messages.append({"topic": "jobs", "data": jobs.list()})
        if sent["inbox"] != inbox.version:
            sent["inbox"] = inbox.version
            messages.append({"topic": "inbox", "data": inbox.list()})
        if sent["agents"] != agents.version:
            sent["agents"] = agents.version
            messages.append({"topic": "agents", "data": agents.summaries()})
        if sent["vms"] != vms.version:
            sent["vms"] = vms.version
            messages.append({"topic": "vms", "data": [vms.summary(record) for record in vms.list()]})
        # Images say which VMs were made from each, so they are sent again when the VM list changes too.
        # Not on every usage sample though: only the number of VMs and their images matter.
        vm_images = [(record.name, record.image_fingerprint) for record in vms.list()]
        if sent["images"] != (images.version, vm_images):
            sent["images"] = (images.version, vm_images)
            messages.append({"topic": "images", "data": images.summary()})

        try:
            for message in messages:
                await websocket.send_json(message)
            # Waiting for a message from the browser is the 250 ms tick; it also notices a closed tab at once.
            received = await asyncio.wait_for(websocket.receive(), timeout=0.25)
        except TimeoutError:
            continue
        except (WebSocketDisconnect, WebSocketDisconnected):
            return
        if received["type"] == "websocket.disconnect":
            return


def main() -> None:
    uvicorn.run("backend.app:app", host="127.0.0.1", port=int(os.environ["BACKEND_PORT"]), reload=True)
