"""The backend: one FastAPI app that serves everything under /api.

The pieces are made once in backend/shared.py (the Repos, Issues and Tracked lists,
jobs, the inbox, your GitHub account, your PRs, the VMs, the VM queue and the agents), and each page has its
own router in backend/*_api.py (the GitHub tab: github_api.py, its Account page: github_account_api.py, Your
repositories: your_repositories_api.py, Notifications: notifications_api.py, the Workspace tab's Pull requests:
pull_requests_api.py, a repository's Live tab on the Workspace tab: repo_live_api.py, Sherpa: sherpa_api.py, Settings →
Asking: ask_settings_api.py).
topic_data() is each topic of the live feed below; Sherpa reads the pages' data through it too.

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

The one exception is remote access (github_searcher/remote_access.py), once REMOTE_ACCESS_DOMAIN is set: pages at
that domain may use the API too, but only signed in with a passkey. A request through the domain without a session
gets 401 {"detail", "sign_in": true} (except the sign-in pages, remote_access_api.OPEN_PATHS), and the live
websocket closes with 4401, also as soon as the device is removed or signed out. The page then opens the Sign in page.

The page itself comes from Vite in the dev copy (./run.sh). The live copy (deploy/, SERAPH_HOME set) serves its own
built page (frontend/dist) from here, at /, so it needs no Vite.

Every exception nobody caught (in a request, a background task on the event loop, or a thread) is reported to the app's
own errors (github_searcher/crashes.py), which its agent turns into issues (backend/projects_api.py).

SERAPH_CHECK=1 in .env is the check a new release gets before it goes live (github_searcher/updates.py): it runs on a
copy of data/, and nothing in the background starts (no agents, no keepers), so it never acts on anything; it only
answers, and its live feed sends every topic once.
"""

import asyncio
import json
import os
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from backend import agents_api, artifacts_api, ask_settings_api, repo_automation_api, explore_api, github_account_api, images_api, inbox_api, issues_api, github_api, notifications_api, problems_api, projects_api, pull_requests_api, remote_access_api, repo_live_api, repos_api, sherpa_api, tracked_api, updates_api, vms_api, workflow_api, your_repositories_api
from backend.shared import agents, crashes, explore, images, inbox, issue_drafts, issue_facts, issue_tags, issues, jobs, notifications, pr_tracking, problems, projects, remote_access, repo_signals, repos, resource_usage, sherpa, tracked, tracked_issues, updates, vms, workflow, your_repositories
from github_searcher.projects import SELF_REPO
from github_searcher.remote_access import COOKIE, DOMAIN as REMOTE_DOMAIN
from github_searcher.token_balancer import BALANCER
from github_searcher.updates import HOME

# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

LOCAL_HOSTS = ["localhost", "127.0.0.1"]
# The hosts the API answers: this computer, and the remote access domain once it is set up.
ALLOWED_HOSTS = LOCAL_HOSTS + ([REMOTE_DOMAIN] if REMOTE_DOMAIN != "" else [])
THREADS = 64
# A new release's check before it goes live (module docstring).
CHECK = os.environ.get("SERAPH_CHECK", "") == "1"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The threads asyncio.to_thread uses (the agents' VM tools, Explore, the signals, every GitHub call). A GitHub call
    # can wait up to two minutes for a rate limit (token_balancer.py); with only the default 20 threads, a burst of
    # those took them all and everything else stalled behind them.
    loop = asyncio.get_running_loop()
    loop.set_default_executor(ThreadPoolExecutor(max_workers=THREADS))

    # What fails in a background task or a thread is one of the app's errors too, as well as in the log as before.
    def loop_error(loop, context: dict) -> None:
        error = context.get("exception")
        detail = ""
        if error is not None:
            detail = "".join(traceback.format_exception(error))
        crashes.add("backend", context.get("message", "") + (f": {type(error).__name__}: {error}" if error is not None else ""), detail)
        loop.default_exception_handler(context)

    loop.set_exception_handler(loop_error)
    thread_hook = threading.excepthook

    def thread_error(args) -> None:
        detail = "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback))
        crashes.add("backend", f"A thread failed: {args.exc_type.__name__}: {args.exc_value}", detail)
        thread_hook(args)

    threading.excepthook = thread_error

    if CHECK:
        yield
        return
    # Agents run on this event loop, so they start here and not at import.
    await agents.start()
    # An Explore run the restart cut off goes on, when only the code reloaded.
    explore.resume()
    keepers = [
        # What is left of every GitHub quota, for the Explore page's bars from the start.
        asyncio.create_task(asyncio.to_thread(BALANCER.prime)),
        asyncio.create_task(issues_api.keep_facts()),
        asyncio.create_task(issues_api.keep_tags()),
        asyncio.create_task(issues_api.keep_new_tags()),
        asyncio.create_task(repo_automation_api.keep_adding()),
        asyncio.create_task(repo_automation_api.keep_catalog()),
        asyncio.create_task(repo_automation_api.keep_drafts()),
        asyncio.create_task(issues_api.keep_catalog_agents()),
        asyncio.create_task(issues_api.keep_stale_prs()),
        asyncio.create_task(repos_api.keep_signals()),
        asyncio.create_task(tracked_api.keep_tracked()),
        asyncio.create_task(github_api.keep_prs()),
        asyncio.create_task(github_api.keep_branches_clean()),
        asyncio.create_task(your_repositories_api.keep_your_repositories()),
        asyncio.create_task(notifications_api.keep_notifications()),
        asyncio.create_task(updates_api.keep_updates()),
        asyncio.create_task(projects_api.keep_projects()),
        asyncio.create_task(workflow_api.keep_workflow()),
    ]
    yield
    explore.save_for_restart()
    for keeper in keepers:
        keeper.cancel()
    await agents.stop()


app = FastAPI(lifespan=lifespan)
# Every page's router; Sherpa gets their endpoints too (below).
ROUTERS = [inbox_api.router, ask_settings_api.router, repo_automation_api.router, github_api.router, github_account_api.router, your_repositories_api.router, notifications_api.router, pull_requests_api.router, issues_api.router, repos_api.router, explore_api.router, tracked_api.router, agents_api.router, vms_api.router, images_api.router, artifacts_api.router, remote_access_api.router, repo_live_api.router, updates_api.router, projects_api.router, problems_api.router, workflow_api.router, sherpa_api.router]
for router in ROUTERS:
    app.include_router(router)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


@app.middleware("http")
async def check_origin(request: Request, call_next):
    """Browsers send Origin with every POST, PUT and DELETE (also no-cors ones): only local pages (and the remote
    access domain's) may call. Through the domain, every call needs a sign in, except the sign-in pages."""
    origin = request.headers.get("origin")
    if origin is not None and urlsplit(origin).hostname not in ALLOWED_HOSTS:
        return JSONResponse(status_code=403, content={"detail": "Only pages on this machine may use the API."})
    if remote_access.from_outside(request.headers) and request.url.path not in remote_access_api.OPEN_PATHS:
        if remote_access.device_for(request.cookies.get(COOKIE)) is None:
            return JSONResponse(status_code=401, content={"detail": "Sign in first.", "sign_in": True})
    return await call_next(request)


@app.exception_handler(httpx.HTTPStatusError)
def github_error(request: Request, error: httpx.HTTPStatusError) -> JSONResponse:
    """GitHub's own message (rate limit, not found, ...) instead of a bare 500."""
    try:
        message = error.response.json().get("message", "GitHub request failed.")
    except ValueError:
        message = "GitHub request failed."
    return JSONResponse(status_code=error.response.status_code, content={"detail": message})


@app.exception_handler(Exception)
def app_error(request: Request, error: Exception) -> JSONResponse:
    """A request that failed with an exception nobody caught: one of the app's errors (crashes.py), then the usual 500."""
    detail = "".join(traceback.format_exception(error))
    crashes.add("backend", f"{request.method} {request.url.path}: {type(error).__name__}: {error}", detail)
    return JSONResponse(status_code=500, content={"detail": f"Something went wrong in the app: {type(error).__name__}: {error}"})


@app.websocket("/api/live")
async def live(websocket: WebSocket) -> None:
    """Sends every topic once, then each topic again whenever its version changes."""
    # Websockets skip the http middleware, and browsers let any page open one: checked here.
    origin = websocket.headers.get("origin")
    if origin is not None and urlsplit(origin).hostname not in ALLOWED_HOSTS:
        await websocket.close(code=1008)
        return
    # Through the remote access domain only signed in. Accepted first, so the page sees the 4401 and opens Sign in.
    if remote_access.from_outside(websocket.headers) and remote_access.device_for(websocket.cookies.get(COOKIE)) is None:
        await websocket.accept()
        await websocket.close(code=4401)
        return
    await websocket.accept()
    # Whether this browser counts as one of resource_usage.watchers now: counted out again however the feed ends.
    watch = {"resource": False}
    try:
        await feed(websocket, watch)
    finally:
        if watch["resource"]:
            resource_usage.watchers -= 1


# The live feed's topics, by name: what the pages show, the same for Sherpa's look (github_searcher/sherpa.py).
TOPICS = ["repos", "issues", "tracked", "explore", "github", "jobs", "inbox", "issue_drafts", "prs", "your_repos", "notifications", "agents", "vms", "images", "resource", "updates", "projects", "crashes", "problems", "workflow"]


def topic_data(topic: str):
    """One topic of the live feed as the pages get it."""
    # Repos carry their signals (repo_signals.py).
    if topic == "repos":
        signals = repo_signals.all()
        items = repos.items()
        for item in items:
            item["signals"] = signals.get(item["full_name"])
        return {"items": items, "can_undo": repos.can_undo(), "can_redo": repos.can_redo(), "archived": repos.archived()}
    # Issues carry their facts (issue_facts.py) and tags (issue_tags.py), so the topic changes when any does.
    if topic == "issues":
        facts = issue_facts.all()
        tags = issue_tags.all()
        items = issues.items()
        for item in items:
            item["facts"] = facts.get(item["id"])
            item["tags"] = tags.get(item["id"])
        return {"items": items, "can_undo": issues.can_undo(), "can_redo": issues.can_redo(), **issues.board()}
    # Each tracked repo carries its latest check (tracked_issues.py), like issues carry their facts, each issue
    # in it its tags (issue_tags.py), and the repo its signals (repo_signals.py), like on the Repos page.
    if topic == "tracked":
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
        return {"items": items, "can_undo": tracked.can_undo(), "can_redo": tracked.can_redo()}
    # The run in progress (or the last one), the found list and the profile.
    if topic == "explore":
        return explore.summary()
    if topic == "github":
        return BALANCER.status()
    if topic == "jobs":
        return jobs.list()
    # A project's PR draft only once its review passed (inbox.py): until then it isn't the user's to see.
    if topic == "inbox":
        return [draft for draft in inbox.list() if draft["review"] is None or draft["review"]["state"] == "passed"]
    # The issues repository agents drafted, shown as cards in their chats (issue_drafts.py).
    if topic == "issue_drafts":
        return issue_drafts.list()
    # Your PRs on GitHub and how each stands (pr_tracking.py).
    if topic == "prs":
        return pr_tracking.summary()
    # Your repositories and your GitHub notifications, read with your sign-in.
    if topic == "your_repos":
        return your_repositories.summary()
    if topic == "notifications":
        return notifications.summary()
    if topic == "agents":
        return agents.summaries()
    if topic == "vms":
        return [vms.summary(record) for record in vms.list()]
    if topic == "images":
        return images.summary()
    # This computer's use (resource_usage.py).
    if topic == "resource":
        return resource_usage.summary()
    # The live copy's updates (updates_api.py): the version that runs, and a newer one that is ready.
    if topic == "updates":
        return updates.summary()
    # Your repositories agents develop all the time (projects.py), and the app's own errors (crashes.py).
    if topic == "projects":
        items = projects.list()
        # The app's own repo: its Development page shows the app's errors too.
        for item in items:
            item["app"] = item["repo"].lower() == SELF_REPO.lower()
        return items
    if topic == "crashes":
        return crashes.list()
    # What went wrong in how the app made agents work, as they reported it (problems.py): the Dashboard's Problems.
    if topic == "problems":
        return problems.list()
    # The Workflow tab's repositories (workflow.py), their issues and pull requests.
    if topic == "workflow":
        return workflow.list()
    raise ValueError(f"No topic {topic}: one of {', '.join(TOPICS)}")


# Sherpa works the app through its endpoints and reads what its pages show (github_searcher/sherpa.py).
sherpa.routes = [route for router in ROUTERS for route in router.routes]
sherpa.topic_data = topic_data


async def feed(websocket: WebSocket, watch: dict) -> None:
    """The live feed of one browser, until it goes away."""
    # The version of each topic this browser has; None until it is sent.
    sent = {"repos": None, "issues": None, "tracked": None, "explore": None, "github": None, "jobs": None, "inbox": None, "issue_drafts": None, "prs": None, "your_repos": None, "notifications": None, "agents": None, "vms": None, "images": None, "resource": None, "updates": None, "projects": None, "crashes": None, "problems": None, "workflow": None}
    outside = remote_access.from_outside(websocket.headers)
    cookie = websocket.cookies.get(COOKIE)
    while True:
        # A device removed or signed out in the meantime (or its session over) stops getting the feed at once.
        if outside and remote_access.device_for(cookie) is None:
            await websocket.close(code=4401)
            return
        # The version is noted before the data is read: a change in between is sent again next tick, never lost.
        messages = []
        if sent["repos"] != (repos.version, repo_signals.version):
            sent["repos"] = (repos.version, repo_signals.version)
            messages.append({"topic": "repos", "data": topic_data("repos")})
        if sent["issues"] != (issues.version, issue_facts.version, issue_tags.version):
            sent["issues"] = (issues.version, issue_facts.version, issue_tags.version)
            messages.append({"topic": "issues", "data": topic_data("issues")})
        if sent["tracked"] != (tracked.version, tracked_issues.version, issue_tags.version, repo_signals.version):
            sent["tracked"] = (tracked.version, tracked_issues.version, issue_tags.version, repo_signals.version)
            messages.append({"topic": "tracked", "data": topic_data("tracked")})
        if sent["explore"] != explore.version:
            sent["explore"] = explore.version
            messages.append({"topic": "explore", "data": topic_data("explore")})
        # GitHub's rate limits per token (token_balancer.py): changes with every GitHub request, sent at most every tick.
        if sent["github"] != BALANCER.version:
            sent["github"] = BALANCER.version
            messages.append({"topic": "github", "data": topic_data("github")})
        if sent["jobs"] != jobs.version:
            sent["jobs"] = jobs.version
            messages.append({"topic": "jobs", "data": topic_data("jobs")})
        if sent["inbox"] != inbox.version:
            sent["inbox"] = inbox.version
            messages.append({"topic": "inbox", "data": topic_data("inbox")})
        if sent["issue_drafts"] != issue_drafts.version:
            sent["issue_drafts"] = issue_drafts.version
            messages.append({"topic": "issue_drafts", "data": topic_data("issue_drafts")})
        if sent["prs"] != pr_tracking.version:
            sent["prs"] = pr_tracking.version
            messages.append({"topic": "prs", "data": topic_data("prs")})
        if sent["your_repos"] != your_repositories.version:
            sent["your_repos"] = your_repositories.version
            messages.append({"topic": "your_repos", "data": topic_data("your_repos")})
        if sent["notifications"] != notifications.version:
            sent["notifications"] = notifications.version
            messages.append({"topic": "notifications", "data": topic_data("notifications")})
        if sent["agents"] != agents.version:
            sent["agents"] = agents.version
            messages.append({"topic": "agents", "data": topic_data("agents")})
        if sent["vms"] != vms.version:
            sent["vms"] = vms.version
            messages.append({"topic": "vms", "data": topic_data("vms")})
        # Images say which VMs were made from each, so they are sent again when the VM list changes too.
        # Not on every usage sample though: only the number of VMs and their images matter.
        vm_images = [(record.name, record.image_fingerprint) for record in vms.list()]
        if sent["images"] != (images.version, vm_images):
            sent["images"] = (images.version, vm_images)
            messages.append({"topic": "images", "data": topic_data("images")})
        # This computer's use (resource_usage.py): a new reading about once a second.
        if sent["resource"] != resource_usage.version:
            sent["resource"] = resource_usage.version
            messages.append({"topic": "resource", "data": topic_data("resource")})
        if sent["updates"] != updates.version:
            sent["updates"] = updates.version
            messages.append({"topic": "updates", "data": topic_data("updates")})
        if sent["projects"] != projects.version:
            sent["projects"] = projects.version
            messages.append({"topic": "projects", "data": topic_data("projects")})
        if sent["crashes"] != crashes.version:
            sent["crashes"] = crashes.version
            messages.append({"topic": "crashes", "data": topic_data("crashes")})
        if sent["problems"] != problems.version:
            sent["problems"] = problems.version
            messages.append({"topic": "problems", "data": topic_data("problems")})
        if sent["workflow"] != workflow.version:
            sent["workflow"] = workflow.version
            messages.append({"topic": "workflow", "data": topic_data("workflow")})

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


class Page(StaticFiles):
    """The live copy's built page. index.html is asked for again on every load (no-cache), so the reload after an
    update gets the new one; the files in assets/ have a hash of their content in their names."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if not path.startswith("assets/"):
            response.headers["Cache-Control"] = "no-cache"
        return response


# Last, so every /api route comes first.
if HOME != "":
    app.mount("/", Page(directory=Path(__file__).resolve().parent.parent / "frontend" / "dist", html=True), name="page")
