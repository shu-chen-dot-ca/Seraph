import asyncio
import base64
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from claude_agent_sdk import get_session_info

from github_searcher.agent.agent import SearchChatAgent
from github_searcher.search import get_branches, get_commits, get_contents, get_contents_html, get_repository, search_repositories

SESSIONS_FILE = Path(__file__).parent.parent / ".chat_sessions.json"

agent = SearchChatAgent()
agent_ready = None
old_agent_stop = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global agent_ready
    agent_ready = asyncio.create_task(agent.start())
    yield
    await agent.stop()


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


@app.exception_handler(httpx.HTTPStatusError)
def github_error(request: Request, error: httpx.HTTPStatusError) -> JSONResponse:
    message = error.response.json().get("message", "GitHub request failed.")
    return JSONResponse(status_code=error.response.status_code, content={"detail": message})


def main() -> None:
    uvicorn.run("backend.app:app", host="127.0.0.1", port=int(os.getenv("BACKEND_PORT", "8000")), reload=True)
