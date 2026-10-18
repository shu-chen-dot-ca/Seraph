"""All sessions: loads them from disk, creates and deletes them, cleans up leftovers.

The backend keeps one Sessions object. Every VM a session makes is named
<SANDBOX_VM_PREFIX><id>. Incus is the truth: a session VM without a record
(e.g. sessions/ was deleted) gets a new one, so it shows up and can be opened
or deleted. It is looked for at start and every SCAN_SECONDS.
Settings come from the project's .env.

    python -m sandbox.sessions create owner/name [memory_gb]     # owner/name may be "" for no repo
    python -m sandbox.sessions list
    python -m sandbox.sessions start <id>
    python -m sandbox.sessions stop <id>
    python -m sandbox.sessions delete <id>
    python -m sandbox.sessions clean      # delete sessions without a VM and stray folders
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.session import MIN_FREE_RAM_GB, SESSIONS_DIR, Session, SessionError

# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

VM_PREFIX = os.environ["SANDBOX_VM_PREFIX"]
CPUS_DEFAULT = int(os.environ["SANDBOX_CPUS_DEFAULT"])
CPUS_ALLOWED = [int(cpus) for cpus in os.environ["SANDBOX_CPUS_ALLOWED"].split(",")]
MEMORY_GB_DEFAULT = int(os.environ["SANDBOX_MEMORY_GB_DEFAULT"])
MEMORY_GB_ALLOWED = [int(gb) for gb in os.environ["SANDBOX_MEMORY_GB_ALLOWED"].split(",")]
DISK_GB_DEFAULT = int(os.environ["SANDBOX_DISK_GB_DEFAULT"])
DISK_GB_MIN = int(os.environ["SANDBOX_DISK_GB_MIN"])
DISK_GB_MAX = int(os.environ["SANDBOX_DISK_GB_MAX"])
# The VM that builds the image has the same prefix but is not a session.
BUILD_VM = os.environ["SANDBOX_BUILD_VM"]
SCAN_SECONDS = 10


class Sessions:
    def __init__(self):
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()  # Guards self.sessions.
        for record in sorted(SESSIONS_DIR.glob("*/session.json")):
            session = Session(json.loads(record.read_text()))
            session.refresh()
            self.sessions[session.id] = session
            threading.Thread(target=self.watch, args=(session,), daemon=True).start()
        self.find_orphans()
        threading.Thread(target=self.scan, daemon=True).start()

    def scan(self) -> None:
        """Look for session VMs without a record every SCAN_SECONDS, for as long as the backend runs."""
        while True:
            time.sleep(SCAN_SECONDS)
            try:
                self.find_orphans()
            except Exception:
                pass

    def find_orphans(self) -> None:
        """Give every session VM in Incus that has no session a new record, so it shows up again.

        What Incus knows comes back (CPUs, memory, disk, internet, autostart, when it was
        made). The repo, the shown name and the env variables are lost: repo is empty,
        the name is the VM's name, env is empty.
        """
        for name in self.list_vms():
            with self.lock:
                pointed_to = [session.vm.name for session in self.sessions.values()]
            if name in pointed_to:
                continue
            result = subprocess.run(
                ["incus", "query", f"/1.0/instances/{name}"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                text=True,
            )
            if result.returncode != 0:
                continue  # Deleted in the meantime.
            instance = json.loads(result.stdout)
            config = instance["config"]
            memory = config.get("limits.memory", "")
            disk = instance["expanded_devices"].get("root", {}).get("size", "")
            session = Session(
                {
                    "id": name[len(VM_PREFIX):],
                    "name": name,
                    "repo": "",
                    "vm": name,
                    "cpus": int(config.get("limits.cpu", CPUS_DEFAULT)),
                    "memory_gb": int(memory.removesuffix("GiB")) if memory.endswith("GiB") else MEMORY_GB_DEFAULT,
                    "disk_gb": int(disk.removesuffix("GiB")) if disk.endswith("GiB") else DISK_GB_DEFAULT,
                    # The offline ACL sits on the VM's own eth0 card (see VM.set_internet).
                    "internet": "security.acls" not in instance["devices"].get("eth0", {}),
                    "autostart": config.get("boot.autostart") == "true",
                    "status": "stopped",
                    "created_at": instance["created_at"],
                }
            )
            session.refresh()
            session.log("Found this VM without a record, so it got a new one")
            with self.lock:
                self.sessions[session.id] = session
            threading.Thread(target=self.watch, args=(session,), daemon=True).start()

    def watch(self, session: Session) -> None:
        """Keep session.latest_usage fresh, about once a second, until the session is gone.

        One thread per session, so a slow VM never holds up the others.
        """
        while session.id in self.sessions:
            try:
                session.latest_usage = session.usage()
                # Shut down from inside (the desktop's power menu, `sudo poweroff`): say so,
                # so the UI offers Start instead of waiting for a desktop that isn't coming.
                if not session.latest_usage["on"] and session.status == "running" and not session.lock.locked():
                    session.status = "stopped"
                    session.save()
                    session.log("The VM was turned off from inside")
            except Exception:
                pass  # Incus hiccup; try again next round.
            time.sleep(1)

    def options(self) -> dict:
        """What the create dialog may offer, and what it starts with."""
        return {
            "cpus": CPUS_ALLOWED,
            "cpus_default": CPUS_DEFAULT,
            "memory_gb": MEMORY_GB_ALLOWED,
            "memory_gb_default": MEMORY_GB_DEFAULT,
            "disk_gb_min": DISK_GB_MIN,
            "disk_gb_max": DISK_GB_MAX,
            "disk_gb_default": DISK_GB_DEFAULT,
        }

    def create(
        self,
        repo: str,
        name: str = "",
        cpus: int = CPUS_DEFAULT,
        memory_gb: int = MEMORY_GB_DEFAULT,
        disk_gb: int = DISK_GB_DEFAULT,
        background: bool = False,
    ) -> Session:
        """Make a session with its own VM (about a minute).

        repo is "owner/name" or "" (no clone). name is only for showing. The VM's
        Incus name is always <VM_PREFIX><id>. With background=True this returns right
        away with status "creating"; the list shows how it goes.
        """
        if cpus not in CPUS_ALLOWED:
            raise SessionError(f"cpus must be one of {CPUS_ALLOWED}")
        if memory_gb not in MEMORY_GB_ALLOWED:
            raise SessionError(f"memory_gb must be one of {MEMORY_GB_ALLOWED}")
        if disk_gb < DISK_GB_MIN or disk_gb > DISK_GB_MAX:
            raise SessionError(f"The disk must be {DISK_GB_MIN} to {DISK_GB_MAX} GB")

        # VMs that are still being created haven't taken their memory yet, so count it here.
        with self.lock:
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            for session in self.sessions.values():
                if session.status == "creating":
                    free_gb -= session.memory_gb
            if free_gb - memory_gb < MIN_FREE_RAM_GB:
                raise SessionError(
                    f"Not enough free memory: {max(free_gb, 0):.1f}GB free, the VM needs {memory_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )

            session_id = secrets.token_hex(4)
            vm = VM_PREFIX + session_id
            session = Session(
                {
                    "id": session_id,
                    "name": name or vm,
                    "repo": repo,
                    "vm": vm,
                    "cpus": cpus,
                    "memory_gb": memory_gb,
                    "disk_gb": disk_gb,
                    "status": "creating",
                    "created_at": datetime.now(UTC).isoformat(),
                }
            )
            self.sessions[session.id] = session
            threading.Thread(target=self.watch, args=(session,), daemon=True).start()

        if background:
            threading.Thread(target=self.run_create, args=(session,), daemon=True).start()
        else:
            self.run_create(session)
        return session

    def run_create(self, session: Session) -> None:
        try:
            session.create()
        except Exception:
            # create() removed the folder if no VM was made; then forget the session too.
            if not session.folder.exists():
                with self.lock:
                    self.sessions.pop(session.id, None)
            raise

    def set_resources(self, session_id: str, cpus: int, memory_gb: int) -> None:
        if cpus not in CPUS_ALLOWED:
            raise SessionError(f"cpus must be one of {CPUS_ALLOWED}")
        if memory_gb not in MEMORY_GB_ALLOWED:
            raise SessionError(f"memory_gb must be one of {MEMORY_GB_ALLOWED}")
        self.get(session_id).set_resources(cpus, memory_gb)

    def start_in_background(self, session_id: str) -> None:
        """Start a stopped VM (takes a while); the list shows "starting" until it is up."""
        session = self.get(session_id)
        if session.lock.locked():
            raise SessionError(f"Session {session_id} is busy")
        threading.Thread(target=session.start, daemon=True).start()

    def stop_in_background(self, session_id: str) -> None:
        """Shut a VM down (up to a minute); the list shows "stopping" until it is off."""
        session = self.get(session_id)
        if session.lock.locked():
            raise SessionError(f"Session {session_id} is busy")
        threading.Thread(target=session.stop, daemon=True).start()

    def get(self, session_id: str) -> Session:
        session = self.sessions.get(session_id)
        if session is None:
            raise SessionError(f"No session {session_id}")
        return session

    def list(self) -> list[Session]:
        with self.lock:
            return list(self.sessions.values())

    def delete(self, session_id: str) -> None:
        self.get(session_id).delete()
        with self.lock:
            self.sessions.pop(session_id, None)

    def list_vms(self) -> list[str]:
        """Names of all session VMs in Incus, running or stopped (not the image builder)."""
        result = subprocess.run(
            ["incus", "list", "--format", "csv", "--columns", "n"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
            check=True,
        )
        vms = []
        for name in result.stdout.split():
            if name.startswith(VM_PREFIX) and name != BUILD_VM:
                vms.append(name)
        return vms

    def clean(self) -> None:
        """Delete sessions whose VM is gone, and stray folders.

        VMs without a session can't be left over: they get a record when Sessions starts
        (find_orphans), so they show up and are deleted like any session.
        Sessions in the middle of an action (create, start, ...) are left alone.
        """
        sessions = self.list()
        for session in sessions:
            if session.lock.locked():
                continue
            if session.vm.status() is None:
                print(f"Deleting session without a VM: {session.id}")
                shutil.rmtree(session.folder, ignore_errors=True)
                with self.lock:
                    self.sessions.pop(session.id, None)

        if not SESSIONS_DIR.exists():
            return
        for folder in SESSIONS_DIR.iterdir():
            if folder.name not in self.sessions:
                print(f"Deleting folder that is not a session: {folder.name}")
                shutil.rmtree(folder, ignore_errors=True)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    command = sys.argv[1]
    sessions = Sessions()

    if command == "create" and len(sys.argv) in (3, 4):
        memory_gb = MEMORY_GB_DEFAULT
        if len(sys.argv) == 4:
            memory_gb = int(sys.argv[3])
        session = sessions.create(sys.argv[2], memory_gb=memory_gb)
        print(f"Created session {session.id} (VM {session.vm.name})")
    elif command == "list":
        for session in sessions.list():
            print(f"{session.id}  {session.repo}  {session.vm.name}  {session.memory_gb}GB  {session.status}")
        print(f"Session VMs in Incus: {', '.join(sessions.list_vms()) or 'none'}")
    elif command == "start" and len(sys.argv) == 3:
        sessions.get(sys.argv[2]).start()
        print(f"Started session {sys.argv[2]}")
    elif command == "stop" and len(sys.argv) == 3:
        sessions.get(sys.argv[2]).stop()
        print(f"Stopped session {sys.argv[2]}")
    elif command == "delete" and len(sys.argv) == 3:
        sessions.delete(sys.argv[2])
        print(f"Deleted session {sys.argv[2]}")
    elif command == "clean":
        sessions.clean()
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
