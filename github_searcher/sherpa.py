"""Sherpa: the round button at the bottom right of every page (frontend/src/Sherpa.tsx), a chat with a helper that does
things in the app for the user, the way they would with the buttons, many at once: "remove every issue opened more
than 30 days ago" is one message instead of thirty clicks.

What it sees: look reads what a page shows, one topic of the live feed at a time (backend/app.py topic_data: the
Repos, Issues and Tracked lists with their tags, facts and signals, jobs, the Inbox, agents, VMs, your PRs...), with
only the fields it asks for, so a long list stays small. Each message comes with the page the user is on and the time.
What it does: call uses the app's own API on this computer, exactly what the buttons use: every endpoint, listed in its
prompt with what it does (from backend/app.py's routes), except DENIED: nothing that goes to GitHub as the user
(Approve, Send, comments, PR and repo actions, creating issues, marking notifications, projects), the GitHub sign-in,
remote access, updates and the environment variables (secrets). The user approves everything that leaves for GitHub
in the Inbox, never Sherpa. Lists it changes keep their undo, like the user's own clicks. Claude Code's own tools
(files, shell, web) are off.

One chat, kept in DATA_DIR/sherpa.json: {"session_id", "history": [entry, ...], "cost_usd"}, entries
{"type": "user" | "text" | "tool" | "error" | "turn_end", "text", "time"}. New chat starts it over. Each turn connects
to Claude Code, resumes the chat's conversation by its session id, and disconnects at the end. A message sent while it
works waits for that turn to end (queued). A backend restart (the code changed) cuts a turn off: the chat says so.

    sherpa = Sherpa()
    sherpa.send("remove every issue opened more than 30 days ago", "#/issues")
"""

import asyncio
import inspect
import json
import os
import re
import typing
from datetime import UTC, datetime
from pathlib import Path

import httpx
from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, SystemMessage, TextBlock, ToolUseBlock, create_sdk_mcp_server, tool
from dotenv import load_dotenv
from fastapi.routing import APIRoute
from pydantic import BaseModel

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Claude Code runs here. With no file tools this only decides where it keeps the conversation.
AGENT_HOME = DATA_DIR / "sherpa_home"
CHAT_FILE = DATA_DIR / "sherpa.json"
TOOL_SERVER = "sherpa"
# What Sherpa may never call (method, or "*" for any; a pattern for the whole path): see the module docstring.
DENIED = [
    ("POST", r"/api/inbox/[^/]+/(approve|send)"),
    ("*", r"/api/github/(comment|comments/.*|prs/.*)"),
    ("*", r"/api/your_repositories/act"),
    ("*", r"/api/issue_drafts/[^/]+/create"),
    ("POST", r"/api/notifications/.+"),
    ("POST", r"/api/projects/.*"),
    ("PUT", r"/api/projects/.*"),
    ("*", r"/api/github_account.*"),
    ("*", r"/api/remote_access.*"),
    ("*", r"/api/updates.*"),
    ("*", r".*env.*"),
    ("*", r"/api/errors"),
    ("*", r"/api/sherpa.*"),
]
# How much of a call's or a look's answer Sherpa gets; it asks for fewer fields when it is more.
CALL_CHARS = 20_000
LOOK_CHARS = 60_000
CUT_OFF = "Cut off: the app restarted in the middle of this turn (its code changed, or it was restarted)."

PROMPT = """You are Sherpa, the helper inside Seraph, an app on the user's own computer that finds open-source work and
does it with AI agents in VMs. The user opens you from the round button at the bottom right of every page to get things
done in the app for them, especially many at once ("remove every issue opened more than 30 days ago", "move the easy
ones' repos to Tracked", "cancel the jobs that wait on vm3").

You work the app the way its buttons do:
- look(topic, fields) reads what a page shows: one topic of the app's live data (repos, issues, tracked, jobs, inbox,
  agents, vms, prs, ...). Lists are long: ask only for the fields you need, as dotted paths into each item
  (e.g. ["id", "title", "facts.created_at", "tags.merge"]). Leave fields out to see one item whole first, so you know
  what fields there are.
- call(method, path, body) uses the app's API, exactly what a button does. The endpoints are listed below, each with what
  it does and what it takes. Read lists with look, not GET calls, unless an endpoint gives something look doesn't.

Rules:
- Do what the user asked, all of it, without clicking one at a time: when an endpoint takes many ids (like
  /api/issues/remove), send them in one call. Then say in one or two lines what you did (how many, which) and how to
  take it back when there is a way (the lists' undo: /api/issues/undo and the like, or the page's back arrow).
- Work out which items match from the data, carefully: dates are ISO times (UTC); the message says what time it is
  now. When a request is unclear (which list? opened, or added?), take the plain reading and say which you took, or ask
  in one short line when the readings differ a lot.
- Before something that can't be undone (deleting a VM, an image, an agent or its files, cancelling jobs, rejecting
  drafts), say exactly what you will do and wait for the user's yes in the chat. Lists with undo don't need that.
- You can't send anything to GitHub as the user: Approve, Send, comments, PR actions and the like are refused, and so
  are sign-in, remote access, updates and the environment variables. When the user asks for one, say it is theirs to do
  and where (e.g. the Inbox's Approve).
- Point the user to a page with its address as a link, like [Issues](#/issues).
- No emoji. Keep it short and plain: the user reads you in a small panel.

What each part of the app's API is about:

"""


class Sherpa:
    def __init__(self):
        # Set by backend/app.py once the app is made: its routes (the endpoints, for the prompt) and topic_data (look).
        self.routes = []
        self.topic_data = None
        self.running = None
        self.queue = []
        self.chat = {"session_id": None, "history": [], "cost_usd": 0.0}
        if CHAT_FILE.is_file():
            self.chat = json.loads(CHAT_FILE.read_text())
        # A turn the last backend never finished: cut off by a restart.
        history = self.chat["history"]
        if history and history[-1]["type"] != "turn_end":
            history.append({"type": "error", "text": CUT_OFF, "time": datetime.now(UTC).isoformat()})
            history.append({"type": "turn_end", "text": "", "time": datetime.now(UTC).isoformat()})
            self.save()

    def save(self) -> None:
        CHAT_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = CHAT_FILE.with_name(CHAT_FILE.name + ".tmp")
        temporary.write_text(json.dumps(self.chat))
        temporary.replace(CHAT_FILE)

    def state(self) -> dict:
        """For the panel: the chat, whether a turn runs, and what waits for it."""
        return {"history": self.chat["history"], "busy": self.running is not None, "queued": [item["text"] for item in self.queue], "cost_usd": self.chat["cost_usd"]}

    def send(self, text: str, page: str) -> None:
        """The user's message, with the page they are on. Waits for a turn that runs. On the event loop."""
        if self.running is not None:
            self.queue.append({"text": text, "page": page})
            return
        self.start(text, page)

    def start(self, text: str, page: str) -> None:
        now = datetime.now(UTC)
        self.chat["history"].append({"type": "user", "text": text, "time": now.isoformat()})
        self.save()
        message = f"[The user is on {page or '#/'}. Now: {now.strftime('%Y-%m-%d %H:%M')} UTC]\n{text}"
        self.running = {"client": None, "stopped": False}
        asyncio.get_running_loop().create_task(self.run(message))

    async def stop(self) -> None:
        """Stop the turn that runs, and drop what waits for it."""
        self.queue = []
        if self.running is None:
            return
        self.running["stopped"] = True
        if self.running["client"] is not None:
            try:
                await self.running["client"].interrupt()
            except Exception:
                pass

    def new_chat(self) -> None:
        if self.running is not None:
            raise ValueError("Sherpa is working: stop it first.")
        self.chat = {"session_id": None, "history": [], "cost_usd": 0.0}
        self.save()

    def endpoints(self) -> str:
        """Every endpoint Sherpa may call, one line each: method, path, what it takes, and the first line of what it does."""
        lines = []
        for route in self.routes:
            if not isinstance(route, APIRoute):
                continue
            for method in sorted(route.methods):
                if self.denied(method, route.path):
                    continue
                takes = []
                for name, parameter in inspect.signature(route.endpoint).parameters.items():
                    if f"{{{name}}}" in route.path:
                        continue
                    annotation = parameter.annotation
                    models = [annotation] + list(typing.get_args(annotation))
                    body = [model for model in models if isinstance(model, type) and issubclass(model, BaseModel)]
                    if body:
                        fields = [f"{field}: {getattr(info.annotation, '__name__', str(info.annotation))}" for field, info in body[0].model_fields.items()]
                        takes.append("body {" + ", ".join(fields) + "}")
                    elif name not in ["request", "websocket"]:
                        takes.append(f"?{name}=")
                doc = (inspect.getdoc(route.endpoint) or "").split("\n\n")[0].replace("\n", " ")
                lines.append(f"{method} {route.path} {' '.join(takes)}  {doc}".strip())
        return "\n".join(lines)

    def denied(self, method: str, path: str) -> bool:
        for denied_method, pattern in DENIED:
            if denied_method in ["*", method] and re.fullmatch(pattern, path):
                return True
        return False

    async def run(self, text: str) -> None:
        """One turn: send the message and add to the chat until Sherpa ends it."""
        AGENT_HOME.mkdir(parents=True, exist_ok=True)
        history = self.chat["history"]
        # What each router is about (its module's description), then every endpoint: read each turn, so it follows the code.
        docs = ""
        for path in sorted((PROJECT_ROOT / "backend").glob("*_api.py")):
            source = path.read_text()
            if not source.startswith('"""') or source.count('"""') < 2:
                continue
            end = source.index('"""', 3)
            docs += f"=== {path.name} ===\n{source[3:end].strip()}\n\n"
        prompt = PROMPT + docs + "The endpoints you may call:\n\n" + self.endpoints()

        tools = [
            tool(
                "look",
                "Read one topic of what the app's pages show. topic: one of repos, issues, tracked, explore, jobs, inbox, prs, "
                "your_repos, notifications, agents, vms, images, projects, crashes, issue_drafts, resource, updates, github. "
                "fields: dotted paths to keep in each item of the list (e.g. [\"id\", \"facts.created_at\"]); [] for whole items.",
                {
                    "type": "object",
                    "properties": {"topic": {"type": "string"}, "fields": {"type": "array", "items": {"type": "string"}}},
                    "required": ["topic"],
                },
            )(self.look),
            tool(
                "call",
                "Use the app's API, like a button does: method GET, POST, PUT or DELETE, path like /api/issues/remove, body the "
                "JSON it takes ({} for none). Answers with what the app answered.",
                {
                    "type": "object",
                    "properties": {"method": {"type": "string"}, "path": {"type": "string"}, "body": {"type": "object"}},
                    "required": ["method", "path"],
                },
            )(self.call),
        ]
        client = ClaudeSDKClient(
            ClaudeAgentOptions(
                model=os.environ["CLAUDE_MODEL"],
                system_prompt=prompt,
                # No built-in tools: nothing on this machine is in reach but the app.
                tools=[],
                allowed_tools=[f"mcp__{TOOL_SERVER}__{item.name}" for item in tools],
                mcp_servers={TOOL_SERVER: create_sdk_mcp_server(name=TOOL_SERVER, tools=tools)},
                permission_mode="dontAsk",
                setting_sources=[],
                strict_mcp_config=True,
                resume=self.chat["session_id"],
                cwd=str(AGENT_HOME),
                # The backend runs in this repo: its CLAUDE.md and Claude Code's memory are not for Sherpa.
                env={
                    "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
                    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": os.environ["AGENT_CONTEXT_CAP"],
                },
            )
        )
        self.running["client"] = client
        try:
            await client.connect()
            await client.query(text)
            if self.running["stopped"]:
                await client.interrupt()
            async for message in client.receive_response():
                # The conversation's id comes first, so the next turn can go on with it even after a cut-off.
                if isinstance(message, SystemMessage) and message.subtype == "init" and message.data.get("session_id"):
                    self.chat["session_id"] = message.data["session_id"]
                if isinstance(message, ResultMessage):
                    self.chat["session_id"] = message.session_id
                    self.chat["cost_usd"] += message.total_cost_usd or 0.0
                    stopped = self.running["stopped"] or message.terminal_reason in ["aborted_streaming", "aborted_tools"]
                    if message.is_error and not stopped:
                        error = "; ".join(message.errors or []) or message.result or message.subtype
                        history.append({"type": "error", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text.strip():
                            history.append({"type": "text", "text": block.text, "time": datetime.now(UTC).isoformat()})
                        if isinstance(block, ToolUseBlock):
                            name = block.name.removeprefix(f"mcp__{TOOL_SERVER}__")
                            summary = f"Looked at {block.input.get('topic', '')}"
                            if name == "call":
                                summary = f"{block.input.get('method', '')} {block.input.get('path', '')}"
                            history.append({"type": "tool", "text": summary, "time": datetime.now(UTC).isoformat()})
                self.save()
        except Exception as error:
            history.append({"type": "error", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
        finally:
            history.append({"type": "turn_end", "text": "", "time": datetime.now(UTC).isoformat()})
            self.save()
            try:
                await client.disconnect()
            except Exception:
                # A Claude Code that already died has nothing left to close.
                pass
            self.running = None
            # The next message that waited goes in, with a turn of its own.
            if self.queue and not asyncio.current_task().cancelling():
                waiting = self.queue.pop(0)
                self.start(waiting["text"], waiting["page"])

    # --- Tools: an exception here reaches Sherpa as a failed tool call. ---

    async def look(self, args: dict) -> dict:
        topic = (args.get("topic") or "").strip()
        try:
            data = self.topic_data(topic)
        except ValueError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        # The list in it: the topic itself, or its "items" (and a PR topic's "items" and "issues").
        items = data
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            items = data["items"]
        fields = [field for field in (args.get("fields") or []) if isinstance(field, str) and field.strip()]
        if fields and isinstance(items, list):
            kept = []
            for item in items:
                row = {}
                for field in fields:
                    value = item
                    for key in field.split("."):
                        value = value.get(key) if isinstance(value, dict) else None
                    row[field] = value
                kept.append(row)
            items = kept
        text = json.dumps(items, default=str)
        if isinstance(items, list):
            text = f"{len(items)} items: " + text
        if len(text) > LOOK_CHARS:
            text = text[:LOOK_CHARS] + f"\n[Cut at {LOOK_CHARS} characters: ask for fewer fields.]"
        return {"content": [{"type": "text", "text": text}]}

    async def call(self, args: dict) -> dict:
        method = (args.get("method") or "GET").strip().upper()
        path = (args.get("path") or "").strip()
        if method not in ["GET", "POST", "PUT", "DELETE"] or not path.startswith("/api/"):
            return {"content": [{"type": "text", "text": "method is GET, POST, PUT or DELETE, and path starts with /api/."}], "is_error": True}
        if self.denied(method, path.split("?")[0]):
            text = f"{method} {path} is the user's to do, not yours: it goes to GitHub as them, or touches their sign-in, remote access, updates or secrets."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        body = args.get("body") or None
        if method in ["GET", "DELETE"]:
            body = None
        url = f"http://127.0.0.1:{os.environ['BACKEND_PORT']}{path}"
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                response = await client.request(method, url, json=body)
        except httpx.HTTPError as error:
            return {"content": [{"type": "text", "text": f"The app didn't answer: {error}"}], "is_error": True}
        text = f"{response.status_code}: {response.text}"
        if len(text) > CALL_CHARS:
            text = text[:CALL_CHARS] + f"\n[Cut at {CALL_CHARS} characters.]"
        return {"content": [{"type": "text", "text": text}], "is_error": response.status_code >= 400}
