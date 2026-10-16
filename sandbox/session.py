"""One session: one repo, one VM, and the agents that work on that VM.

On disk, in SANDBOX_SESSIONS_DIR:

    <id>/session.json              {"id", "name", "repo", "vm", "cpus", "memory_gb", "disk_gb", "status", "created_at"}
    <id>/events.jsonl              lifecycle log, one {"time", "text"} per line
    <id>/agents/<aid>/agent.json   {"id", "session_id", "task", "status", "claude_session_id", "created_at"}

The VM lives in Incus; "vm" in session.json points to it. "name" is only for
showing; "repo" may be empty (then nothing is cloned). An agent belongs to
exactly one session, so it only ever acts on that session's VM.

Status: creating -> running <-> stopped, or failed. "missing" means the VM is gone.
Only one lifecycle action runs on a session at a time; a second one gets SessionBusyError.
"""

import json
import os
import secrets
import shutil
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.vm import VM

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SESSIONS_DIR = PROJECT_ROOT / os.environ["SANDBOX_SESSIONS_DIR"]
IMAGE = os.environ["SANDBOX_IMAGE"]
PROFILE = os.environ["SANDBOX_PROFILE"]
DISK_GB_DEFAULT = int(os.environ["SANDBOX_DISK_GB_DEFAULT"])
MIN_FREE_RAM_GB = int(os.environ["SANDBOX_MIN_FREE_RAM_GB"])
PROJECT_DIR = os.environ["SANDBOX_VM_PROJECT_DIR"]


class SessionError(Exception):
    pass


class SessionBusyError(SessionError):
    pass


class Session:
    def __init__(self, record: dict):
        self.id = record["id"]
        self.name = record["name"]
        self.repo = record["repo"]
        self.vm = VM(record["vm"])
        self.cpus = record["cpus"]
        self.memory_gb = record["memory_gb"]
        # Records from before disks could be picked have no disk_gb.
        self.disk_gb = record.get("disk_gb", DISK_GB_DEFAULT)
        self.status = record["status"]
        self.created_at = record["created_at"]
        self.folder = SESSIONS_DIR / self.id
        self.lock = threading.Lock()
        # The last CPU reading (nanoseconds used, time read), to work out CPU % between two reads.
        self.last_cpu: tuple[int, float] | None = None
        # The latest usage(), kept fresh by Sessions' watcher thread. Reading it never waits
        # on Incus, which can take seconds for a VM whose guest has hung.
        self.latest_usage = {"on": False, "cpu_percent": None, "memory_used_gb": None}

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "repo": self.repo,
            "vm": self.vm.name,
            "cpus": self.cpus,
            "memory_gb": self.memory_gb,
            "disk_gb": self.disk_gb,
            "status": self.status,
            "created_at": self.created_at,
        }

    def save(self) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a record.
        temporary = self.folder / "session.json.tmp"
        temporary.write_text(json.dumps(self.to_dict(), indent=2))
        temporary.replace(self.folder / "session.json")

    def log(self, text: str) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        event = {"time": datetime.now(UTC).isoformat(), "text": text}
        with (self.folder / "events.jsonl").open("a") as file:
            file.write(json.dumps(event) + "\n")

    # --- Lifecycle -------------------------------------------------------------

    def create(self) -> None:
        """Launch the VM, wait until it is ready, clone the repo (if there is one)."""
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError(f"Session {self.id} is busy")
        try:
            # Keep MIN_FREE_RAM_GB free for this machine after the VM takes its memory.
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            if free_gb - self.memory_gb < MIN_FREE_RAM_GB:
                raise SessionError(
                    f"Not enough free memory: {free_gb:.1f}GB free, the VM needs {self.memory_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )
            self.status = "creating"
            self.save()
            self.log(f"Creating VM {self.vm.name}")
            self.vm.launch(IMAGE, PROFILE, self.cpus, self.memory_gb, f"{self.disk_gb}GiB")
            self.log("Waiting for the VM to be ready")
            self.vm.wait_ready()
            if self.repo:
                self.log(f"Cloning {self.repo}")
                self.vm.clone(f"https://github.com/{self.repo}.git", PROJECT_DIR)
            self.status = "running"
            self.save()
            self.log("Ready")
        except Exception as error:
            # No VM was made: leave nothing behind.
            if self.vm.status() is None:
                shutil.rmtree(self.folder, ignore_errors=True)
                raise
            # The VM exists but setup failed: keep it, so it can be looked at or deleted.
            self.status = "failed"
            self.save()
            self.log(f"Failed: {error}")
            raise
        finally:
            self.lock.release()

    def start(self) -> None:
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError(f"Session {self.id} is busy")
        try:
            if self.vm.status() == "Running":
                return
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            if free_gb - self.memory_gb < MIN_FREE_RAM_GB:
                raise SessionError(
                    f"Not enough free memory: {free_gb:.1f}GB free, the VM needs {self.memory_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )
            self.log("Starting")
            self.vm.start()
            self.vm.wait_ready()
            self.status = "running"
            self.save()
            self.log("Started")
        finally:
            self.lock.release()

    def stop(self) -> None:
        """Shut the VM down. Its disk is kept, so start() brings it back."""
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError(f"Session {self.id} is busy")
        try:
            # Later: stop this session's running agents first.
            self.log("Stopping")
            self.vm.stop()
            self.status = "stopped"
            self.save()
            self.log("Stopped")
        finally:
            self.lock.release()

    def delete(self) -> None:
        """Delete the VM, then the folder (agents and their history go with it)."""
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError(f"Session {self.id} is busy")
        try:
            # Later: stop this session's running agents first.
            self.vm.delete()
            shutil.rmtree(self.folder, ignore_errors=True)
        finally:
            self.lock.release()

    def usage(self) -> dict:
        """Whether the VM is on, and its CPU % and memory in use right now.

        CPU % is measured between two calls, so the first call after a start has none.
        """
        state = self.vm.state()
        if state is None or state["status"] != "Running":
            self.last_cpu = None
            return {"on": False, "cpu_percent": None, "memory_used_gb": None}

        now = time.monotonic()
        cpu_ns = state["cpu"]["usage"]
        cpu_percent = None
        if self.last_cpu is not None and now > self.last_cpu[1]:
            seconds = now - self.last_cpu[1]
            cpu_percent = (cpu_ns - self.last_cpu[0]) / (seconds * 1e9 * self.cpus) * 100
            cpu_percent = max(0.0, min(100.0, cpu_percent))
        self.last_cpu = (cpu_ns, now)
        memory_used_gb = state["memory"]["usage"] / 1024**3
        return {"on": True, "cpu_percent": cpu_percent, "memory_used_gb": memory_used_gb}

    def refresh(self) -> None:
        """Make the status match what Incus says (after a restart or a crash)."""
        vm_status = self.vm.status()
        if vm_status is None:
            self.status = "missing"
        elif self.status in ("creating", "failed"):
            # A create that didn't finish (e.g. the backend stopped mid-way) stays failed.
            self.status = "failed"
        elif vm_status == "Running":
            self.status = "running"
        else:
            self.status = "stopped"
        self.save()

    # --- Agents (records only; running them comes with the agent stage) --------

    def add_agent(self, task: str) -> dict:
        agent = {
            "id": secrets.token_hex(3),
            "session_id": self.id,
            "task": task,
            "status": "idle",
            "claude_session_id": None,
            "created_at": datetime.now(UTC).isoformat(),
        }
        folder = self.folder / "agents" / agent["id"]
        folder.mkdir(parents=True)
        (folder / "agent.json").write_text(json.dumps(agent, indent=2))
        self.log(f"Added agent {agent['id']}")
        return agent

    def list_agents(self) -> list[dict]:
        agents = []
        for record in sorted((self.folder / "agents").glob("*/agent.json")):
            agents.append(json.loads(record.read_text()))
        return agents

    def remove_agent(self, agent_id: str) -> None:
        # Later: stop the agent first if it is running.
        shutil.rmtree(self.folder / "agents" / agent_id, ignore_errors=True)
        self.log(f"Removed agent {agent_id}")
