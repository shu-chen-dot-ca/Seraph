"""One session: one repo, one VM, and the agents that work on that VM.

On disk, in SANDBOX_SESSIONS_DIR:

    <id>/session.json              {"id", "name", "repo", "vm", "cpus", "memory_gb", "disk_gb",
                                    "internet", "env", "autostart", "status", "created_at"}
    <id>/events.jsonl              lifecycle log, one {"time", "text"} per line
    <id>/agents/<aid>/agent.json   {"id", "session_id", "task", "status", "claude_session_id", "history", "created_at"}

The VM lives in Incus; "vm" in session.json points to it. "name" is only for
showing; "repo" may be empty (then nothing is cloned). An agent belongs to
exactly one session, so it only ever acts on that session's VM.

Status: creating -> running -> stopping -> stopped -> starting -> running, or failed.
"missing" means the VM is gone.
Only one lifecycle action runs on a session at a time; a second one gets SessionBusyError.
"""

import json
import os
import re
import secrets
import shlex
import shutil
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.vm import VM

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

SESSIONS_DIR = PROJECT_ROOT / os.environ["SANDBOX_SESSIONS_DIR"]
IMAGE = os.environ["SANDBOX_IMAGE"]
PROFILE = os.environ["SANDBOX_PROFILE"]
DISK_GB_DEFAULT = int(os.environ["SANDBOX_DISK_GB_DEFAULT"])
MIN_FREE_RAM_GB = int(os.environ["SANDBOX_MIN_FREE_RAM_GB"])
PROJECT_DIR = os.environ["SANDBOX_VM_PROJECT_DIR"]
OFFLINE_ACL = os.environ["SANDBOX_OFFLINE_ACL"]
VM_ENV_FILE = os.environ["SANDBOX_VM_ENV_FILE"]


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
        # Settings. Records from before settings existed have none: use the defaults.
        self.internet = record.get("internet", True)
        self.env = record.get("env", {})
        self.autostart = record.get("autostart", False)
        self.status = record["status"]
        self.created_at = record["created_at"]
        self.folder = SESSIONS_DIR / self.id
        self.lock = threading.Lock()
        # The last CPU reading (nanoseconds used, time read), to work out CPU % between two reads.
        self.last_cpu: tuple[int, float] | None = None
        # The latest usage(), kept fresh by Sessions' watcher thread. Reading it never waits
        # on Incus, which can take seconds for a VM whose guest has hung.
        self.latest_usage = {"on": False, "cpu_percent": None, "memory_used_gb": None}
        # Who locked the human's mouse and keyboard out of the desktop: "user", "agent" or None.
        # Only kept while the backend runs; the page shows it and covers the desktop.
        self.locked_by: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "repo": self.repo,
            "vm": self.vm.name,
            "cpus": self.cpus,
            "memory_gb": self.memory_gb,
            "disk_gb": self.disk_gb,
            "internet": self.internet,
            "env": self.env,
            "autostart": self.autostart,
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
            self.write_env()
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
            self.status = "starting"
            self.save()
            self.log("Starting")
            self.vm.start()
            self.vm.wait_ready()
            self.write_env()
            self.status = "running"
            self.save()
            self.log("Started")
        except Exception as error:
            self.status = "running" if self.vm.status() == "Running" else "stopped"
            self.save()
            self.log(f"Start failed: {error}")
            raise
        finally:
            self.lock.release()

    def stop(self) -> None:
        """Shut the VM down. Its disk is kept, so start() brings it back."""
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError(f"Session {self.id} is busy")
        try:
            # Later: stop this session's running agents first.
            self.status = "stopping"
            self.save()
            self.log("Stopping")
            self.vm.stop()
            self.status = "stopped"
            self.save()
            self.log("Stopped")
        except Exception as error:
            self.status = "running" if self.vm.status() == "Running" else "stopped"
            self.save()
            self.log(f"Stop failed: {error}")
            raise
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

    # --- Settings ----------------------------------------------------------------

    def set_internet(self, enabled: bool) -> None:
        """Turn the VM's internet on or off. Applies right away, running or not."""
        self.vm.set_internet(enabled, OFFLINE_ACL)
        self.internet = enabled
        self.save()
        self.log(f"Internet {'on' if enabled else 'off'}")

    def set_env(self, env: dict[str, str]) -> None:
        """Environment variables for everything in the VM: terminals, desktop, the agent.

        Shells started after this see them (desktop terminals too, through ~/.bashrc);
        ones already open keep the old values.
        A stopped VM gets them when it starts.
        """
        for key in env:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise SessionError(f"Not a valid variable name: {key}")
        self.env = env
        self.save()
        if self.vm.status() == "Running":
            self.write_env()
        self.log(f"Environment variables set: {', '.join(env) or 'none'}")

    def write_env(self) -> None:
        """Put the variables in the VM (it must be running).

        They go in VM_ENV_FILE, which login shells read (the browser terminals, the agent).
        Terminals opened on the desktop are not login shells and only read ~/.bashrc,
        so ~/.bashrc gets a line that reads the file too (once).
        """
        self.vm.write_file(VM_ENV_FILE, self.env_file())
        line = f"[ -f {VM_ENV_FILE} ] && . {VM_ENV_FILE}  # sandbox environment variables"
        result = self.vm.exec(f"grep -qxF {shlex.quote(line)} ~/.bashrc || echo {shlex.quote(line)} >> ~/.bashrc", timeout=30)
        if result.returncode != 0:
            raise SessionError(f"Could not add the variables to ~/.bashrc: {result.stderr.strip()}")

    def env_file(self) -> str:
        lines = ["# Set in the session's Settings tab. Rewritten whenever they change."]
        for key, value in self.env.items():
            lines.append(f"export {key}={shlex.quote(value)}")
        return "\n".join(lines) + "\n"

    def set_autostart(self, enabled: bool) -> None:
        """Start the VM when this computer starts."""
        self.vm.set_config("boot.autostart", "true" if enabled else "false")
        self.autostart = enabled
        self.save()
        self.log(f"Start with this computer: {'on' if enabled else 'off'}")

    def set_resources(self, cpus: int, memory_gb: int) -> None:
        """Change CPU and memory. Only while the VM is off; they apply when it starts."""
        if not self.lock.acquire(blocking=False):
            raise SessionBusyError(f"Session {self.id} is busy")
        try:
            if self.vm.status() == "Running":
                raise SessionError("Stop the VM first; CPU and memory change while it is off.")
            self.vm.set_config("limits.cpu", str(cpus))
            self.vm.set_config("limits.memory", f"{memory_gb}GiB")
            self.cpus = cpus
            self.memory_gb = memory_gb
            self.save()
            self.log(f"Resources: {cpus} CPUs, {memory_gb}GB memory")
        finally:
            self.lock.release()

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
            "history": [],
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

    def chat_agent(self) -> dict:
        """The record of the agent the Agent tab chats with: the first one, made if there is none."""
        agents = self.list_agents()
        if agents:
            return agents[0]
        return self.add_agent("chat")

    def save_agent(self, agent: dict) -> None:
        folder = self.folder / "agents" / agent["id"]
        folder.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a record.
        temporary = folder / "agent.json.tmp"
        temporary.write_text(json.dumps(agent, indent=2))
        temporary.replace(folder / "agent.json")

    def remove_agent(self, agent_id: str) -> None:
        # Later: stop the agent first if it is running.
        shutil.rmtree(self.folder / "agents" / agent_id, ignore_errors=True)
        self.log(f"Removed agent {agent_id}")
