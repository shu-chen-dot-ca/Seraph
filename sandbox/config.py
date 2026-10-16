"""Sandbox settings, read from environment variables (and the .env file if present)."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class SandboxSettings:
    state_dir: Path  # Sandbox records and agent logs.
    image: str  # Incus image every VM starts from (sandbox/image/build.sh).
    profile: str  # Incus profile with the disk and network (sandbox/setup_host.sh).
    network: str  # Incus network the profile uses; the VM's address is looked up in it.
    cpus: int
    memory: str  # e.g. "8GiB"
    disk: str  # e.g. "40GiB"
    max_running: int  # VMs running at the same time.
    agent_model: str
    agent_max_turns: int


def load_sandbox_settings() -> SandboxSettings:
    # Values already set in the shell win over values in .env.
    load_dotenv()

    # The Claude Agent SDK reads CLAUDE_CODE_OAUTH_TOKEN itself. An empty value
    # would still count as "set", so drop it and let the SDK use the machine's login.
    if not os.getenv("CLAUDE_CODE_OAUTH_TOKEN", "").strip():
        os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)

    state_dir = Path(os.getenv("SANDBOX_STATE_DIR", ".sandboxes"))
    return SandboxSettings(
        state_dir=state_dir if state_dir.is_absolute() else PROJECT_ROOT / state_dir,
        image=os.getenv("SANDBOX_IMAGE", "sandbox-base"),
        profile=os.getenv("SANDBOX_PROFILE", "sandbox"),
        network=os.getenv("SANDBOX_NETWORK", "sandboxbr0"),
        cpus=int(os.getenv("SANDBOX_CPUS", "4")),
        memory=os.getenv("SANDBOX_MEMORY", "8GiB"),
        disk=os.getenv("SANDBOX_DISK", "40GiB"),
        max_running=int(os.getenv("SANDBOX_MAX_RUNNING", "4")),
        agent_model=os.getenv("SETUP_AGENT_MODEL") or os.getenv("CLAUDE_MODEL", "claude-opus-5-5"),
        agent_max_turns=int(os.getenv("SETUP_AGENT_MAX_TURNS", "200")),
    )
