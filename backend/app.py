"""The backend: one FastAPI app that serves everything under /api.

The pieces are made once in backend/shared.py (the Repos, Issues and Tracked lists,
jobs, the inbox, your GitHub account, your PRs, the VMs, the VM queue and the agents), and each page has its
own router in backend/*_api.py (Settings' GitHub account: github_account_api.py; the PRs page: prs_api.py).

The browser never polls. It keeps one websocket open on /api/live, gets every
topic when it connects, then only the topics that changed. Every store has a
`version` number that goes up on each change, so finding the changes is a
cheap comparison every 250 ms.

The browser also says, on the same websocket, whether it shows a Resource page: {"watch_resource": true or false}.
While none does, the NVIDIA GPU is never asked for its numbers, so it can sleep (sandbox/resource_usage.py).

Only this machine's own pages may use the API: the Host must be localhost or
127.0.0.1 (no DNS rebinding), and a request or websocket with an Origin must
come from a page on localhost or 127.0.0.1 (the Vite dev server, on whatever
port it picked). Pages from anywhere else, like a VM's desktop page (which the
agent controls) or another website, get 403.
"""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from backend import agents_api, artifacts_api, explore_api, github_account_api, images_api, inbox_api, issues_api, prs_api, repos_api, sherpa_api, tracked_api, vms_api
from backend.shared import agents, explore, images, inbox, issue_facts, issue_tags, issues, jobs, pr_tracking, rejections, repo_signals, repos, resource_usage, sherpa, tracked, tracked_issues, vms
from github_searcher.token_balancer import BALANCER

# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

LOCAL_HOSTS = ["localhost", "127.0.0.1"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Agents run on this event loop, so they start here and not at import.
    await agents.start()
    # Sherpa goes on with a turn the restart cut off.
    sherpa.resume()
    # So does an Explore run, when only the code reloaded.
    explore.resume()
    keepers = [
        # What is left of every GitHub quota, for the Explore page's bars from the start.
        asyncio.create_task(asyncio.to_thread(BALANCER.prime)),
        asyncio.create_task(issues_api.keep_facts()),
        asyncio.create_task(issues_api.keep_tags()),
        asyncio.create_task(repos_api.keep_signals()),
        asyncio.create_task(tracked_api.keep_tracked()),
        asyncio.create_task(prs_api.keep_prs()),
    ]
    yield
    explore.save_for_restart()
    for keeper in keepers:
        keeper.cancel()
    await agents.stop()


app = FastAPI(lifespan=lifespan)
app.include_router(inbox_api.router)
app.include_router(prs_api.router)
app.include_router(github_account_api.router)
app.include_router(issues_api.router)
app.include_router(repos_api.router)
app.include_router(explore_api.router)
app.include_router(tracked_api.router)
app.include_router(agents_api.router)
app.include_router(vms_api.router)
app.include_router(images_api.router)
app.include_router(sherpa_api.router)
app.include_router(artifacts_api.router)
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
    # Whether this browser counts as one of resource_usage.watchers now: counted out again however the feed ends.
    watch = {"resource": False}
    try:
        await feed(websocket, watch)
    finally:
        if watch["resource"]:
            resource_usage.watchers -= 1


async def feed(websocket: WebSocket, watch: dict) -> None:
    """The live feed of one browser, until it goes away."""
    # The version of each topic this browser has; None until it is sent.
    sent = {"repos": None, "issues": None, "tracked": None, "explore": None, "github": None, "jobs": None, "inbox": None, "prs": None, "agents": None, "vms": None, "images": None, "resource": None}
    while True:
        # The version is noted before the data is read: a change in between is sent again next tick, never lost.
        messages = []
        # Repos carry their signals and score (repo_signals.py) and how often they were rejected before.
        if sent["repos"] != (repos.version, repo_signals.version, rejections.version):
            sent["repos"] = (repos.version, repo_signals.version, rejections.version)
            signals = repo_signals.all()
            rejected = rejections.all()
            items = repos.items()
            for item in items:
                item["signals"] = signals.get(item["full_name"])
                item["score"] = repo_signals.score(item["signals"], item.get("fit"))
                item["rejected_before"] = len(rejected.get(item["full_name"], {}).get("history", []))
            data = {"items": items, "can_undo": repos.can_undo(), "can_redo": repos.can_redo()}
            messages.append({"topic": "repos", "data": data})
        # Issues carry their facts (issue_facts.py) and tags (issue_tags.py), so the topic changes when any does.
        if sent["issues"] != (issues.version, issue_facts.version, issue_tags.version):
            sent["issues"] = (issues.version, issue_facts.version, issue_tags.version)
            facts = issue_facts.all()
            tags = issue_tags.all()
            items = issues.items()
            for item in items:
                item["facts"] = facts.get(item["id"])
                item["tags"] = tags.get(item["id"])
            data = {"items": items, "can_undo": issues.can_undo(), "can_redo": issues.can_redo()}
            messages.append({"topic": "issues", "data": data})
        # Each tracked repo carries its latest check (tracked_issues.py), like issues carry their facts, each issue
        # in it its tags (issue_tags.py), and the repo its signals (repo_signals.py), like on the Repos page.
        if sent["tracked"] != (tracked.version, tracked_issues.version, issue_tags.version, repo_signals.version):
            sent["tracked"] = (tracked.version, tracked_issues.version, issue_tags.version, repo_signals.version)
            checks = tracked_issues.all()
            tags = issue_tags.all()
            signals = repo_signals.all()
            items = tracked.items()
            for item in items:
                item["signals"] = signals.get(item["full_name"])
                item["check"] = checks.get(item["full_name"])
                if item["check"] is None:
                    continue
                for issue in item["check"]["issues"]:
                    issue["tags"] = tags.get(f"{item['full_name']}#{issue['number']}")
            data = {"items": items, "can_undo": tracked.can_undo(), "can_redo": tracked.can_redo()}
            messages.append({"topic": "tracked", "data": data})
        # The run in progress (or the last one), the profile, and the rejected repos.
        if sent["explore"] != (explore.version, rejections.version):
            sent["explore"] = (explore.version, rejections.version)
            data = explore.summary()
            data["rejections"] = [{"name": name, **record} for name, record in rejections.all().items()]
            messages.append({"topic": "explore", "data": data})
        # GitHub's rate limits per token (token_balancer.py): changes with every GitHub request, sent at most every tick.
        if sent["github"] != BALANCER.version:
            sent["github"] = BALANCER.version
            messages.append({"topic": "github", "data": BALANCER.status()})
        if sent["jobs"] != jobs.version:
            sent["jobs"] = jobs.version
            messages.append({"topic": "jobs", "data": jobs.list()})
        if sent["inbox"] != inbox.version:
            sent["inbox"] = inbox.version
            messages.append({"topic": "inbox", "data": inbox.list()})
        # Your PRs on GitHub and how each stands (pr_tracking.py).
        if sent["prs"] != pr_tracking.version:
            sent["prs"] = pr_tracking.version
            messages.append({"topic": "prs", "data": pr_tracking.summary()})
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
        # This computer's use (resource_usage.py): a new reading about once a second.
        if sent["resource"] != resource_usage.version:
            sent["resource"] = resource_usage.version
            messages.append({"topic": "resource", "data": resource_usage.summary()})

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
        # The only thing a browser sends: whether it shows a Resource page now.
        if received.get("text") is None:
            continue
        message = json.loads(received["text"])
        if message.get("watch_resource") is True and not watch["resource"]:
            watch["resource"] = True
            resource_usage.watchers += 1
        if message.get("watch_resource") is False and watch["resource"]:
            watch["resource"] = False
            resource_usage.watchers -= 1
