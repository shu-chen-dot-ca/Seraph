"""A bare agent: one Claude conversation that only talks, for now.

Starting point for the agents that work on a sandbox VM. It has none of Claude
Code's built-in tools (no shell, files or web on this machine). Given a VM, it
gets the computer use tools (tools.py): screenshots, mouse, keyboard and a
shell, all inside that VM. Without one it only talks.

    agent = Agent(session=session)
    await agent.start()
    reply = await agent.run("hello")
    await agent.stop()
"""

import asyncio
import os
from pathlib import Path

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock, UserMessage, create_sdk_mcp_server
from dotenv import load_dotenv

from sandbox.agent.computer_use import Computer
from sandbox.agent.tools import ComputerTools
from sandbox.session import Session

# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env", override=True)

SYSTEM_PROMPT = (Path(__file__).parent / "prompt.md").read_text()
MODEL = os.environ["CLAUDE_MODEL"]
# Tools are served by an in-process MCP server with this name; their full names are mcp__<name>__<tool>.
TOOL_SERVER = "agent"


class Agent:
    def __init__(self, session_id: str | None = None, history: list | None = None, session: Session | None = None):
        self.tokens = 0
        self.cost = 0.0
        self.interrupt = False
        # The Claude conversation to continue (None: a new one). Set after each run.
        self.session_id = session_id
        # What the user sees: {"role": "user" | "assistant" | "activity", "text": ...}
        self.history = history or []
        # How full its context window is, in tokens. Read from Claude Code after
        # connecting and after each turn, and from each reply while it works.
        self.context_used = 0
        self.context_max = 0

        # Without a session (and so a VM) it only talks.
        tools = []
        # Kept to end each turn (lock_desktop's lock ends with the turn).
        self.computer_tools = None
        if session is not None:
            self.computer_tools = ComputerTools(Computer(session.vm), session, self.history)
            tools = self.computer_tools.list()
        allowed_tools = []
        for item in tools:
            allowed_tools.append(f"mcp__{TOOL_SERVER}__{item.name}")

        self.client = ClaudeSDKClient(
            ClaudeAgentOptions(
                model=MODEL,
                system_prompt=SYSTEM_PROMPT,
                tools=[],
                mcp_servers={TOOL_SERVER: create_sdk_mcp_server(name=TOOL_SERVER, tools=tools)},
                allowed_tools=allowed_tools,
                permission_mode="dontAsk",
                setting_sources=[],
                strict_mcp_config=True,
                resume=session_id,
                # Screenshots make big messages; the default limit is 1MB.
                max_buffer_size=10 * 1024 * 1024,
                # The backend runs in this repo: don't hand the repo's CLAUDE.md or Claude Code's
                # memory (instructions meant for working on this code) to the VM's agent.
                env={"CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"},
            )
        )

    async def start(self):
        await self.client.connect()
        await self.read_context()

    async def read_context(self):
        usage = await self.client.get_context_usage()
        self.context_used = usage["totalTokens"]
        self.context_max = usage["maxTokens"]

    async def stop(self):
        await self.client.disconnect()

    async def watch_interrupt(self):
        while True:
            await asyncio.sleep(0.1)
            if self.interrupt:
                self.interrupt = False
                await self.client.interrupt()

    async def run(self, prompt: str) -> str:
        """Send one message and wait until the agent ends its turn. Returns its last reply."""
        self.interrupt = False
        self.history.append({"role": "user", "text": prompt})
        watcher = asyncio.create_task(self.watch_interrupt())
        await self.client.query(prompt)

        reply = ""
        # Where the last thing the agent said sits in the history: the final one is its reply,
        # which is added as the answer, so its activity copy is taken out again at the end.
        last_text_index = None
        async for message in self.client.receive_response():
            if isinstance(message, ResultMessage):
                usage = message.usage or {}
                self.tokens += usage.get("input_tokens", 0)
                self.tokens += usage.get("cache_creation_input_tokens", 0)
                self.tokens += usage.get("cache_read_input_tokens", 0)
                self.tokens += usage.get("output_tokens", 0)
                self.cost += message.total_cost_usd or 0
                reply = message.result or ""
                self.session_id = message.session_id
            # Tools only add activity lines when they work; failures are shown here.
            if isinstance(message, UserMessage) and isinstance(message.content, list):
                for block in message.content:
                    if not isinstance(block, ToolResultBlock) or not block.is_error:
                        continue
                    error = block.content
                    if isinstance(error, list):
                        error = " ".join(item.get("text", "") for item in error)
                    self.history.append({"role": "activity", "text": f"Failed: {error}"})
            if not isinstance(message, AssistantMessage):
                continue
            # Each reply's usage is the whole conversation it was given, plus what it wrote.
            if message.usage:
                self.context_used = message.usage.get("input_tokens", 0)
                self.context_used += message.usage.get("cache_creation_input_tokens", 0)
                self.context_used += message.usage.get("cache_read_input_tokens", 0)
                self.context_used += message.usage.get("output_tokens", 0)
            # Show everything as it happens: what it says between actions, and each action as it starts.
            for block in message.content:
                if isinstance(block, ThinkingBlock):
                    print(f"[thinking] {block.thinking}")
                if isinstance(block, ToolUseBlock):
                    print(f"[tool] {block.name} {block.input}")
                    if self.computer_tools is not None:
                        name = block.name.removeprefix(f"mcp__{TOOL_SERVER}__")
                        self.history.append({"role": "activity", "text": self.computer_tools.describe(name, block.input)})
                if isinstance(block, TextBlock):
                    print(block.text)
                    if block.text.strip():
                        self.history.append({"role": "activity", "text": block.text.strip()})
                        last_text_index = len(self.history) - 1

        watcher.cancel()
        if self.computer_tools is not None:
            self.computer_tools.end_turn()
        await self.read_context()
        if last_text_index is not None and self.history[last_text_index]["text"] == reply.strip():
            del self.history[last_text_index]
        self.history.append({"role": "assistant", "text": reply or "(stopped)"})
        return reply
