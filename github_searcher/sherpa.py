"""Sherpa: the round button at the bottom right of every page (frontend/src/Sherpa.tsx), a Claude conversation that
knows the whole app and can see and use the page the user is on.

What it knows: every page's own description (the comment at the top of each file in frontend/src), put in its prompt
at each turn, and for the details read_source and search_source, read-only and only what it needs to explain the app
(readable): the screens' code (frontend/src), the docs (README.md, docs/), and what each part behind them does (the
description at the top of each .py file in backend, github_searcher and sandbox: its docstring, not its code). Never
data/ (the user's lists, chats, VMs' settings), .env (tokens) or anything else on this machine. It writes no files:
the app keeps its chats, and Claude Code's own tools (files, shell, web) are off.
What it sees: each message comes with the page the user is on, read by the browser: the address, the sidebar, the text
on the page, and every button, link and field, numbered (Sherpa.tsx readPage).
What it does: go_to, click, fill and point act on the page in the user's browser tab (the one the message came from),
and answer with the page as it is after. The browser refuses a click inside a confirmation (Delete, Reject...): the
user confirms those themselves, except the ones marked data-sherpa-may-confirm (deleting an image), which a click
with confirm (the user asked for exactly that) may answer. Clicks are events sent to the element in the page, never
the user's mouse.
look_page reads the page again, and screenshot shows it: the browser draws the app's own page to an image (nothing
outside the app, no other window), with each element's number on it when asked.
What it reads on GitHub: the agents' GitHub tools (agent/github_tools.py, through the app's tokens), read-only: READMEs,
a repo's files and their text (default branch), issues and PRs with their comments, code and issue search, and a repo's
numbers (check_activity, the same as the Repos page). It never writes anything on GitHub.

How an action reaches the browser: the tool puts it in `pending`, the browser (which asks GET /api/sherpa every half
second while a turn runs) does it and posts what happened (POST /api/sherpa/result), which the tool waits for, up to
ACTION_TIMEOUT seconds.

Chats are kept, one file each, for the panel's history (the newest first; open one to go on with it, or delete it):

    DATA_DIR/sherpa_chats/<id>.json   {"id", "title", "created_at", "updated_at", "session_id", "history": [entry, ...],
                                       "cost_usd", "context_used", "queue": [{"text", "page", "tab"}, ...], "tab",
                                       "resumes"}

with entries like the image agent's (sandbox/image_agent.py). The title is the first message. One chat is open
(`current`): at start the one used last; New chat opens an empty one, saved once its first message is sent. Each turn
connects to Claude Code, resumes the open chat's conversation by its session id, and disconnects at the end. Claude
Code's own tools are off: only the tools here. While a turn runs, the open chat stays open.
A message sent while Sherpa works waits for its turn to end, like an agent's (MAX_QUEUED at most, each gets a turn of
its own; its page isn't read, as that would number the page again under the turn using it, so Sherpa reads it then);
stopping a turn lets the next one in. The queue is kept in the
chat's file, so a restart doesn't lose it. "/compact" goes to Claude Code as it is: it summarizes the chat to free
context. tab is the browser tab of the last message, for a turn that goes on by itself.
A restart of the backend (also whenever the app's code changes, while it runs with reload) cuts off a turn in the
middle, without its end. load() marks such a chat ("Cut off ...", CUT_OFF), and at start resume() has Sherpa go on
where it left off by itself (its conversation keeps what it did so far), then with the queued messages. Not after
MAX_RESUMES cut-offs in a row (resumes counts them): then the user's next message goes on, and tells Sherpa.
context_used is how much of the context window the chat fills (the panel's bar, up to CONTEXT_CAP): each reply's
usage while a turn runs, and Claude Code's own count at its end. Like the agents, it is compacted at CONTEXT_CAP.

    sherpa = Sherpa()
    sherpa.send("how do I give an agent more memory?", page, tab)
"""

import ast
import asyncio
import json
import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, SystemMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage, create_sdk_mcp_server, tool
from dotenv import load_dotenv

from github_searcher.agent.github_tools import GithubTools

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Claude Code runs here. With no file tools this only decides where it keeps the conversation.
AGENT_HOME = DATA_DIR / "sherpa_home"
CHATS_DIR = DATA_DIR / "sherpa_chats"
CHAT_ID = re.compile(r"[0-9a-f]{12}")
TITLE_CHARS = 80
# What a chat says when its last turn never ended: the backend restarted in the middle of it.
CUT_OFF = "Cut off: the app restarted in the middle of this turn (its code changed, or it was restarted)."
# How such a note starts, also in chats from when it said more.
CUT_OFF_START = "Cut off: the app restarted"
# How many cut-offs in a row Sherpa goes on from by itself.
MAX_RESUMES = 3
# Messages that may wait for the turn to end at once, like an agent's (agents.py MAX_QUEUED).
MAX_QUEUED = 10
TOOL_SERVER = "sherpa"
# How long a page action may take in the browser.
ACTION_TIMEOUT = 20
# How much of a tool's result the chat keeps. Sherpa gets it in full.
RESULT_CUT = 4000
# What read_source and search_source may read, read-only (readable): these in full, and only the description (the
# docstring) of the .py files in DESCRIBED_FOLDERS. Nothing else: not data/, not .env.
FULL_FOLDERS = {"frontend/src": [".ts", ".tsx", ".css"], "docs": [".md"]}
FULL_FILES = ["README.md"]
DESCRIBED_FOLDERS = ["backend", "github_searcher", "sandbox"]
SOURCE_LIMIT = 120_000
# The same cap as the agents: the bar's end, where Claude Code compacts the conversation.
CONTEXT_CAP = int(os.environ["AGENT_CONTEXT_CAP"])
SEARCH_LIMIT = 80

PROMPT = """You are Sherpa, the guide of Seraph, an app on the user's own computer that finds open-source work and does it: Explore
finds repos to contribute to, Repos and Tracked keep them, Issues lists issues to work on, AI agents work on them as
jobs inside VMs (virtual machines the user can watch in the browser), and whatever an agent wants to post on GitHub
waits in the Inbox for the user to approve. You live in the round button at the bottom right of every page: the user
opens you to ask how something works or where something is, or to get something done.

You know the whole app. Below is every page's own description (the comment at the top of each file in frontend/src).
For details, read_source reads the screens' code (frontend/src), the docs (README.md, docs/*.md), and what each part
behind the screens does (for a .py file in backend, github_searcher or sandbox you get its description, not its code);
search_source finds where something is in those. Nothing else on this computer is open to you (not the user's data,
not their settings or tokens), and you can't change any file. Look things up rather than guess; never make up a button
or a page.

You can read GitHub too, read-only: read_readme, list_files and read_files (a repo's default branch), read_thread
(an issue or PR with its comments), search_code, search_issues, and check_activity (how a repo treats outside
contributors: the numbers the Repos page shows). Use them when the user asks about a repo, an issue or a PR, or when
helping them needs it (what an issue asks for, before writing a job for it). You never post anything on GitHub.

You see the user's page: each message comes with it. The address, the sidebar, the text on the page, and every
button, link and field, each with a number. When a pop-up is open you only get the pop-up: the rest can't be used then.
You can use the page, in the user's browser, while they watch:
- go_to opens an address (#/explore, #/vms/<name>, ...),
- click clicks a button, link, tab, switch, menu item or option (a select opens with a click on it; then click the
  option),
- fill types text into a field, replacing what is in it,
- point highlights something on their screen, to show them where it is,
- look_page reads the page again,
- screenshot shows you how the page looks (the app only; a VM's desktop comes out blank). With numbers, each usable
  element's number is drawn on it. Take one when how it looks matters (a layout, a color, a chart, where something
  sits), not for every step: the page's text is usually enough.
Each of them answers with the page as it is after, numbered again: always use the numbers from the latest page.
Your clicks go to the element itself; the user's mouse never moves.

How to help:
- A question: answer it in a few plain sentences, and point at what you talk about when it is on the page. When it is
  on another page, say where, or go there when that helps.
- Something to do: do it, step by step. When they need words they don't have (a job's description, a message to an
  agent, an Explore profile), write good ones from what they told you, fill them in, and say so, so they read them over.
- What makes a lasting change (Save, Create, Start, Send, Approve, Reject, Delete, Stop): click it only when the user
  asked for exactly that. Otherwise fill everything in, point at the button, and leave the click to them.
- After you fill in a YAML (the VMs page's Defaults tab, an image's Definition), click its Check: the mechanical
  check Save uses, without saving. Fix what it lists and check again, so what you leave for the user passes.
- Pop-ups that ask "are you sure?" are the user's to answer: you can't click in them. Point at the button.
  The one exception is deleting an image (VMs page, Images tab, the image's menu, Delete): when the user asked you to
  delete that image, click Delete in the pop-up with confirm true. Never set confirm for anything else, and never for an
  image the user didn't ask you to delete.
- You can't see or use what is inside a VM's desktop or terminal: that is a screen of its own.
- When something can't be done in the app, say so plainly.
- Long text the user may want to keep or paste (a whole YAML, a long prompt): write it in your message as well as
  filling it in. Only what is in your messages stays in the chat; never point the user to a message that isn't there.
Keep it short: the user reads you in a small panel. Plain words, no headings.

The pages:

"""


class Sherpa:
    def __init__(self, repo_signals):
        # For check_activity (the Repos page's numbers).
        self.repo_signals = repo_signals
        # The open chat's id: the one used last, or None for a new chat.
        self.current = None
        chats = self.chats()
        if chats:
            self.current = chats[0]["id"]
        # The turn running now, or None: {"client", "chat", "stopped", "task", "tab"}. Its chat's "queue" has the
        # messages waiting for it to end.
        self.running = None
        # The page action the browser should do now, or None: {"id", "tab", "action"}; and what waits for its answer.
        self.pending = None
        self.waiter = None
        self.action_id = 0
        # The page Sherpa saw last, for naming the element in a click, fill or point ("[12] button "Save"").
        self.last_page = ""

    def load(self, chat_id: str | None) -> dict:
        """A chat by its id; a new, empty one for None (or one that was deleted). Its last turn, when it never ended (and
        isn't running), is marked as cut off."""
        if chat_id is None or not (CHATS_DIR / f"{chat_id}.json").exists():
            return {"id": None, "title": "", "created_at": None, "updated_at": None, "session_id": None, "history": [], "cost_usd": 0.0, "context_used": 0}
        chat = json.loads((CHATS_DIR / f"{chat_id}.json").read_text())
        history = chat["history"]
        if self.running is None and history and history[-1]["type"] != "turn_end":
            history.append({"type": "system", "text": CUT_OFF, "time": datetime.now(UTC).isoformat()})
            history.append({"type": "turn_end", "stopped": True, "cost_usd": 0.0, "time": datetime.now(UTC).isoformat()})
            self.save(chat)
        return chat

    def save(self, chat: dict) -> None:
        CHATS_DIR.mkdir(parents=True, exist_ok=True)
        chat["updated_at"] = datetime.now(UTC).isoformat()
        path = CHATS_DIR / f"{chat['id']}.json"
        # Write, then rename: a crash never leaves half a chat.
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(chat))
        temporary.replace(path)

    def chats(self) -> list[dict]:
        """For the history: every chat, the newest first, with its title and when it was last used."""
        listed = []
        if CHATS_DIR.exists():
            for path in CHATS_DIR.glob("*.json"):
                chat = json.loads(path.read_text())
                listed.append({"id": chat["id"], "title": chat["title"], "updated_at": chat["updated_at"]})
        listed.sort(key=lambda each: each["updated_at"], reverse=True)
        return listed

    def chat(self) -> dict:
        """For the panel: the open chat, whether a turn runs, what it cost so far, and the page action waiting."""
        if self.running is not None:
            chat = self.running["chat"]
        else:
            chat = self.load(self.current)
        return {
            "id": chat["id"],
            "history": chat["history"],
            "busy": self.running is not None,
            "cost_usd": chat["cost_usd"],
            # Chats from before it was counted: 0 until their next turn.
            "context_used": chat.get("context_used", 0),
            "context_cap": CONTEXT_CAP,
            "queued": [each["text"] for each in chat.get("queue", [])],
            "pending": self.pending,
        }

    def send(self, text: str, page: str, tab: str) -> None:
        """Start a turn with the user's message and their page, or queue it while a turn runs. Answers at once; call it
        on the event loop."""
        if not text.strip():
            raise ValueError("The message is empty")
        if self.running is not None:
            queue = self.running["chat"].setdefault("queue", [])
            if len(queue) >= MAX_QUEUED:
                raise ValueError(f"{MAX_QUEUED} messages wait already. Send more when one has gone in.")
            queue.append({"text": text.strip(), "page": page, "tab": tab})
            self.save(self.running["chat"])
            return
        self.start(text.strip(), page, tab)

    def resume(self) -> None:
        """At start, on the event loop: go on by itself with a turn a restart cut off, then with the queued messages."""
        if self.current is None:
            return
        chat = self.load(self.current)
        history = chat["history"]
        cut = len(history) >= 2 and history[-2]["type"] == "system" and history[-2]["text"].startswith(CUT_OFF_START)
        if cut and chat.get("resumes", 0) < MAX_RESUMES:
            chat["resumes"] = chat.get("resumes", 0) + 1
            self.save(chat)
            self.start("", "", chat.get("tab", ""), True)
            return
        if cut:
            note = f"Cut off {MAX_RESUMES} times in a row, so it doesn't go on by itself: send a message to go on."
            history.append({"type": "system", "text": note, "time": datetime.now(UTC).isoformat()})
            self.save(chat)
        queue = chat.get("queue", [])
        if queue:
            waiting = queue.pop(0)
            self.save(chat)
            self.start(waiting["text"], waiting["page"], waiting["tab"])

    def start(self, text: str, page: str, tab: str, resuming: bool = False) -> None:
        """A turn on the open chat with this message (a new chat is kept from now on). resuming: no message, Sherpa goes
        on with the turn a restart cut off."""
        chat = self.load(self.current)
        if chat["id"] is None:
            # A new chat: kept from its first message on, named after it.
            chat["id"] = uuid.uuid4().hex[:12]
            chat["title"] = " ".join(text.split())[:TITLE_CHARS]
            chat["created_at"] = datetime.now(UTC).isoformat()
            self.current = chat["id"]
        if tab != "":
            chat["tab"] = tab
        if resuming:
            chat["history"].append({"type": "system", "text": "Going on by itself after the restart.", "time": datetime.now(UTC).isoformat()})
            message = (
                "[The app restarted in the middle of your last turn and cut it off. Go on where you left off. The page may "
                "have changed: look_page first. Anything you were still writing when it was cut off is lost: write it again.]"
            )
        else:
            chat["history"].append({"type": "user", "text": text, "time": datetime.now(UTC).isoformat()})
            message = f"[The page the user is on now]\n{page}\n\n[The user]\n{text}"
            # Sent while Sherpa worked: the browser didn't read the page then, as that would number it again under the
            # turn that was using it.
            if page == "":
                message = f"[The user, while you were working]\n{text}\n\n[Their page wasn't read with this message: look_page reads it.]"
            # The turn before was cut off (load() marked it: its note, its end, then this message): Sherpa is told, as
            # what it did then may be half done and what it was still writing is lost.
            before = chat["history"][-3] if len(chat["history"]) >= 3 else {}
            if before.get("type") == "system" and before.get("text", "").startswith(CUT_OFF_START):
                message = "[Your last turn was cut off: the app restarted in the middle of it. Anything you were still writing then is lost.]\n\n" + message
            # A slash command goes to Claude Code as it is.
            if text == "/compact":
                message = text
        self.save(chat)
        if page != "":
            self.last_page = page
        self.running = {"client": None, "chat": chat, "stopped": False, "task": None, "tab": chat.get("tab", "")}
        # Kept, so the task isn't garbage collected while it runs.
        self.running["task"] = asyncio.get_running_loop().create_task(self.run(message))

    def result(self, action_id: int, ok: bool, text: str, image: str) -> None:
        """What the browser did with a page action. An answer that comes too late is dropped."""
        if self.pending is None or self.pending["id"] != action_id or self.waiter is None or self.waiter.done():
            return
        # The browser numbered the page again when it read it (also when the action failed).
        if "Address:" in text:
            self.last_page = text[text.index("Address:"):]
        self.waiter.set_result((ok, text, image))

    async def interrupt(self) -> None:
        running = self.running
        if running is None:
            return
        # Also seen by run() when the turn is still starting.
        running["stopped"] = True
        # A page action it waits for ends now.
        if self.waiter is not None and not self.waiter.done():
            self.waiter.set_result((False, "Stopped by the user.", ""))
        if running["client"] is None:
            return
        try:
            await running["client"].interrupt()
        except Exception:
            # Not connected yet, or the turn just ended.
            pass

    def new_chat(self) -> None:
        """Open a new, empty chat. The one before stays in the history."""
        if self.running is not None:
            raise ValueError("Sherpa is still working. Stop it first.")
        self.current = None

    def open_chat(self, chat_id: str) -> None:
        """Open a chat from the history, to go on with it."""
        if self.running is not None:
            raise ValueError("Sherpa is still working. Stop it first.")
        if not CHAT_ID.fullmatch(chat_id) or not (CHATS_DIR / f"{chat_id}.json").exists():
            raise ValueError("That chat is gone")
        self.current = chat_id

    def delete_chat(self, chat_id: str) -> None:
        """Delete a chat from the history. Deleting the open one opens a new chat."""
        if not CHAT_ID.fullmatch(chat_id):
            raise ValueError("That chat is gone")
        if self.running is not None and self.running["chat"]["id"] == chat_id:
            raise ValueError("Sherpa is working in that chat. Stop it first.")
        (CHATS_DIR / f"{chat_id}.json").unlink(missing_ok=True)
        if self.current == chat_id:
            self.current = None

    async def run(self, text: str) -> None:
        """One turn: send the message and add to the chat until Sherpa ends its turn."""
        AGENT_HOME.mkdir(parents=True, exist_ok=True)
        running = self.running
        chat = running["chat"]
        history = chat["history"]

        # Every page's description, read again each turn, so it follows the code.
        docs = ""
        for path in sorted((PROJECT_ROOT / "frontend" / "src").glob("*.tsx")):
            source = path.read_text()
            if source.startswith("/*") and "*/" in source:
                docs += f"=== {path.name} ===\n{source[2:source.index('*/')].strip()}\n\n"

        tools = [
            tool("look_page", "Read the user's page again: the address, the text, and every button, link and field, numbered.", {})(self.look_page),
            tool(
                "screenshot",
                "See the user's page as an image (the app only), with the page's text. numbers: draw each usable element's number on it.",
                {"numbers": bool},
            )(self.screenshot),
            tool("go_to", "Open an address of the app in the user's tab, like #/explore or #/vms/vm1. Answers with the page.", {"address": str})(self.go_to),
            tool(
                "click",
                "Click the element with this number (from the latest page). Answers with the page after. Refused inside a "
                "confirmation (point at it instead), except deleting an image: confirm true answers that one, only when the user "
                "asked you to delete that image. confirm false for every other click.",
                {"element": int, "confirm": bool},
            )(self.click),
            tool("fill", "Type text into the field with this number (from the latest page), replacing what is in it. Answers with the page after.", {"element": int, "text": str})(
                self.fill
            ),
            tool("point", "Highlight the element with this number (from the latest page) on the user's screen, until they click somewhere.", {"element": int})(
                self.point
            ),
            tool(
                "read_source",
                "Read a file of the app by its path from the repo's root: a screen's code (frontend/src/Explore.tsx), the docs (README.md, "
                "docs/architecture.md), or what a part behind the screens does (github_searcher/explore.py gives its description, not its code).",
                {"path": str},
            )(self.read_source),
            tool("search_source", "Find the lines with this text (not case sensitive) in what read_source can read, with their file and line.", {"text": str})(
                self.search_source
            ),
        ]
        # Reading GitHub: the agents' tools. Their own activity lines go to a list nobody reads: the chat has its own.
        tools += GithubTools([], self.repo_signals).list()
        client = ClaudeSDKClient(
            ClaudeAgentOptions(
                model=os.environ["CLAUDE_MODEL"],
                system_prompt=PROMPT + docs,
                # No built-in tools: nothing on this machine is in reach.
                tools=[],
                allowed_tools=[f"mcp__{TOOL_SERVER}__{item.name}" for item in tools],
                mcp_servers={TOOL_SERVER: create_sdk_mcp_server(name=TOOL_SERVER, tools=tools)},
                permission_mode="dontAsk",
                setting_sources=[],
                strict_mcp_config=True,
                resume=chat["session_id"],
                cwd=str(AGENT_HOME),
                # Screenshots make big messages; the default limit is 1MB.
                max_buffer_size=10 * 1024 * 1024,
                # The backend runs in this repo: its CLAUDE.md and Claude Code's memory are not for Sherpa. Compact at the cap.
                env={
                    "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
                    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(CONTEXT_CAP),
                },
            )
        )
        running["client"] = client
        try:
            await client.connect()
            await client.query(text)
            if running["stopped"]:
                await client.interrupt()
            async for message in client.receive_response():
                # The conversation's id comes first, so a turn cut off by a restart can still be continued.
                if isinstance(message, SystemMessage) and message.subtype == "init" and message.data.get("session_id"):
                    chat["session_id"] = message.data["session_id"]

                if isinstance(message, SystemMessage) and message.subtype == "compact_boundary":
                    history.append({"type": "system", "text": "Context compacted", "time": datetime.now(UTC).isoformat()})

                # Each reply's usage is the whole conversation it was given, plus what it wrote.
                if isinstance(message, AssistantMessage) and message.usage:
                    chat["context_used"] = message.usage.get("input_tokens", 0)
                    chat["context_used"] += message.usage.get("cache_creation_input_tokens", 0)
                    chat["context_used"] += message.usage.get("cache_read_input_tokens", 0)
                    chat["context_used"] += message.usage.get("output_tokens", 0)

                if isinstance(message, ResultMessage):
                    chat["session_id"] = message.session_id
                    # Each turn has its own connection, so the connection's total is this turn's cost.
                    cost = message.total_cost_usd or 0.0
                    chat["cost_usd"] += cost
                    # A turn that ended: the next cut-off may be gone on from by itself again.
                    chat["resumes"] = 0
                    stopped = running["stopped"] or message.terminal_reason in ["aborted_streaming", "aborted_tools"]
                    if message.is_error and not stopped:
                        error = "; ".join(message.errors or []) or message.result or message.subtype
                        history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
                    history.append({"type": "turn_end", "stopped": stopped, "cost_usd": cost, "time": datetime.now(UTC).isoformat()})

                # Text and tool calls come in Sherpa's messages; tool results come back in user messages.
                blocks = []
                if isinstance(message, (AssistantMessage, UserMessage)) and isinstance(message.content, list):
                    blocks = message.content
                for block in blocks:
                    if isinstance(block, TextBlock) and isinstance(message, AssistantMessage) and block.text.strip():
                        history.append({"type": "text", "text": block.text})
                    if isinstance(block, ToolUseBlock):
                        tool_name = block.name.removeprefix(f"mcp__{TOOL_SERVER}__")
                        # The element as the page named it: [12] button "Save" → button "Save".
                        element = f"element {block.input.get('element', '')}"
                        for line in self.last_page.split("\n"):
                            if line.startswith(f"[{block.input.get('element', '')}] "):
                                # Without the field's value: [12] text box "Notes" = "..." → text box "Notes".
                                element = line.split("] ", 1)[1].split(' = "', 1)[0][:80]
                        summary = tool_name
                        if tool_name == "look_page":
                            summary = "Looked at the page"
                        if tool_name == "screenshot":
                            summary = "Took a screenshot"
                        if tool_name == "go_to":
                            summary = f"Went to {block.input.get('address', '')}"
                        if tool_name == "click":
                            summary = f"Clicked {element}"
                        if tool_name == "fill":
                            summary = f"Filled in {element}"
                        if tool_name == "point":
                            summary = f"Pointed at {element}"
                        if tool_name == "read_source":
                            summary = f"Read {block.input.get('path', '')}"
                        if tool_name == "search_source":
                            summary = f"Looked for {block.input.get('text', '')} in the app's code"
                        if tool_name == "read_readme":
                            summary = f"Read the README of {', '.join(block.input.get('names', []))}"
                        if tool_name == "check_activity":
                            summary = f"Checked {', '.join(block.input.get('names', []))} on GitHub"
                        if tool_name == "read_thread":
                            summary = f"Read {', '.join(block.input.get('threads', []))}"
                        if tool_name == "list_files":
                            summary = f"Listed the files of {block.input.get('name', '')} {block.input.get('path', '')}".strip()
                        if tool_name == "read_files":
                            summary = f"Read {', '.join(block.input.get('paths', []))} in {block.input.get('name', '')}"
                        if tool_name == "search_code":
                            summary = f"Searched GitHub's code for {block.input.get('q', '')}"
                        if tool_name == "search_issues":
                            summary = f"Searched GitHub's issues for {block.input.get('q', '')}"
                        history.append({"type": "tool", "id": block.id, "name": tool_name, "summary": summary})
                    if isinstance(block, ToolResultBlock):
                        parts = block.content if isinstance(block.content, list) else [{"type": "text", "text": block.content or ""}]
                        result = "\n".join(part.get("text", "") for part in parts if part.get("type") == "text")
                        history.append({"type": "tool_result", "id": block.tool_use_id, "text": result[:RESULT_CUT], "is_error": bool(block.is_error)})
                self.save(chat)
            # Claude Code's own count at the end of the turn, the exact one.
            try:
                usage = await client.get_context_usage()
                chat["context_used"] = usage["totalTokens"]
            except Exception:
                # Not known: the last reply's count stays.
                pass
        except Exception as error:
            history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
        finally:
            self.pending = None
            self.waiter = None
            self.save(chat)
            try:
                await client.disconnect()
            except Exception:
                # A Claude Code that already died has nothing left to close.
                pass
            # Running until here, so a message sent meanwhile is queued. Then the next message that waited goes in, with a
            # turn of its own, at once (no await in between). Not when the backend is shutting down: resume() does it.
            self.running = None
            queue = chat.get("queue", [])
            if queue and not asyncio.current_task().cancelling():
                waiting = queue.pop(0)
                self.save(chat)
                self.start(waiting["text"], waiting["page"], waiting["tab"])

    # --- Tools ---------------------------------------------------------------------
    # An exception here reaches Sherpa as a failed tool call.

    async def act(self, action: dict) -> dict:
        """Have the browser tab the message came from do a page action, and wait for what happened."""
        self.action_id += 1
        self.pending = {"id": self.action_id, "tab": self.running["tab"], "action": action}
        self.waiter = asyncio.get_running_loop().create_future()
        try:
            ok, text, image = await asyncio.wait_for(self.waiter, ACTION_TIMEOUT)
        except TimeoutError:
            raise ValueError("The user's page didn't answer: its tab may be closed or asleep. Tell the user.")
        finally:
            self.pending = None
            self.waiter = None
        if not ok:
            raise ValueError(text)
        if image:
            return {"content": [{"type": "image", "data": image, "mimeType": "image/jpeg"}, {"type": "text", "text": text}]}
        return {"content": [{"type": "text", "text": text}]}

    async def look_page(self, args: dict) -> dict:
        return await self.act({"kind": "look"})

    async def screenshot(self, args: dict) -> dict:
        return await self.act({"kind": "screenshot", "numbers": bool(args.get("numbers"))})

    async def go_to(self, args: dict) -> dict:
        if not args["address"].startswith("#/"):
            raise ValueError("An address starts with #/, like #/explore.")
        return await self.act({"kind": "go_to", "address": args["address"]})

    async def click(self, args: dict) -> dict:
        return await self.act({"kind": "click", "element": args["element"], "confirm": bool(args.get("confirm"))})

    async def fill(self, args: dict) -> dict:
        return await self.act({"kind": "fill", "element": args["element"], "text": args["text"]})

    async def point(self, args: dict) -> dict:
        return await self.act({"kind": "point", "element": args["element"]})

    def readable(self, path: Path) -> str | None:
        """What Sherpa may read of a file: all of it, only its description (a .py file's docstring), or None (not allowed,
        or not there). The path is resolved first, so ".." and links can't reach past these."""
        path = path.resolve()
        if not path.is_file() or "node_modules" in path.parts or "__pycache__" in path.parts:
            return None
        for name in FULL_FILES:
            if path == PROJECT_ROOT / name:
                return path.read_text(errors="replace")
        for folder, types in FULL_FOLDERS.items():
            if path.is_relative_to(PROJECT_ROOT / folder) and path.suffix in types:
                return path.read_text(errors="replace")
        for folder in DESCRIBED_FOLDERS:
            if path.is_relative_to(PROJECT_ROOT / folder) and path.suffix == ".py":
                try:
                    return ast.get_docstring(ast.parse(path.read_text())) or "(This file has no description.)"
                except SyntaxError:
                    return None
        return None

    async def read_source(self, args: dict) -> dict:
        text = self.readable(PROJECT_ROOT / args["path"].strip().lstrip("/"))
        if text is None:
            raise ValueError(
                f"Can't read {args['path']}: it isn't there, or it isn't open to you (only frontend/src, README.md, docs/, "
                "and the descriptions of the .py files in backend, github_searcher and sandbox). search_source finds where things are."
            )
        if len(text) > SOURCE_LIMIT:
            text = text[:SOURCE_LIMIT] + "\n[...cut]"
        return {"content": [{"type": "text", "text": text}]}

    async def search_source(self, args: dict) -> dict:
        needle = args["text"].strip().lower()
        if needle == "":
            raise ValueError("Say what to look for.")
        lines = await asyncio.to_thread(self.find_lines, needle)
        if not lines:
            return {"content": [{"type": "text", "text": f"Nothing open to you has {args['text']}."}]}
        text = "\n".join(lines[:SEARCH_LIMIT])
        if len(lines) > SEARCH_LIMIT:
            text += f"\n... and {len(lines) - SEARCH_LIMIT} more. Look for something narrower."
        return {"content": [{"type": "text", "text": text}]}

    def find_lines(self, needle: str) -> list[str]:
        """The lines with needle in what Sherpa may read (readable): a .py file's description only."""
        paths = [PROJECT_ROOT / name for name in FULL_FILES]
        for folder in list(FULL_FOLDERS) + DESCRIBED_FOLDERS:
            paths += sorted((PROJECT_ROOT / folder).rglob("*"))
        lines = []
        for path in paths:
            text = self.readable(path)
            if text is None:
                continue
            for number, line in enumerate(text.split("\n"), start=1):
                if needle in line.lower():
                    lines.append(f"{path.relative_to(PROJECT_ROOT)}:{number}: {line.strip()[:200]}")
        return lines
