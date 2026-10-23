"""What GitHub says about each issue in the Issues list right now: what helps decide whether it is worth fixing.

One JSON file, DATA_DIR/issue_facts.json, by issue id:

    {"owner/name#n": Facts, ...}

    Facts = {"state", "title", "labels", "created_at", "updated_at", "author", "author_role",
             "assignees": [login, ...], "participants", "thumbs_up", "comments",
             "last_comment_at", "last_comment_by", "last_comment_role",
             "linked_prs": [{"number", "repo", "state", "url", "author"}, ...],
             "repo_stars", "repo_pushed_at", "fetched_at"}

Roles are GitHub's author association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR,
FIRST_TIME_CONTRIBUTOR, NONE, ...), or BOT for bots. linked_prs are the pull requests that
say they close the issue or mention it: an open one usually means someone is already on it.

Kept apart from the Issues list on purpose: facts change on GitHub all the time, and the list's
undo/redo should only undo what agents and the user did, not bring back old facts. The backend
merges them into the live feed's issues topic and keeps them fresh (backend/issues_api.py).
version goes up by one on every change, like the other stores.
"""

import copy
import json
import os
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from github_searcher.search import get_issue_facts

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]


class IssueFacts:
    def __init__(self):
        self.path = DATA_DIR / "issue_facts.json"
        self.lock = threading.Lock()
        self.version = 0
        self.facts = {}
        if self.path.exists():
            self.facts = json.loads(self.path.read_text())

    def save(self) -> None:
        """Write the facts to disk. Called with the lock held, after every change."""
        self.version += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a file.
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(json.dumps(self.facts))
        temporary.replace(self.path)

    def all(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.facts)

    def refresh(self, issue_id: str) -> dict:
        """Ask GitHub about one issue ("owner/name#n") and keep the answer. Blocking.

        Raises httpx.HTTPError when GitHub fails, ValueError when it has no such issue.
        """
        name = issue_id.split("#")[0]
        owner = name.split("/")[0]
        repo = name.split("/")[1]
        number = int(issue_id.split("#")[1])
        data = get_issue_facts(owner, repo, number)
        issue = data["issue"]
        if issue is None:
            raise ValueError(f"GitHub has no issue {issue_id}")

        author = "ghost"
        author_role = issue["authorAssociation"]
        if issue["author"] is not None:
            author = issue["author"]["login"]
            if issue["author"]["__typename"] == "Bot":
                author_role = "BOT"

        last_comment_at = None
        last_comment_by = None
        last_comment_role = None
        if issue["comments"]["nodes"]:
            comment = issue["comments"]["nodes"][-1]
            last_comment_at = comment["createdAt"]
            last_comment_by = "ghost"
            last_comment_role = comment["authorAssociation"]
            if comment["author"] is not None:
                last_comment_by = comment["author"]["login"]
                if comment["author"]["__typename"] == "Bot":
                    last_comment_role = "BOT"

        # PRs that say they close it (GitHub's "Development" links), then PRs that mention it.
        # Each PR once; other events (issues mentioning it) are skipped.
        pulls = issue["closedByPullRequestsReferences"]["nodes"]
        for event in issue["timelineItems"]["nodes"]:
            pull = event.get("source") or event.get("subject")
            if pull is not None and pull.get("__typename") == "PullRequest":
                pulls.append(pull)
        linked_prs = []
        urls = []
        for pull in pulls:
            if pull["url"] in urls:
                continue
            urls.append(pull["url"])
            pull_author = "ghost"
            if pull["author"] is not None:
                pull_author = pull["author"]["login"]
            linked_prs.append(
                {
                    "number": pull["number"],
                    "repo": pull["repository"]["nameWithOwner"],
                    "state": pull["state"],
                    "url": pull["url"],
                    "author": pull_author,
                }
            )

        facts = {
            "state": issue["state"],
            "title": issue["title"],
            "labels": [label["name"] for label in issue["labels"]["nodes"]],
            "created_at": issue["createdAt"],
            "updated_at": issue["updatedAt"],
            "author": author,
            "author_role": author_role,
            "assignees": [person["login"] for person in issue["assignees"]["nodes"]],
            "participants": issue["participants"]["totalCount"],
            "thumbs_up": issue["reactions"]["totalCount"],
            "comments": issue["comments"]["totalCount"],
            "last_comment_at": last_comment_at,
            "last_comment_by": last_comment_by,
            "last_comment_role": last_comment_role,
            "linked_prs": linked_prs,
            "repo_stars": data["stargazerCount"],
            "repo_pushed_at": data["pushedAt"],
            "fetched_at": datetime.now(UTC).isoformat(),
        }
        with self.lock:
            self.facts[issue_id] = facts
            self.save()
        return copy.deepcopy(facts)

    def forget(self, keep: list[str]) -> None:
        """Drop the facts of issues that are no longer in the list."""
        with self.lock:
            gone = [issue_id for issue_id in self.facts if issue_id not in keep]
            if not gone:
                return
            for issue_id in gone:
                del self.facts[issue_id]
            self.save()
