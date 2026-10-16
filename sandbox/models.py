"""Data shapes of the sandbox feature, shared by the manager, the backend and the frontend.

The frontend has a copy of these in frontend/src/sandbox/types.ts. Keep the two in sync.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

# creating    the VM is created and boots, the repo is cloned
# setting_up  the setup agent is working on the first setup
# ready       the agent reported a working demo
# failed      the setup failed or was interrupted; the VM is kept, so you can ask the agent to try again
# stopping    the VM shuts down
# stopped     the VM is shut down; starting it brings back ready or failed
# starting    a stopped VM boots again
SandboxStatus = Literal["creating", "setting_up", "ready", "failed", "stopping", "stopped", "starting"]


class Sandbox(BaseModel):
    """One repo set up in its own VM."""

    id: str  # Also the VM's name, e.g. "sb-1a2b3c4d".
    repo: str  # "owner/name"
    created_at: datetime
    checkout: str | None = None  # What was cloned: "<branch> at <commit> <subject>".
    status: SandboxStatus
    detail: str = ""  # What is happening now, or what went wrong.
    outcome: Literal["ready", "failed"] | None = None  # How the setup ended; None while it runs.
    agent_running: bool = False  # The setup agent is working: the first setup or a follow-up message.
    summary: str | None = None  # The agent's report (Markdown): what runs, how, what doesn't work.
    app_port: int | None = None  # The demo's port inside the VM, once the agent started it.
    app_path: str = "/"  # The page the preview opens.
    session_id: str | None = None  # The agent's conversation, to continue it with follow-up messages.
    # Addresses for the user's browser, through the backend's preview proxy. Filled in by the manager.
    preview_url: str | None = None
    editor_url: str | None = None
    terminal_url: str | None = None


# status       a step of the sandbox's life ("Cloning the repo", "Setup finished")
# user         a message the user sent to the agent
# assistant    text the agent wrote
# tool_call    the agent called a tool; `text` says what it does (e.g. the command)
# tool_output  output of the running tool so far (long commands stream it)
# tool_result  the tool's result as the agent saw it
# error        something failed outside the agent's tools
EventKind = Literal["status", "user", "assistant", "tool_call", "tool_output", "tool_result", "error"]


class SandboxEvent(BaseModel):
    """One entry of a sandbox's activity log. The UI shows them in order."""

    seq: int  # 1, 2, 3, ... per sandbox.
    time: datetime
    kind: EventKind
    text: str = ""
    tool: str | None = None  # For tool_call, tool_output and tool_result: the tool's name.
    call_id: str | None = None  # For tool_call and tool_result: pairs a result with its call.
    is_error: bool = False  # For tool_result: the tool reported an error.
