"""Issue drafts: the issues a repository's agent writes for the user from chat (the Workspace tab's Live,
frontend/src/RepoLive.tsx, and the agent's own page). The user asks for a feature or a fix there, and the agent writes
it up as an issue (draft_issue, github_searcher/agent/repo_tools.py) instead of making the change.

The agent never creates an issue itself. Each draft shows in its chat as a card: Create issue opens it on GitHub as the
user (your_repositories.py, act "new_issue"; backend/repo_live_api.py), Discard drops it. The agent hears which with
its next message (Agents.issue_decided). Drafts are not in the Inbox: they live in the chat they were asked for in.

They are kept in one file, DATA_DIR/issue_drafts.json, a list, oldest first:

    {"id": "issue_a1b2c3", "agent": "<agent id>", "repo": "owner/name", "title", "body": "markdown",
     "labels": ["bug", ...], "status": "pending" | "created" | "discarded",
     "url": the issue on GitHub | None, "number": its number | None, "created_at", "decided_at": None until decided}

The list reaches the browser as the live topic "issue_drafts". version goes up on every change. The API and every
agent share one IssueDrafts, so each method takes the lock. An agent's drafts go with it when it is deleted.
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
DECISIONS = ["created", "discarded"]


class IssueDrafts:
    def __init__(self):
        self.path = DATA_DIR / "issue_drafts.json"
        self.lock = threading.Lock()
        self.version = 0
        self.drafts: list[dict] = []
        if self.path.exists():
            self.drafts = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the list to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.drafts, indent=2))
        temporary.replace(self.path)

    def list(self) -> list[dict]:
        """All drafts, oldest first."""
        with self.lock:
            return copy.deepcopy(self.drafts)

    def get(self, draft_id: str) -> dict:
        with self.lock:
            for draft in self.drafts:
                if draft["id"] == draft_id:
                    return copy.deepcopy(draft)
        raise KeyError(f"No issue draft {draft_id}")

    def create(self, agent: str, repo: str, title: str, body: str, labels: list[str]) -> dict:
        with self.lock:
            ids = [draft["id"] for draft in self.drafts]
            draft_id = "issue_" + secrets.token_hex(3)
            while draft_id in ids:
                draft_id = "issue_" + secrets.token_hex(3)
            draft = {
                "id": draft_id,
                "agent": agent,
                "repo": repo,
                "title": title,
                "body": body,
                "labels": labels,
                "status": "pending",
                "url": None,
                "number": None,
                "created_at": datetime.now(UTC).isoformat(),
                "decided_at": None,
            }
            self.drafts.append(draft)
            self.save()
            return copy.deepcopy(draft)

    def decide(self, draft_id: str, status: str, url: str | None = None, number: int | None = None) -> dict:
        """The user created the issue on GitHub (with its url and number) or discarded the draft. Only once."""
        if status not in DECISIONS:
            raise ValueError(f"Unknown decision {status}")
        with self.lock:
            for draft in self.drafts:
                if draft["id"] != draft_id:
                    continue
                if draft["status"] != "pending":
                    raise ValueError(f"{draft_id} is {draft['status']} already")
                draft["status"] = status
                draft["url"] = url
                draft["number"] = number
                draft["decided_at"] = datetime.now(UTC).isoformat()
                self.save()
                return copy.deepcopy(draft)
        raise KeyError(f"No issue draft {draft_id}")

    def delete_for_agent(self, agent_id: str) -> None:
        """The agent was deleted: its drafts go too, since they only show in its chat."""
        with self.lock:
            kept = [draft for draft in self.drafts if draft["agent"] != agent_id]
            if len(kept) == len(self.drafts):
                return
            self.drafts = kept
            self.save()
