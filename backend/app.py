import asyncio
import base64
import json
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from claude_agent_sdk import get_session_info

from github_searcher.agent.agent import SearchChatAgent
from github_searcher.search import get_branches, get_commits, get_contents, get_contents_html, get_repository, search_repositories
from sandbox.agent.agent import Agent
from sandbox.files import Files, FilesError
from sandbox.session import SessionBusyError, SessionError
from sandbox.vm import VMError
from sandbox.sessions import Sessions

SESSIONS_FILE = Path(__file__).parent.parent / ".chat_sessions.json"

agent = SearchChatAgent()
agent_ready = None
vm_sessions = Sessions()
# The running chat agent of each VM session (by session id), made on the first message.
vm_agents: dict[str, Agent] = {}
# Sessions whose agent is answering right now.
vm_agents_busy: set[str] = set()
old_agent_stop = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global agent_ready
    agent_ready = asyncio.create_task(agent.start())
    yield
    await agent.stop()
    for vm_agent in list(vm_agents.values()):
        await vm_agent.stop()


app = FastAPI(lifespan=lifespan)


class ChatRequest(BaseModel):
    message: str
    mode: str
    entries: list[dict]


@app.post("/api/chat")
async def chat(body: ChatRequest) -> dict:
    current = agent
    ready = agent_ready
    current.history.append({"role": "user", "text": body.message})
    await ready
    current.entries = body.entries
    reply = await current.run(body.message, body.mode)

    sessions = json.loads(SESSIONS_FILE.read_text()) if SESSIONS_FILE.exists() else {}
    sessions[current.session_id] = {"history": current.history, "repos": current.repos, "updated": time.time()}
    SESSIONS_FILE.write_text(json.dumps(sessions))
    return {"message": reply, "history": current.history, "entries": current.entries, "repos": current.repos, "query": current.query, "result": current.result}


@app.get("/api/filters")
def filters() -> dict:
    return {"entries": agent.entries, "repos": agent.repos, "history": agent.history}


@app.get("/api/chat/history")
def history() -> dict:
    return {"messages": agent.history, "repos": agent.repos}


@app.get("/api/chat/sessions")
def list_sessions() -> list:
    sessions = json.loads(SESSIONS_FILE.read_text()) if SESSIONS_FILE.exists() else {}
    items = []
    for session_id, session in sessions.items():
        info = get_session_info(session_id)
        name = ""
        if info and info.custom_title:
            name = info.custom_title
        else:
            for message in session["history"]:
                if message["role"] == "user":
                    name = message["text"].strip().split("\n")[0][:40]
                    break
        items.append({"session_id": session_id, "name": name or "Untitled", "updated": session["updated"]})
    items.sort(key=lambda item: item["updated"], reverse=True)
    return items


class OpenSessionRequest(BaseModel):
    session_id: str


@app.post("/api/chat/open")
async def open_session(body: OpenSessionRequest) -> dict:
    global agent, agent_ready, old_agent_stop
    sessions = json.loads(SESSIONS_FILE.read_text()) if SESSIONS_FILE.exists() else {}
    history = sessions[body.session_id]["history"]
    repos = sessions[body.session_id].get("repos", [])
    old_agent = agent
    agent = SearchChatAgent(body.session_id, history, repos)
    agent_ready = asyncio.create_task(agent.start())
    old_agent_stop = asyncio.create_task(old_agent.stop())
    return {"messages": history, "repos": repos}


@app.post("/api/chat/new")
async def new_session() -> dict:
    global agent, agent_ready, old_agent_stop
    old_agent = agent
    agent = SearchChatAgent()
    agent_ready = asyncio.create_task(agent.start())
    old_agent_stop = asyncio.create_task(old_agent.stop())
    return {}


@app.post("/api/chat/interrupt")
def interrupt() -> dict:
    agent.interrupt = True
    return {}


@app.get("/api/search")
def search(q: str, sort: str | None = None, order: str = "desc", page: int = 1) -> dict:
    return search_repositories(q, sort, order, 100, page)


@app.get("/api/repo/{owner}/{name}")
def repo(owner: str, name: str) -> dict:
    return {"repo": get_repository(owner, name)}


@app.get("/api/repo/{owner}/{name}/contents")
def contents(owner: str, name: str, path: str = "", ref: str = "") -> dict:
    data = get_contents(owner, name, path, ref)

    if isinstance(data, list):
        entries = [{"name": item["name"], "path": item["path"], "type": item["type"], "size": item["size"], "html_url": item["html_url"]} for item in data]
        entries.sort(key=lambda entry: (entry["type"] != "dir", entry["name"].lower()))
        readmes = [entry for entry in entries if entry["type"] == "file" and entry["name"].lower().startswith("readme")]
        readme_html = get_contents_html(owner, name, readmes[0]["path"], ref) if readmes else None
        return {"type": "dir", "path": path, "entries": entries, "readme_html": readme_html}

    text = None
    if data.get("encoding") == "base64":
        try:
            text = base64.b64decode(data["content"]).decode("utf-8")
        except UnicodeDecodeError:
            text = None
    html = None
    if text is not None and data["name"].lower().endswith((".md", ".markdown")):
        html = get_contents_html(owner, name, path, ref)
    return {
        "type": "file",
        "path": path,
        "name": data["name"],
        "size": data["size"],
        "download_url": data["download_url"],
        "html_url": data["html_url"],
        "text": text,
        "html": html,
    }


@app.get("/api/repo/{owner}/{name}/branches")
def branches(owner: str, name: str) -> dict:
    return {"branches": [branch["name"] for branch in get_branches(owner, name)]}


@app.get("/api/repo/{owner}/{name}/commits")
def commits(owner: str, name: str, ref: str = "", path: str = "") -> dict:
    result = []
    for item in get_commits(owner, name, ref, path):
        author = item["author"] or {}
        result.append(
            {
                "sha": item["sha"],
                "message": item["commit"]["message"],
                "author": author.get("login") or item["commit"]["author"]["name"],
                "avatar_url": author.get("avatar_url"),
                "date": item["commit"]["author"]["date"],
                "html_url": item["html_url"],
            }
        )
    return {"commits": result}


class CreateVmSessionRequest(BaseModel):
    repo: str = ""  # "owner/name" or a GitHub URL; empty for no repo.
    name: str = ""  # Only for showing; empty uses the VM's name.
    cpus: int
    memory_gb: int
    disk_gb: int


@app.get("/api/vm/options")
def vm_options() -> dict:
    """CPU, memory and disk choices for the create dialog (from .env)."""
    return vm_sessions.options()


@app.get("/api/vm/sessions")
def list_vm_sessions() -> list[dict]:
    """Every session with its live state: VM on or off, CPU % and memory in use.

    Answers right away: the live state is what each session's watcher read last.
    """
    result = []
    for session in vm_sessions.list():
        result.append({**session.to_dict(), **session.latest_usage, "locked_by": session.locked_by})
    return result


@app.post("/api/vm/sessions")
def create_vm_session(body: CreateVmSessionRequest) -> dict:
    """Starts creating the session and returns right away; the list shows its progress."""
    repo = body.repo.strip().removeprefix("https://").removeprefix("http://").removeprefix("github.com/")
    repo = repo.removesuffix("/").removesuffix(".git")
    if repo and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise HTTPException(status_code=400, detail="The repo must be a GitHub URL or owner/name.")
    try:
        session = vm_sessions.create(
            repo,
            name=body.name.strip(),
            cpus=body.cpus,
            memory_gb=body.memory_gb,
            disk_gb=body.disk_gb,
            background=True,
        )
    except SessionError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return session.to_dict()


@app.get("/api/vm/sessions/{session_id}/viewer")
def vm_session_viewer(session_id: str) -> dict:
    """Where the browser finds the session's desktop (noVNC) and terminals (ttyd).

    The browser loads them straight from the VM's address on the Incus bridge,
    which only this machine can reach. A terminal is "<terminal>?arg=<n>".
    """
    try:
        session = vm_sessions.get(session_id)
    except SessionError as error:
        raise HTTPException(status_code=404, detail=str(error))
    if session.vm.status() != "Running":
        raise HTTPException(status_code=409, detail="The VM is off.")
    address = session.vm.address()
    if address is None:
        raise HTTPException(status_code=409, detail="The VM has no address yet.")
    novnc_port = os.environ["SANDBOX_VM_NOVNC_PORT"]
    terminal_port = os.environ["SANDBOX_VM_TERMINAL_PORT"]
    return {
        # bell=off: no ding in the browser each time the desktop beeps (e.g. while the agent types).
        "desktop": f"http://{address}:{novnc_port}/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000&bell=off",
        "terminal": f"http://{address}:{terminal_port}/",
    }


@app.get("/api/vm/sessions/{session_id}/terminals")
def list_vm_terminals(session_id: str) -> list[str]:
    """The terminals still running in the VM (their tmux session names: 1, 2, ...)."""
    try:
        session = vm_sessions.get(session_id)
    except SessionError as error:
        raise HTTPException(status_code=404, detail=str(error))
    # Fails when no tmux is running at all: that just means no terminals.
    result = session.vm.exec("tmux list-sessions -F '#S'", timeout=10)
    names = []
    for name in result.stdout.split():
        if name.isdigit():
            names.append(name)
    names.sort(key=int)
    return names


@app.delete("/api/vm/sessions/{session_id}/terminals/{name}")
def close_vm_terminal(session_id: str, name: str) -> dict:
    """Stop a terminal: ends its tmux session and everything running in it."""
    if not name.isdigit():
        raise HTTPException(status_code=400, detail="Terminal names are numbers.")
    try:
        session = vm_sessions.get(session_id)
    except SessionError as error:
        raise HTTPException(status_code=404, detail=str(error))
    session.vm.exec(f"tmux kill-session -t {name}", timeout=10)
    return {}


class ToggleRequest(BaseModel):
    enabled: bool


class EnvRequest(BaseModel):
    env: dict[str, str]


class ResourcesRequest(BaseModel):
    cpus: int
    memory_gb: int


def find_vm_session(session_id: str):
    try:
        return vm_sessions.get(session_id)
    except SessionError as error:
        raise HTTPException(status_code=404, detail=str(error))


@app.put("/api/vm/sessions/{session_id}/lock")
def set_vm_lock(session_id: str, body: ToggleRequest) -> dict:
    """The user locks or unlocks their mouse and keyboard. Unlocking also ends a lock the agent set."""
    session = find_vm_session(session_id)
    session.locked_by = "user" if body.enabled else None
    return {"locked_by": session.locked_by}


@app.post("/api/vm/sessions/{session_id}/start")
def start_vm_session(session_id: str) -> dict:
    find_vm_session(session_id)
    try:
        vm_sessions.start_in_background(session_id)
    except SessionError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@app.post("/api/vm/sessions/{session_id}/stop")
def stop_vm_session(session_id: str) -> dict:
    find_vm_session(session_id)
    try:
        vm_sessions.stop_in_background(session_id)
    except SessionError as error:
        raise HTTPException(status_code=409, detail=str(error))
    return {}


@app.put("/api/vm/sessions/{session_id}/internet")
def set_vm_internet(session_id: str, body: ToggleRequest) -> dict:
    session = find_vm_session(session_id)
    try:
        session.set_internet(body.enabled)
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return session.to_dict()


@app.put("/api/vm/sessions/{session_id}/env")
def set_vm_env(session_id: str, body: EnvRequest) -> dict:
    session = find_vm_session(session_id)
    try:
        session.set_env(body.env)
    except SessionError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return session.to_dict()


# --- Directory tab: the VM's files, as its desktop user ------------------------


class SaveFileRequest(BaseModel):
    path: str
    text: str


class UploadFileRequest(BaseModel):
    folder: str
    name: str
    data: str  # The file's content, base64.


@app.get("/api/vm/sessions/{session_id}/files")
def list_vm_files(session_id: str, path: str = "") -> dict:
    """A folder's entries. No path: the home folder."""
    files = Files(find_vm_session(session_id).vm)
    home = files.home()
    if not path:
        path = home
    path = files.clean_path(path)
    return {"path": path, "home": home, "entries": files.list(path)}


@app.get("/api/vm/sessions/{session_id}/files/content")
def read_vm_file(session_id: str, path: str) -> dict:
    return Files(find_vm_session(session_id).vm).read(path)


@app.get("/api/vm/sessions/{session_id}/files/download")
def download_vm_file(session_id: str, path: str) -> Response:
    content = Files(find_vm_session(session_id).vm).read_bytes(path)
    name = path.rstrip("/").split("/")[-1].replace('"', "")
    return Response(content, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.put("/api/vm/sessions/{session_id}/files/content")
def save_vm_file(session_id: str, body: SaveFileRequest) -> dict:
    Files(find_vm_session(session_id).vm).write(body.path, body.text.encode())
    return {}


@app.post("/api/vm/sessions/{session_id}/files/upload")
def upload_vm_file(session_id: str, body: UploadFileRequest) -> dict:
    if "/" in body.name or body.name in ("", ".", ".."):
        raise HTTPException(status_code=400, detail=f"Not a file name: {body.name}")
    Files(find_vm_session(session_id).vm).write(body.folder.rstrip("/") + "/" + body.name, base64.b64decode(body.data))
    return {}


@app.delete("/api/vm/sessions/{session_id}/files")
def delete_vm_file(session_id: str, path: str) -> dict:
    Files(find_vm_session(session_id).vm).delete(path)
    return {}


@app.exception_handler(FilesError)
def files_error(request: Request, error: FilesError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(error)})


@app.put("/api/vm/sessions/{session_id}/autostart")
def set_vm_autostart(session_id: str, body: ToggleRequest) -> dict:
    session = find_vm_session(session_id)
    try:
        session.set_autostart(body.enabled)
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return session.to_dict()


@app.put("/api/vm/sessions/{session_id}/resources")
def set_vm_resources(session_id: str, body: ResourcesRequest) -> dict:
    session = find_vm_session(session_id)
    try:
        vm_sessions.set_resources(session_id, body.cpus, body.memory_gb)
    except SessionError as error:
        raise HTTPException(status_code=409, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return session.to_dict()


class VmChatRequest(BaseModel):
    message: str


@app.get("/api/vm/sessions/{session_id}/agent")
def vm_agent_history(session_id: str) -> dict:
    """The chat with the session's agent. While it answers, this includes what it did so far."""
    session = find_vm_session(session_id)
    vm_agent = vm_agents.get(session_id)
    # Context: how full the agent's context window is, None until it has started.
    if vm_agent is not None:
        history = vm_agent.history
        context = {"used": vm_agent.context_used, "max": vm_agent.context_max}
    else:
        history = session.chat_agent().get("history", [])
        context = None
    return {"history": history, "busy": session_id in vm_agents_busy, "context": context}


@app.post("/api/vm/sessions/{session_id}/agent/chat")
async def vm_agent_chat(session_id: str, body: VmChatRequest) -> dict:
    """Send one message to the session's agent and wait for its answer."""
    session = find_vm_session(session_id)
    if session_id in vm_agents_busy:
        raise HTTPException(status_code=409, detail="The agent is still answering.")
    vm_agents_busy.add(session_id)
    try:
        record = session.chat_agent()
        vm_agent = vm_agents.get(session_id)
        if vm_agent is None:
            # Continue the saved conversation, if there is one.
            vm_agent = Agent(record["claude_session_id"], record.get("history", []), session=session)
            await vm_agent.start()
            vm_agents[session_id] = vm_agent
        reply = await vm_agent.run(body.message)
        record["history"] = vm_agent.history
        record["claude_session_id"] = vm_agent.session_id
        session.save_agent(record)
        context = {"used": vm_agent.context_used, "max": vm_agent.context_max}
        return {"message": reply, "history": vm_agent.history, "context": context}
    finally:
        vm_agents_busy.discard(session_id)


@app.post("/api/vm/sessions/{session_id}/agent/interrupt")
def vm_agent_interrupt(session_id: str) -> dict:
    vm_agent = vm_agents.get(session_id)
    if vm_agent is not None:
        vm_agent.interrupt = True
    return {}


@app.delete("/api/vm/sessions/{session_id}")
async def delete_vm_session(session_id: str) -> dict:
    """Stops the session's agent, deletes the VM, then the session's folder. Takes a few seconds."""
    vm_agent = vm_agents.pop(session_id, None)
    if vm_agent is not None:
        await vm_agent.stop()
    try:
        await asyncio.to_thread(vm_sessions.delete, session_id)
    except SessionBusyError as error:
        raise HTTPException(status_code=409, detail=f"{error}: wait until it finishes, then delete it.")
    except SessionError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except VMError as error:
        raise HTTPException(status_code=500, detail=str(error))
    return {}


@app.exception_handler(httpx.HTTPStatusError)
def github_error(request: Request, error: httpx.HTTPStatusError) -> JSONResponse:
    message = error.response.json().get("message", "GitHub request failed.")
    return JSONResponse(status_code=error.response.status_code, content={"detail": message})


def main() -> None:
    uvicorn.run("backend.app:app", host="127.0.0.1", port=int(os.getenv("BACKEND_PORT", "8000")), reload=True)
