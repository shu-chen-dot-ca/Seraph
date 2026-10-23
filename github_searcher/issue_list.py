"""The Issues list: the good first issues agents (or the user) picked to work on.

One JSON file, DATA_DIR/issues.json:

    {"items": [IssueItem, ...], "undo": [[IssueItem, ...], ...], "redo": [[IssueItem, ...], ...]}

    IssueItem = {"id": "owner/name#n", "repo", "number", "title", "labels", "state", "comments",
                 "html_url", "note", "added_by": "user" | "<agent id>", "added_at"}

Works like the Repos list (repo_list.py), keyed by "id" instead of "full_name". Items are kept
in the order they were added. Undo/redo is snapshot based, so it undoes an agent's change the
same way as the user's: every change pushes a copy of the whole list onto "undo" (the last
UNDO_LIMIT are kept) and clears "redo".

The backend keeps one IssueList that the API and every agent share, so each method takes the
lock. version goes up by one on every change; the live feed compares it to see what to send.
"""

import copy
import json
import os
import threading
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
UNDO_LIMIT = 100
# Only the last few undo/redo steps go into the file: with a long list, all UNDO_LIMIT copies
# make it tens of MB, written on every change. The others last until the backend restarts.
SAVED_STEPS = 10


class IssueList:
    def __init__(self):
        self.path = DATA_DIR / "issues.json"
        self.lock = threading.Lock()
        self.version = 0
        self.data = {"items": [], "undo": [], "redo": []}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file. No indent: the undo
        # snapshots make the file big.
        saved = {"items": self.data["items"], "undo": self.data["undo"][-SAVED_STEPS:], "redo": self.data["redo"][-SAVED_STEPS:]}
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

    def add(self, items: list[dict]) -> list[str]:
        """Add filled IssueItems as one undo step. Ids already in the list are skipped.

        Returns the ids that were added.
        """
        with self.lock:
            ids = [item["id"] for item in self.data["items"]]
            new = []
            for item in items:
                # Also skips an id given twice in the same call.
                if item["id"] in ids:
                    continue
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

    def remove(self, ids: list[str]) -> list[str]:
        """Remove issues as one undo step. Returns the ids that were in the list."""
        with self.lock:
            removed = [item["id"] for item in self.data["items"] if item["id"] in ids]
            if not removed:
                return []

            self.data["undo"].append(copy.deepcopy(self.data["items"]))
            self.data["undo"] = self.data["undo"][-UNDO_LIMIT:]
            self.data["redo"] = []
            self.data["items"] = [item for item in self.data["items"] if item["id"] not in ids]
            self.save()
            return removed

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
        with self.lock:
            if not self.data["undo"]:
                return False
            # The lists move between the stacks, nothing is shared, so no copy is needed.
            self.data["redo"].append(self.data["items"])
            self.data["redo"] = self.data["redo"][-UNDO_LIMIT:]
            self.data["items"] = self.data["undo"].pop()
            self.save()
            return True

    def redo(self) -> bool:
        """Go forward one undone step. False when there is nothing to redo."""
        with self.lock:
            if not self.data["redo"]:
                return False
            self.data["undo"].append(self.data["items"])
            self.data["undo"] = self.data["undo"][-UNDO_LIMIT:]
            self.data["items"] = self.data["redo"].pop()
            self.save()
            return True
