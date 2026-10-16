"""All sessions: loads them from disk, creates and deletes them, cleans up leftovers.

The backend keeps one Sessions object. Every VM a session makes is named
<SANDBOX_VM_PREFIX><id>, so VMs without a session can be found and deleted.
Settings come from the project's .env.

    python -m sandbox.sessions create owner/name [memory_gb]
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
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.session import SESSIONS_DIR, Session, SessionError
from sandbox.vm import VM

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

VM_PREFIX = os.environ["SANDBOX_VM_PREFIX"]
MEMORY_GB_DEFAULT = int(os.environ["SANDBOX_MEMORY_GB_DEFAULT"])
MEMORY_GB_ALLOWED = [int(gb) for gb in os.environ["SANDBOX_MEMORY_GB_ALLOWED"].split(",")]


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

    def create(self, repo: str, memory_gb: int = MEMORY_GB_DEFAULT) -> Session:
        """Make the session and its VM. Slow (about a minute): run it in a background thread."""
        if memory_gb not in MEMORY_GB_ALLOWED:
            raise SessionError(f"memory_gb must be one of {MEMORY_GB_ALLOWED}")
        session_id = secrets.token_hex(4)
        session = Session(
            {
                "id": session_id,
                "repo": repo,
                "vm": VM_PREFIX + session_id,
                "memory_gb": memory_gb,
                "status": "creating",
                "created_at": datetime.now(UTC).isoformat(),
            }
        )
        with self.lock:
            self.sessions[session.id] = session
        try:
            session.create()
        except Exception:
            # create() removed the folder if no VM was made; then forget the session too.
            if not session.folder.exists():
                with self.lock:
                    self.sessions.pop(session.id, None)
            raise
        return session

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
        session = sessions.create(sys.argv[2], memory_gb)
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
