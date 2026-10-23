"""The Inbox: drafts agents write for the user, and the user's decisions on them.

Agents never send anything to GitHub. A pull request, a comment or a question becomes a draft
here, and the user approves, rejects, or replies to it (the agent then keeps working).
Approving sends nothing either; it only tells the agent. Each draft is one JSON file,
DATA_DIR/inbox/<id>.json:

    {"id": "draft_a1b2c3", "kind": "pr" | "comment" | "question", "agent": "<agent id>",
     "job": "job_..." | null, "repo": "owner/name" | null, "target": "owner/name#n" | null,
     "title", "body": "markdown",
     "diff": "unified diff (pr only)", "branch": "branch in the VM (pr only)", "base": "origin/main (pr only)",
     "vm": "vm1" | null, "path": "repo folder in the VM (pr only)" | null,
     "evidence": [Evidence, ...] (a copy of the job's, see jobs.py),
     "overview": {...} (for the user, see below), "template": ".github/pull_request_template.md" | null,
     "status": "pending" | "approved" | "rejected" | "replied", "reply": "the user's text",
     "created_at", "decided_at": null until decided}

"body" is what would be sent to GitHub; "overview" is only for the user, who doesn't know the
project: plain words on what is wrong and what the draft does about it.

    pr:      {"project", "problem", "cause", "fix", "risks": ["what could go wrong", ...]}
    comment: {"project", "problem", "why"}  (why post this comment now)

"template" is the repo's PR template a PR's body was checked against (none: the repo has none).

A draft is decided once. Drafts are never deleted, so the Inbox keeps the history.

The backend keeps one Inbox that the API and every agent share, so each method takes the
lock. version goes up by one on every change; the live feed compares it to see what to send.
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
DECISIONS = ["approved", "rejected", "replied"]


class Inbox:
    def __init__(self):
        self.folder = DATA_DIR / "inbox"
        self.lock = threading.Lock()
        self.version = 0
        self.drafts: dict[str, dict] = {}
        # "*.json" leaves out a "*.json.tmp" a crash may have left behind.
        for path in sorted(self.folder.glob("*.json")):
            draft = json.loads(path.read_text())
            # Drafts from before evidence existed have none.
            draft.setdefault("evidence", [])
            # And from before overviews.
            draft.setdefault("overview", {})
            draft.setdefault("template", None)
            self.drafts[draft["id"]] = draft

    def save(self, draft: dict) -> None:
        """Write one draft to disk. Called with the lock held, after every change."""
        self.version += 1
        self.folder.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a record.
        temporary = self.folder / f"{draft['id']}.json.tmp"
        temporary.write_text(json.dumps(draft, indent=2))
        temporary.replace(self.folder / f"{draft['id']}.json")

    def list(self) -> list[dict]:
        """All drafts, newest first."""
        with self.lock:
            drafts = sorted(self.drafts.values(), key=lambda draft: draft["created_at"], reverse=True)
            return copy.deepcopy(drafts)

    def get(self, draft_id: str) -> dict:
        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            return copy.deepcopy(self.drafts[draft_id])

    def create(self, kind: str, agent: str, title: str, body: str, job: str | None = None,
               repo: str | None = None, target: str | None = None, diff: str = "", branch: str = "",
               base: str = "", vm: str | None = None, path: str | None = None, evidence: list | None = None,
               overview: dict | None = None, template: str | None = None) -> dict:
        with self.lock:
            draft_id = "draft_" + secrets.token_hex(3)
            while draft_id in self.drafts:
                draft_id = "draft_" + secrets.token_hex(3)
            draft = {
                "id": draft_id,
                "kind": kind,
                "agent": agent,
                "job": job,
                "repo": repo,
                "target": target,
                "title": title,
                "body": body,
                "diff": diff,
                "branch": branch,
                "base": base,
                "vm": vm,
                "path": path,
                "evidence": copy.deepcopy(evidence or []),
                "overview": copy.deepcopy(overview or {}),
                "template": template,
                "status": "pending",
                "reply": "",
                "created_at": datetime.now(UTC).isoformat(),
                "decided_at": None,
            }
            self.drafts[draft_id] = draft
            self.save(draft)
            return copy.deepcopy(draft)

    def decide(self, draft_id: str, status: str, reply: str = "") -> dict:
        """Approve, reject or reply to a pending draft. Returns the draft as it is now."""
        if status not in DECISIONS:
            raise ValueError(f"Unknown decision {status!r}, use one of: {', '.join(DECISIONS)}")

        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            draft = self.drafts[draft_id]
            if draft["status"] != "pending":
                raise ValueError(f"{draft_id} was already {draft['status']}")
            draft["status"] = status
            draft["reply"] = reply
            draft["decided_at"] = datetime.now(UTC).isoformat()
            self.save(draft)
            return copy.deepcopy(draft)
