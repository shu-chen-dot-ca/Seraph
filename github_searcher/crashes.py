"""Errors: what went wrong in the app itself, for the agent of the app's own repo to turn into issues (projects.py).

Four places report here:
- the backend: an exception nobody caught, in a request, a background task or a thread (backend/app.py);
- the browser: an error on a page (frontend/src/main.tsx, POST /api/errors);
- the agents' worker: a turn that failed with an exception (agents.py);
- a release: one the live copy had to take back (deploy/switch.sh keeps what went wrong in it in
  SERAPH_HOME/failed-crashes.json, and it is reported here when the release before it starts again), or one that
  failed its check before going live (github_searcher/updates.py).

The same error again is the same entry, counted: its key is where it came from, its first line and the last line of
its stack. Kept in DATA_DIR/crashes.json, a list, the newest first, MAX_KEPT at most:

    {"id": "err_a1b2c3", "source": "backend" | "browser" | "agent" | "release", "message", "detail": the stack or more,
     "key", "count", "first_at", "last_at", "version": the release that ran when it last happened,
     "state": "new" | "sent" | "filed" | "skipped", "issue": the issue's number | None, "note": the agent's line on it}

new: not given to the agent yet. sent: given (backend/projects_api.py sends the new ones every SEND_SECONDS). filed:
it made an issue of it or added it to one (issue). skipped: the agent decided it isn't worth an issue (note says why).
Happening again makes a filed or skipped one new again, so the agent sees it came back.

since_start counts every report since the backend started: GET /api/health has it, and deploy/switch.sh takes a new
release back when it climbs in its first minutes.
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
SOURCES = ["backend", "browser", "agent", "release"]
STATES = ["new", "sent", "filed", "skipped"]
MAX_KEPT = 200
# A message and its detail are cut to this many characters.
MESSAGE_CHARS = 500
DETAIL_CHARS = 6000
# The release that runs: the VERSION file a release gets (github_searcher/updates.py), else the dev copy.
RUNNING = "dev"
if (PROJECT_ROOT / "VERSION").is_file():
    RUNNING = (PROJECT_ROOT / "VERSION").read_text().strip()


class Crashes:
    def __init__(self):
        self.path = DATA_DIR / "crashes.json"
        self.lock = threading.Lock()
        self.version = 0
        self.since_start = 0
        self.items: list[dict] = []
        if self.path.exists():
            self.items = json.loads(self.path.read_text())

        # A release the live copy took back (deploy/switch.sh): what went wrong in it becomes one report here.
        home = os.environ.get("SERAPH_HOME", "")
        # Not in a new release's check (backend/app.py), which runs on a copy of data/.
        if home == "" or os.environ.get("SERAPH_CHECK", "") == "1":
            return
        failed = Path(home) / "failed-crashes.json"
        if not failed.is_file():
            return
        report = json.loads(failed.read_text())
        lines = []
        for item in report["crashes"][:20]:
            lines.append(f"- {item['source']}, {item['count']}x: {item['message']}")
        detail = "What went wrong in it:\n" + ("\n".join(lines) or "nothing was reported; it stopped answering.")
        self.add("release", f"Release {report['tag']} was taken back: {report['reason']}", detail, report["tag"])
        failed.unlink()
        # Reports before this start aren't this release's.
        self.since_start = 0

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.items, indent=2))
        temporary.replace(self.path)

    def list(self) -> list[dict]:
        """All of them, the newest first."""
        with self.lock:
            return copy.deepcopy(self.items)

    def add(self, source: str, message: str, detail: str = "", version: str = "") -> None:
        """One error. Safe to call from any thread; never raises, so reporting an error never makes another."""
        try:
            message = message.strip()[:MESSAGE_CHARS] or "(no message)"
            detail = detail.strip()[-DETAIL_CHARS:]
            lines = [line.strip() for line in detail.splitlines() if line.strip()]
            last = ""
            if lines:
                last = lines[-1]
            key = f"{source}|{message.splitlines()[0][:200]}|{last[:200]}"
            now = datetime.now(UTC).isoformat()
            with self.lock:
                self.since_start += 1
                found = None
                for item in self.items:
                    if item["key"] == key:
                        found = item
                if found is not None:
                    found["count"] += 1
                    found["last_at"] = now
                    found["version"] = version or RUNNING
                    found["detail"] = detail
                    # Back again after the agent dealt with it: it sees it once more.
                    if found["state"] in ["filed", "skipped"]:
                        found["state"] = "new"
                    self.items.remove(found)
                    self.items.insert(0, found)
                else:
                    self.items.insert(0, {
                        "id": "err_" + secrets.token_hex(3),
                        "source": source,
                        "message": message,
                        "detail": detail,
                        "key": key,
                        "count": 1,
                        "first_at": now,
                        "last_at": now,
                        "version": version or RUNNING,
                        "state": "new",
                        "issue": None,
                        "note": "",
                    })
                    self.items = self.items[:MAX_KEPT]
                self.save()
        except Exception:
            pass

    def mark(self, ids: list[str], state: str, issue: int | None = None, note: str = "") -> list[str]:
        """Set what became of these (sent, filed with its issue, skipped with why). Returns the ids it knew."""
        if state not in STATES:
            raise ValueError(f"Unknown state {state}")
        with self.lock:
            done = []
            for item in self.items:
                if item["id"] not in ids:
                    continue
                item["state"] = state
                if issue is not None:
                    item["issue"] = issue
                if note:
                    item["note"] = note
                done.append(item["id"])
            if done:
                self.save()
            return done
