"""All sessions: loads them from disk, creates and deletes them, cleans up leftovers.

The backend keeps one Sessions object. Every VM a session makes is named
<SANDBOX_VM_PREFIX><id>, so VMs without a session can be found and deleted.
Settings come from the project's .env.

    python -m sandbox.sessions create owner/name [memory_gb]     # owner/name may be "" for no repo
    python -m sandbox.sessions list
    python -m sandbox.sessions start <id>
    python -m sandbox.sessions stop <id>
    python -m sandbox.sessions delete <id>
    python -m sandbox.sessions clean      # delete VMs without a session and sessions without a VM
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
from sandbox.vm import VM

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VM_PREFIX = os.environ["SANDBOX_VM_PREFIX"]
CPUS_DEFAULT = int(os.environ["SANDBOX_CPUS_DEFAULT"])
CPUS_ALLOWED = [int(cpus) for cpus in os.environ["SANDBOX_CPUS_ALLOWED"].split(",")]
MEMORY_GB_DEFAULT = int(os.environ["SANDBOX_MEMORY_GB_DEFAULT"])
MEMORY_GB_ALLOWED = [int(gb) for gb in os.environ["SANDBOX_MEMORY_GB_ALLOWED"].split(",")]
DISK_GB_DEFAULT = int(os.environ["SANDBOX_DISK_GB_DEFAULT"])
DISK_GB_ALLOWED = [int(gb) for gb in os.environ["SANDBOX_DISK_GB_ALLOWED"].split(",")]
CREATE_COUNT_MAX = int(os.environ["SANDBOX_CREATE_COUNT_MAX"])


class Sessions:
    def __init__(self):
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()  # Guards self.sessions.
        if not SESSIONS_DIR.exists():
            return
        for record in sorted(SESSIONS_DIR.glob("*/session.json")):
            session = Session(json.loads(record.read_text()))
            session.refresh()
            self.sessions[session.id] = session
            threading.Thread(target=self.watch, args=(session,), daemon=True).start()

    def watch(self, session: Session) -> None:
        """Keep session.latest_usage fresh, about once a second, until the session is gone.

        One thread per session, so a slow VM never holds up the others.
        """
        while session.id in self.sessions:
            try:
                session.latest_usage = session.usage()
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
            "disk_gb": DISK_GB_ALLOWED,
            "disk_gb_default": DISK_GB_DEFAULT,
            "count_max": CREATE_COUNT_MAX,
        }

    def create(
        self,
        repo: str,
        name: str = "",
        cpus: int = CPUS_DEFAULT,
        memory_gb: int = MEMORY_GB_DEFAULT,
        disk_gb: int = DISK_GB_DEFAULT,
        count: int = 1,
        background: bool = False,
    ) -> list[Session]:
        """Make `count` sessions, each with its own VM (about a minute each).

        repo is "owner/name" or "" (no clone). name is only for showing; with
        count > 1 the sessions are "<name>-1", "<name>-2", ... The VM's Incus name
        is always <VM_PREFIX><id>. With background=True this returns right away
        with status "creating"; the list shows how it goes.
        """
        if cpus not in CPUS_ALLOWED:
            raise SessionError(f"cpus must be one of {CPUS_ALLOWED}")
        if memory_gb not in MEMORY_GB_ALLOWED:
            raise SessionError(f"memory_gb must be one of {MEMORY_GB_ALLOWED}")
        if disk_gb not in DISK_GB_ALLOWED:
            raise SessionError(f"disk_gb must be one of {DISK_GB_ALLOWED}")
        if count < 1 or count > CREATE_COUNT_MAX:
            raise SessionError(f"count must be 1 to {CREATE_COUNT_MAX}")

        # VMs that are still being created haven't taken their memory yet, so count it here.
        with self.lock:
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            for session in self.sessions.values():
                if session.status == "creating":
                    free_gb -= session.memory_gb
            needed_gb = memory_gb * count
            if free_gb - needed_gb < MIN_FREE_RAM_GB:
                raise SessionError(
                    f"Not enough free memory: {max(free_gb, 0):.1f}GB free, {count} VM(s) need {needed_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )

            created = []
            for number in range(1, count + 1):
                session_id = secrets.token_hex(4)
                vm = VM_PREFIX + session_id
                shown_name = name or vm
                if name and count > 1:
                    shown_name = f"{name}-{number}"
                session = Session(
                    {
                        "id": session_id,
                        "name": shown_name,
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
                created.append(session)
                threading.Thread(target=self.watch, args=(session,), daemon=True).start()

        for session in created:
            if background:
                threading.Thread(target=self.run_create, args=(session,), daemon=True).start()
            else:
                self.run_create(session)
        return created

    def run_create(self, session: Session) -> None:
        try:
            session.create()
        except Exception:
            # create() removed the folder if no VM was made; then forget the session too.
            if not session.folder.exists():
                with self.lock:
                    self.sessions.pop(session.id, None)
            raise

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
        """Names of all session VMs in Incus, running or stopped."""
        result = subprocess.run(
            ["incus", "list", "--format", "csv", "--columns", "n"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
            check=True,
        )
        vms = []
        for name in result.stdout.split():
            if name.startswith(VM_PREFIX):
                vms.append(name)
        return vms

    def clean(self) -> None:
        """Delete VMs no session points to, sessions whose VM is gone, and stray folders.

        Sessions in the middle of an action (create, start, ...) are left alone.
        """
        sessions = self.list()
        pointed_to = []
        for session in sessions:
            pointed_to.append(session.vm.name)

        for name in self.list_vms():
            if name not in pointed_to:
                print(f"Deleting VM without a session: {name}")
                VM(name).delete()

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
        session = sessions.create(sys.argv[2], memory_gb=memory_gb)[0]
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
