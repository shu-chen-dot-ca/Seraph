"""A bare agent: one Claude conversation that only talks, for now.

Starting point for the agents that work on a sandbox VM. It has none of Claude
Code's built-in tools (no shell, files or web on this machine). Given a VM, it
gets the computer use tools (tools.py): screenshots, mouse, keyboard and a
shell, all inside that VM. Without one it only talks.

    agent = Agent(vm=session.vm)
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
from sandbox.vm import VM

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

SYSTEM_PROMPT = (Path(__file__).parent / "prompt.md").read_text()
MODEL = os.environ["CLAUDE_MODEL"]
MAX_TURNS = int(os.environ["AGENT_MAX_TURNS"])
# Tools are served by an in-process MCP server with this name; their full names are mcp__<name>__<tool>.
TOOL_SERVER = "agent"


class Agent:
    def __init__(self, session_id: str | None = None, history: list | None = None, vm: VM | None = None):
        self.tokens = 0
        self.cost = 0.0
        self.interrupt = False
        # The Claude conversation to continue (None: a new one). Set after each run.
        self.session_id = session_id
        # What the user sees: {"role": "user" | "assistant" | "activity", "text": ...}
        self.history = history or []

        # Without a VM it only talks.
        tools = []
        if vm is not None:
            tools = ComputerTools(Computer(vm), self.history).list()
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
                max_turns=MAX_TURNS,
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
            for block in message.content:
                if isinstance(block, ThinkingBlock):
                    print(f"[thinking] {block.thinking}")
                if isinstance(block, ToolUseBlock):
                    print(f"[tool] {block.name} {block.input}")
                if isinstance(block, TextBlock):
                    print(block.text)

        watcher.cancel()
        self.history.append({"role": "assistant", "text": reply or "(stopped)"})
        return reply
