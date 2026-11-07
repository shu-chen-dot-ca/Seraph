"""The Issues list: the good first issues agents (or the user) picked to work on.

One JSON file, DATA_DIR/issues.json:

    {"items": [IssueItem, ...], "undo": [[IssueItem, ...], ...], "redo": [[IssueItem, ...], ...], "dismissed": [id, ...]}

    IssueItem = {"id": "owner/name#n", "repo", "number", "title", "labels", "state", "comments",
                 "html_url", "note", "added_by": "user" | "<agent id>", "added_at"}

Works like the Repos list (repo_list.py), keyed by "id" instead of "full_name". Items are kept
in the order they were added. Undo/redo is snapshot based, so it undoes an agent's change the
same way as the user's: every change pushes a copy of the whole list onto "undo" (the last
UNDO_LIMIT are kept) and clears "redo".

An issue an agent is working on (a job on it queued, working, waiting on the user or on the maintainers: WORKING) is never taken
out, by the user, an agent or Remove closed and assigned: remove skips it and says so, and an undo or redo that
would drop it keeps it. Cancel its job first.

dismissed is what the user took off with the × on the Dashboard's Issues board (dismiss): removed like remove, and
never added again by an agent or a bulk add (add skips them). Only the user adding that one issue by hand
(allow_dismissed) puts it back, and takes it off dismissed. An undo brings the item back but leaves it dismissed; undo
snapshots hold the items only. restore puts dismissed ones back (Undo on the toast after the ×): the items are kept in
memory when dismissed, so it works until the backend restarts.
The backend keeps one IssueList that the API and every agent share, so each method takes the
lock. version goes up by one on every change; the live feed compares it to see what to send.
"""

import copy
import json
import os
import threading
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.jobs import Jobs

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
UNDO_LIMIT = 100
# Only the last few undo/redo steps go into the file: with a long list, all UNDO_LIMIT copies
# make it tens of MB, written on every change. The others last until the backend restarts.
SAVED_STEPS = 10
WORKING = ["queued", "working", "waiting_on_user", "waiting_on_maintainers", "paused"]


class IssueList:
    def __init__(self, jobs: Jobs):
        self.jobs = jobs
        self.path = DATA_DIR / "issues.json"
        self.lock = threading.Lock()
        self.version = 0
        self.data = {"items": [], "undo": [], "redo": [], "dismissed": []}
        # Dismissed items by id, for restore. In memory only.
        self.dismissed_items = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
            # Lists from before dismissed have none.
            self.data.setdefault("dismissed", [])

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file. No indent: the undo
        # snapshots make the file big.
        saved = {
            "items": self.data["items"],
            "undo": self.data["undo"][-SAVED_STEPS:],
            "redo": self.data["redo"][-SAVED_STEPS:],
            "dismissed": self.data["dismissed"],
        }
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(saved))
        temporary.replace(self.path)

    def items(self) -> list[dict]:
        with self.lock:
            return copy.deepcopy(self.data["items"])

    def can_undo(self) -> bool:
        with self.lock:
            return len(self.data["undo"]) > 0

    def can_redo(self) -> bool:
        with self.lock:
            return len(self.data["redo"]) > 0

    def add(self, items: list[dict], allow_dismissed: bool = False) -> list[str]:
        """Add filled IssueItems as one undo step. Ids already in the list are skipped, and so are dismissed ones
        unless allow_dismissed (the user adding that issue by hand), which takes them off dismissed.

        Returns the ids that were added.
        """
        with self.lock:
            ids = [item["id"] for item in self.data["items"]]
            new = []
            for item in items:
                # Also skips an id given twice in the same call.
                if item["id"] in ids:
                    continue
                if item["id"] in self.data["dismissed"] and not allow_dismissed:
                    continue
                if item["id"] in self.data["dismissed"]:
                    self.data["dismissed"].remove(item["id"])
                ids.append(item["id"])
                new.append(copy.deepcopy(item))
            if not new:
                return []

            self.data["undo"].append(copy.deepcopy(self.data["items"]))
            self.data["undo"] = self.data["undo"][-UNDO_LIMIT:]
            self.data["redo"] = []
            self.data["items"] = self.data["items"] + new
            self.save()
            return [item["id"] for item in new]

    def remove(self, ids: list[str]) -> dict:
        """Remove issues as one undo step, but not the ones an agent is working on.

        Returns {"removed": the ids taken out, "working": the ids in the list kept because an agent is on them}.
        """
        # Asked before taking the lock, so this lock and the jobs' are never held at once.
        working = [job["issue"] for job in self.jobs.list() if job["status"] in WORKING]
        with self.lock:
            listed = [item["id"] for item in self.data["items"] if item["id"] in ids]
            removed = [issue_id for issue_id in listed if issue_id not in working]
            kept = [issue_id for issue_id in listed if issue_id in working]
            if not removed:
                return {"removed": [], "working": kept}

            self.data["undo"].append(copy.deepcopy(self.data["items"]))
            self.data["undo"] = self.data["undo"][-UNDO_LIMIT:]
            self.data["redo"] = []
            self.data["items"] = [item for item in self.data["items"] if item["id"] not in removed]
            self.save()
            return {"removed": removed, "working": kept}

    def dismiss(self, ids: list[str]) -> dict:
        """Remove issues like remove, and keep the removed ones out for good (see the top of this file).

        Returns what remove returns: {"removed", "working"}.
        """
        before = {item["id"]: item for item in self.items()}
        result = self.remove(ids)
        with self.lock:
            for issue_id in result["removed"]:
                self.dismissed_items[issue_id] = before[issue_id]
                if issue_id not in self.data["dismissed"]:
                    self.data["dismissed"].append(issue_id)
            self.save()
        return result

    def restore(self, ids: list[str]) -> list[str]:
        """Put dismissed issues back as one undo step and take them off dismissed. Returns the ids put back."""
        items = [self.dismissed_items[issue_id] for issue_id in ids if issue_id in self.dismissed_items]
        return self.add(items, allow_dismissed=True)

    def dismissed(self) -> list[str]:
        with self.lock:
            return list(self.data["dismissed"])

    def set_note(self, id: str, note: str) -> None:
        """Replace an issue's note as one undo step. KeyError if the issue is not in the list."""
        with self.lock:
            matches = [item for item in self.data["items"] if item["id"] == id]
            if not matches:
                raise KeyError(f"{id} is not in the Issues list")

            # The snapshot is a deep copy, so changing the item below does not change it.
            self.data["undo"].append(copy.deepcopy(self.data["items"]))
            self.data["undo"] = self.data["undo"][-UNDO_LIMIT:]
            self.data["redo"] = []
            matches[0]["note"] = note
            self.save()

    def undo(self) -> bool:
        """Go back one step. False when there is nothing to undo."""
        working = [job["issue"] for job in self.jobs.list() if job["status"] in WORKING]
        with self.lock:
            if not self.data["undo"]:
                return False
            # The lists move between the stacks, nothing is shared, so no copy is needed.
            current = self.data["items"]
            self.data["redo"].append(current)
            self.data["redo"] = self.data["redo"][-UNDO_LIMIT:]
            self.data["items"] = self.data["undo"].pop()
            # An issue an agent is working on stays, even when the step undone is the one that added it.
            ids = [item["id"] for item in self.data["items"]]
            for item in current:
                if item["id"] in working and item["id"] not in ids:
                    self.data["items"].append(copy.deepcopy(item))
            self.save()
            return True

    def redo(self) -> bool:
        """Go forward one undone step. False when there is nothing to redo."""
        working = [job["issue"] for job in self.jobs.list() if job["status"] in WORKING]
        with self.lock:
            if not self.data["redo"]:
                return False
            current = self.data["items"]
            self.data["undo"].append(current)
            self.data["undo"] = self.data["undo"][-UNDO_LIMIT:]
            self.data["items"] = self.data["redo"].pop()
            # An issue an agent is working on stays, even when the step redone is the one that removed it.
            ids = [item["id"] for item in self.data["items"]]
            for item in current:
                if item["id"] in working and item["id"] not in ids:
                    self.data["items"].append(copy.deepcopy(item))
            self.save()
            return True
