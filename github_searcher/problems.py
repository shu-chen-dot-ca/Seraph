"""Problems: what went wrong in how the app made an agent work, reported by the agent itself (work_tools.py
report_problem), so the user can fix them all at one time from the Dashboard's Problems page (frontend/src/Problems.tsx).

Not the projects' own bugs and not the app's crashes (crashes.py): a rule or a tool that led an agent the wrong way, or
something a maintainer or the user had to correct. For example: an agent claimed an issue someone else's open pull
request already closed, and the maintainer said no second fix was needed.

Kept in DATA_DIR/problems.json, a list, the newest first, MAX_KEPT at most:

    {"id": "prb_a1b2c3", "at": ISO time, "agent": agent id, "job": job id | None, "about": "owner/name#n" | None,
     "text": what happened, why, and what should have happened, "closed_at": ISO time | None}

Closed ones (Close on the page, once they are fixed) stay, on the page's Closed tab.
"""

import copy
import json
import os
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
MAX_KEPT = 500
# A report is cut to this many characters.
TEXT_CHARS = 3000


class Problems:
    def __init__(self):
        self.path = DATA_DIR / "problems.json"
        self.lock = threading.Lock()
        # Goes up by one on every change: the live feed compares it (backend/app.py, topic "problems").
        self.version = 0
        self.items: list[dict] = []
        if self.path.exists():
            self.items = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.items, indent=2))
        temporary.replace(self.path)

    def list(self) -> list[dict]:
        """All of them, newest first."""
        with self.lock:
            return copy.deepcopy(self.items)

    def add(self, agent: str, job: str | None, about: str | None, text: str) -> dict:
        item = {
            "id": f"prb_{secrets.token_hex(3)}",
            "at": datetime.now(UTC).isoformat(),
            "agent": agent,
            "job": job,
            "about": about,
            "text": text[:TEXT_CHARS],
            "closed_at": None,
        }
        with self.lock:
            self.items.insert(0, item)
            del self.items[MAX_KEPT:]
            self.save()
        return copy.deepcopy(item)

    def close(self, ids: list[str]) -> list[str]:
        """Close these open ones (they are fixed); returns the ids closed."""
        closed = []
        with self.lock:
            for item in self.items:
                if item["id"] in ids and item["closed_at"] is None:
                    item["closed_at"] = datetime.now(UTC).isoformat()
                    closed.append(item["id"])
            self.save()
        return closed
