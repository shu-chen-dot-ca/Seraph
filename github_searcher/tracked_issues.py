"""What is going on in each tracked repo: its open issues, newest first, and which of them are new to the user.

The Tracked list (DATA_DIR/tracked.json, a RepoList) holds the repos the user, or an agent, wants to keep
an eye on. This store keeps what GitHub says about their issues, in DATA_DIR/tracked_issues.json, by repo:

    {"owner/name": Check, ...}

    Check = {"checked_at", "error": str | None, "seen_at", "stars", "description",
             "issues": [{"number", "title", "url", "created_at", "author", "labels",
                         "comments", "assignees", "good_first"}, ...]}

issues are the repo's 100 newest open issues, plus every open issue under a good-first-issue kind of
label (GOOD_FIRST matches the label's name), newest first. good_first says whether an issue has such a
label. An issue is new when it was opened after seen_at: the time the repo was first checked, and later
whenever the user marks it seen. Times are in GitHub's format (2026-10-23T03:39:11Z), so they compare as text. error is why the last check failed (the issues of the check before stay).

Kept apart from the list on purpose, like issue_facts.py: the list's undo/redo should only undo what
agents and the user did, not bring back old checks. The backend checks every tracked repo now and then
(backend/tracked_api.py) and merges this into the live feed's tracked topic. version goes up by one on
every change, like the other stores.
"""

import copy
import json
import os
import re
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.search import get_tracked_issues

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
# Label names that mean "good for a newcomer": "good first issue", "🌱 Good first issue", "good-first-issue",
# "first-timers-only", "beginner-friendly", "Difficulty: Easy", ...
GOOD_FIRST = re.compile(r"good.?first|first.?timer|beginner|easy", re.IGNORECASE)


class TrackedIssues:
    def __init__(self):
        self.path = DATA_DIR / "tracked_issues.json"
        self.lock = threading.Lock()
        self.version = 0
        self.checks = {}
        if self.path.exists():
            self.checks = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the checks to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.checks))
        temporary.replace(self.path)

    def all(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.checks)

    def check(self, full_name: str) -> None:
        """Ask GitHub for one repo's open issues ("owner/name") and keep them. Blocking.

        When GitHub fails, the error is kept with the repo (the page shows it) and raised again:
        httpx.HTTPError, or ValueError when GitHub has no such repo.
        """
        owner = full_name.split("/")[0]
        repo = full_name.split("/")[1]
        # GitHub's own format, so times compare as text with the issues' created_at.
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            data = get_tracked_issues(owner, repo)
        except Exception as error:
            with self.lock:
                check = self.checks.get(full_name, {"seen_at": now, "stars": None, "description": "", "issues": []})
                check["checked_at"] = now
                check["error"] = str(error) or type(error).__name__
                self.checks[full_name] = check
                self.save()
            raise

        # By number, so an issue that is both new and labeled is listed once.
        nodes = {}
        for node in data["newest"]["nodes"]:
            nodes[node["number"]] = node
        found_labels = data["firstLabels"]["nodes"] + data["beginnerLabels"]["nodes"] + data["easyLabels"]["nodes"]
        for label in found_labels:
            if not GOOD_FIRST.search(label["name"]):
                continue
            for node in label["issues"]["nodes"]:
                nodes[node["number"]] = node

        issues = []
        for node in nodes.values():
            labels = [label["name"] for label in node["labels"]["nodes"]]
            good_first = any(GOOD_FIRST.search(label) for label in labels)
            issues.append(
                {
                    "number": node["number"],
                    "title": node["title"],
                    "url": node["url"],
                    "created_at": node["createdAt"],
                    "author": node["author"]["login"] if node["author"] else "ghost",
                    "labels": labels,
                    "comments": node["comments"]["totalCount"],
                    "assignees": node["assignees"]["totalCount"],
                    "good_first": good_first,
                }
            )
        issues.sort(key=lambda issue: issue["created_at"], reverse=True)

        with self.lock:
            # The first check sets seen_at: what is open now is not new, what opens after it is.
            seen_at = now
            if full_name in self.checks:
                seen_at = self.checks[full_name]["seen_at"]
            self.checks[full_name] = {
                "checked_at": now,
                "error": None,
                "seen_at": seen_at,
                "stars": data["stargazerCount"],
                "description": data["description"] or "",
                "issues": issues,
            }
            self.save()

    def mark_seen(self, full_names: list[str] | None) -> None:
        """The user saw these repos' issues (None: every repo): none of them is new anymore."""
        with self.lock:
            now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            for full_name, check in self.checks.items():
                if full_names is not None and full_name not in full_names:
                    continue
                check["seen_at"] = now
            self.save()
