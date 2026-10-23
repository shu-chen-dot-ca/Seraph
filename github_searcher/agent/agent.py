"""One agent: one long-lived Claude conversation.

Every agent is the same kind. It searches GitHub and keeps the Repos and Issues lists, works on
its jobs, and does the hands-on part in a VM while it holds one. Its tools come from one
in-process MCP server ("agent"):
- the GitHub tools (github_tools.py) read GitHub from this machine, so the token never enters the VM;
- the work tools (work_tools.py) change the lists, jobs, the Inbox and the VM queue;
- the computer tools (sandbox/agent/tools.py) act inside the VM: screen, mouse, keyboard, shell.
Of Claude Code's own tools it only gets TodoWrite, which touches nothing. No shell, files or web
on this machine, so the host's secrets stay out of reach.

The conversation lives in Claude Code and is resumed by its session id after a restart. What the
user sees is the history: the agent record's list, appended as messages arrive and never changed.
The frontend pairs each tool entry with its tool_result by id:

    {"type": "user", "text", "time"}            added by Agents, which batches the messages
    {"type": "system", "text", "time"}          also added by Agents (VM granted, inbox decisions, errors)
    {"type": "text", "text"}                    what the agent says
    {"type": "thinking", "text"}
    {"type": "tool", "id", "name", "summary", "input"}
    {"type": "tool_result", "id", "text", "is_error", "image"}
    {"type": "turn_end", "stopped", "cost_usd", "time"}

    agent = Agent(record, computer_tools, work_tools, on_change)
    await agent.run("[User] hello")
    await agent.stop()
"""

import os
from datetime import UTC, datetime
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, SystemMessage, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock, UserMessage, create_sdk_mcp_server
from dotenv import load_dotenv

from github_searcher.agent.github_tools import GithubTools
from github_searcher.agent.work_tools import WorkTools
from sandbox.agent.tools import ComputerTools

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

SYSTEM_PROMPT = (Path(__file__).parent / "prompt.md").read_text()
# Tools are served by an in-process MCP server with this name; their full names are mcp__<name>__<tool>.
TOOL_SERVER = "agent"
# How much of a tool's input and result the history keeps. The agent itself gets them in full.
INPUT_CUT = 2000
RESULT_CUT = 4000
# The folder Claude Code runs in. It has no file tools, so this only decides where Claude Code keeps the
# conversations: apart from the user's own Claude Code sessions for this repo.
AGENT_HOME = PROJECT_ROOT / os.environ["DATA_DIR"] / "agent_home"


class Agent:
    def __init__(self, record: dict, computer_tools: ComputerTools, work_tools: WorkTools, on_change):
        AGENT_HOME.mkdir(parents=True, exist_ok=True)
        self.record = record
        self.id = record["id"]
        self.name = record["name"]
        # The record's own list: appending here is appending to what gets saved.
        self.history = record["history"]
        # The Claude conversation to continue (None: a new one). Set when a turn starts and after it.
        self.session_id = record["claude_session_id"]
        # How full its context window is, in tokens. Read from Claude Code after connecting
        # and after each turn, and from each reply while it works.
        self.context_used = record["context_used"]
        self.context_max = record["context_max"]
        self.cost_usd = record["cost_usd"]
        self.computer_tools = computer_tools
        self.work_tools = work_tools
        # Called after every message, so the live feed sends the agent list again.
        self.on_change = on_change
        # Set by Agents while a turn runs.
        self.busy = False
        # When the last message of a turn came in (set by run()), or None before the first one.
        self.last_event_at = None
        # Whether the current (or last) turn was interrupted.
        self.stopped = False
        self.client = None
        # Claude Code reports cost as a running total for the connection; this turns it into each turn's cost.
        self.connection_cost = 0.0
        # The VM tools' lines in the chat come from their own describe(); all others' from WorkTools.describe().
        self.computer_names = [item.name for item in computer_tools.list()]

    async def connect(self) -> None:
        # GitHub tools still add old-style "activity" lines to the list they are given; nobody reads this one.
        tools = self.computer_tools.list() + self.work_tools.list() + GithubTools([]).list()
        allowed_tools = ["TodoWrite"]
        for item in tools:
            allowed_tools.append(f"mcp__{TOOL_SERVER}__{item.name}")

        self.client = ClaudeSDKClient(
            ClaudeAgentOptions(
                model=os.environ["CLAUDE_MODEL"],
                system_prompt=SYSTEM_PROMPT,
                # The only built-in tool: a todo list, which touches nothing on this machine.
                tools=["TodoWrite"],
                allowed_tools=allowed_tools,
                mcp_servers={TOOL_SERVER: create_sdk_mcp_server(name=TOOL_SERVER, tools=tools)},
                permission_mode="dontAsk",
                setting_sources=[],
                strict_mcp_config=True,
                resume=self.session_id,
                cwd=str(AGENT_HOME),
                # Screenshots make big messages; the default limit is 1MB.
                max_buffer_size=10 * 1024 * 1024,
                # The backend runs in this repo: don't hand the repo's CLAUDE.md or Claude Code's memory
                # (instructions meant for working on this code) to the agent. Compact at the app's cap.
                env={
                    "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
                    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": os.environ["AGENT_CONTEXT_CAP"],
                },
            )
        )
        try:
            await self.client.connect()
        except Exception as error:
            if self.session_id is None or "No conversation found" not in str(error):
                raise
            # Claude Code no longer has the conversation (its files were cleared): start a new one
            # instead of failing on every turn. The history stays; the agent forgets it.
            self.history.append({"type": "system", "text": "Could not continue the old conversation; started a new one", "time": datetime.now(UTC).isoformat()})
            await self.stop()
            self.session_id = None
            await self.connect()
            return
        self.connection_cost = 0.0
        usage = await self.client.get_context_usage()
        self.context_used = usage["totalTokens"]
        self.context_max = usage["maxTokens"]

    async def stop(self) -> None:
        """Disconnect. The next run() connects again and resumes the conversation."""
        if self.client is None:
            return
        client = self.client
        self.client = None
        try:
            await client.disconnect()
        except Exception:
            # A client whose Claude Code already died has nothing left to close.
            pass

    async def interrupt(self) -> None:
        if not self.busy:
            return
        # Also seen by run() when the turn is still starting.
        self.stopped = True
        if self.client is None:
            return
        try:
            await self.client.interrupt()
        except Exception:
            # The turn may have just ended.
            pass

    async def run(self, prompt: str) -> None:
        """One turn: send the prompt and add to the history until the agent ends its turn."""
        self.stopped = False
        if self.client is None:
            await self.connect()
        await self.client.query(prompt)
        if self.stopped:
            await self.client.interrupt()

        async for message in self.client.receive_response():
            # The conversation's id comes first, so a first turn cut off by a restart can still be continued.
            if isinstance(message, SystemMessage) and message.subtype == "init" and message.data.get("session_id"):
                self.session_id = message.data["session_id"]

            if isinstance(message, SystemMessage) and message.subtype == "compact_boundary":
                self.history.append({"type": "system", "text": "Context compacted", "time": datetime.now(UTC).isoformat()})

            if isinstance(message, AssistantMessage) and message.error:
                self.history.append({"type": "system", "text": f"Error from Claude: {message.error}", "time": datetime.now(UTC).isoformat()})

            # Each reply's usage is the whole conversation it was given, plus what it wrote.
            if isinstance(message, AssistantMessage) and message.usage:
                self.context_used = message.usage.get("input_tokens", 0)
                self.context_used += message.usage.get("cache_creation_input_tokens", 0)
                self.context_used += message.usage.get("cache_read_input_tokens", 0)
                self.context_used += message.usage.get("output_tokens", 0)

            if isinstance(message, ResultMessage):
                self.session_id = message.session_id
                total = message.total_cost_usd or 0.0
                # The running total starts again at 0 when the conversation is reset (e.g. by a reconnect).
                turn_cost = total - self.connection_cost
                if total < self.connection_cost:
                    turn_cost = total
                self.connection_cost = total
                self.cost_usd += turn_cost
                stopped = self.stopped or message.terminal_reason in ["aborted_streaming", "aborted_tools"]
                if message.is_error and not stopped:
                    error = "; ".join(message.errors or []) or message.result or message.subtype
                    self.history.append({"type": "system", "text": f"Error: {error}", "time": datetime.now(UTC).isoformat()})
                self.history.append({"type": "turn_end", "stopped": stopped, "cost_usd": turn_cost, "time": datetime.now(UTC).isoformat()})

            # The agent's text, thinking and tool calls come in its messages; tool results come back in user
            # messages (which also carry Claude Code's own notes, like "[Request interrupted by user]", not kept).
            blocks = []
            if isinstance(message, (AssistantMessage, UserMessage)) and isinstance(message.content, list):
                blocks = message.content
            for block in blocks:
                if isinstance(block, TextBlock) and isinstance(message, AssistantMessage) and block.text.strip():
                    self.history.append({"type": "text", "text": block.text})
                if isinstance(block, ThinkingBlock) and block.thinking.strip():
                    self.history.append({"type": "thinking", "text": block.thinking})
                if isinstance(block, ToolUseBlock):
                    name = block.name.removeprefix(f"mcp__{TOOL_SERVER}__")
                    summary = self.work_tools.describe(name, block.input)
                    if name in self.computer_names:
                        summary = self.computer_tools.describe(name, block.input)
                    cut = {key: value[:INPUT_CUT] if isinstance(value, str) else value for key, value in block.input.items()}
                    self.history.append({"type": "tool", "id": block.id, "name": name, "summary": summary, "input": cut})
                if not isinstance(block, ToolResultBlock):
                    continue
                # A result is text, or a list of text and image parts (screenshots). Images are not kept.
                parts = block.content if isinstance(block.content, list) else [{"type": "text", "text": block.content or ""}]
                text = "\n".join(part.get("text", "") for part in parts if part.get("type") == "text")
                image = any(part.get("type") == "image" for part in parts)
                self.history.append({"type": "tool_result", "id": block.tool_use_id, "text": text[:RESULT_CUT], "is_error": bool(block.is_error), "image": image})
            # When something last happened, so the user can tell a long command from an agent that is stuck.
            self.last_event_at = datetime.now(UTC).isoformat()
            self.on_change()

        # A desktop lock the agent set ends with its turn: Agents.work calls computer_tools.end_turn(),
        # also when the turn fails or is cancelled.
        usage = await self.client.get_context_usage()
        self.context_used = usage["totalTokens"]
        self.context_max = usage["maxTokens"]
