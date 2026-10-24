"""Repos the user rejected: Explore doesn't find them again for BLOCK_DAYS, and agents can't add them back meanwhile.

One JSON file, DATA_DIR/rejections.json, by repo (owner/name):

    {"owner/name": {"until": iso, "history": [{"at": iso}, ...]}, ...}

Rejecting removes the repo from the Repos list (backend/repos_api.py) and blocks it until `until`. After
that it may be found again; the history stays for good, so the Repos page can say it was rejected before.
Allow again (the Explore page) ends a block early and keeps the history too.

Kept apart from the Repos list: undoing the removal brings the repo back, but the rejection stands.
version goes up by one on every change, like the other stores.
"""

import copy
import json
import os
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
BLOCK_DAYS = 14


class Rejections:
    def __init__(self):
        self.path = DATA_DIR / "rejections.json"
        self.lock = threading.Lock()
        self.version = 0
        self.rejections = {}
        if self.path.exists():
            self.rejections = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the rejections to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.rejections, indent=2))
        temporary.replace(self.path)

    def all(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.rejections)

    def reject(self, name: str) -> dict:
        """Block a repo for BLOCK_DAYS from now (again, if it was rejected before). Returns its record."""
        now = datetime.now(UTC)
        with self.lock:
            record = self.rejections.get(name)
            if record is None:
                record = {"until": "", "history": []}
                self.rejections[name] = record
            record["until"] = (now + timedelta(days=BLOCK_DAYS)).isoformat()
            record["history"].append({"at": now.isoformat()})
            self.save()
            return copy.deepcopy(record)

    def allow(self, name: str) -> None:
        """End the block now; the history stays. KeyError if the repo was never rejected."""
        with self.lock:
            if name not in self.rejections:
                raise KeyError(f"{name} was never rejected")
            self.rejections[name]["until"] = datetime.now(UTC).isoformat()
            self.save()

    def blocked_until(self, name: str) -> str | None:
        """When the block ends, or None when the repo is not blocked now. Names compare without case."""
        now = datetime.now(UTC).isoformat()
        with self.lock:
            for rejected, record in self.rejections.items():
                if rejected.lower() == name.lower() and record["until"] > now:
                    return record["until"]
        return None
