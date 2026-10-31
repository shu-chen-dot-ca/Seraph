"""Notifications: GitHub's own notifications for you (the bell on github.com), for the GitHub tab's Notifications page
(frontend/src/Notifications.tsx): mentions, review requests, assignments, comments on threads you follow, failed
checks on your repos, releases, ...

Read with your sign-in (github_account.py), never the search tokens. refresh() reads the newest PAGE_SIZE, read and
unread (GitHub's own inbox keeps read ones until you mark them done), kept in memory only and sent to the browser as
the live topic "notifications". backend/notifications_api.py reads them every REFRESH_SECONDS (GitHub asks for no
more than once a minute) and at once when you sign in or out.

    {"items": [{"id": GitHub's thread id, "unread", "reason": GitHub's word (mention, review_requested, assign,
                author, comment, ci_activity, state_change, subscribed, manual, team_mention, security_alert, ...),
                "updated_at", "title", "type": Issue | PullRequest | Release | CheckSuite | Discussion | Commit | ...,
                "repo": "owner/name", "number": the issue's or PR's | None, "url": where it is on GitHub}],
     "login", "checked_at", "error"}

mark_read(id) is what opening one does (as on GitHub), done(id) takes it out of the list for good (GitHub's Done),
mark_all_read() marks every one read. Each changes the kept list at once, so the page doesn't wait for the next read.
"""

import copy
import threading
from datetime import UTC, datetime

import httpx

API = "https://api.github.com"
PAGE_SIZE = 50
REFRESH_SECONDS = 60


class Notifications:
    def __init__(self, github_account):
        self.github_account = github_account
        self.lock = threading.Lock()
        self.version = 0
        self.data = {"items": [], "login": None, "checked_at": None, "error": None}

    def summary(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.data)

    def client(self) -> httpx.Client:
        """A client that acts as you. ValueError when you aren't signed in."""
        account = self.github_account.load()
        if account is None:
            raise ValueError("Sign in with GitHub first: the GitHub tab, Account.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        return httpx.Client(base_url=API, headers=headers, timeout=30)

    def refresh(self) -> None:
        """Reads them again. Not signed in: none. A failure keeps the last ones, with why."""
        account = self.github_account.load()
        if account is None:
            with self.lock:
                self.data = {"items": [], "login": None, "checked_at": None, "error": None}
                self.version += 1
            return
        try:
            with self.client() as client:
                response = client.get("/notifications", params={"all": "true", "per_page": PAGE_SIZE})
            response.raise_for_status()
        except (httpx.HTTPError, ValueError) as error:
            message = str(error)
            if isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 401:
                message = "GitHub doesn't accept your sign-in anymore. Sign in with GitHub again: the GitHub tab, Account."
            with self.lock:
                self.data["error"] = message
                self.data["checked_at"] = datetime.now(UTC).isoformat()
                self.version += 1
            return

        items = []
        for each in response.json():
            subject = each["subject"]
            repo = each["repository"]["full_name"]
            repo_url = each["repository"]["html_url"]
            # Where it is on GitHub: the API gives its API address only, so the page's is made from it.
            number = None
            url = repo_url
            last = ""
            if subject["url"]:
                last = subject["url"].rstrip("/").split("/")[-1]
            if subject["type"] == "Issue" and last.isdigit():
                number = int(last)
                url = f"{repo_url}/issues/{number}"
            if subject["type"] == "PullRequest" and last.isdigit():
                number = int(last)
                url = f"{repo_url}/pull/{number}"
            if subject["type"] == "CheckSuite":
                url = f"{repo_url}/actions"
            if subject["type"] == "Release":
                url = f"{repo_url}/releases"
            if subject["type"] == "Discussion":
                url = f"{repo_url}/discussions"
            if subject["type"] == "Commit" and last != "":
                url = f"{repo_url}/commit/{last}"
            items.append({
                "id": each["id"],
                "unread": each["unread"],
                "reason": each["reason"],
                "updated_at": each["updated_at"],
                "title": subject["title"],
                "type": subject["type"],
                "repo": repo,
                "number": number,
                "url": url,
            })
        with self.lock:
            self.data = {"items": items, "login": account["login"], "checked_at": datetime.now(UTC).isoformat(), "error": None}
            self.version += 1

    def mark_read(self, thread_id: str) -> None:
        with self.client() as client:
            response = client.patch(f"/notifications/threads/{thread_id}")
        if response.status_code >= 400:
            raise ValueError(f"GitHub refused: {response.text[:200]}")
        with self.lock:
            for item in self.data["items"]:
                if item["id"] == thread_id:
                    item["unread"] = False
            self.version += 1

    def done(self, thread_id: str) -> None:
        with self.client() as client:
            response = client.delete(f"/notifications/threads/{thread_id}")
        if response.status_code >= 400:
            raise ValueError(f"GitHub refused: {response.text[:200]}")
        with self.lock:
            self.data["items"] = [item for item in self.data["items"] if item["id"] != thread_id]
            self.version += 1

    def mark_all_read(self) -> None:
        with self.client() as client:
            response = client.put("/notifications", json={"read": True})
        if response.status_code >= 400:
            raise ValueError(f"GitHub refused: {response.text[:200]}")
        with self.lock:
            for item in self.data["items"]:
                item["unread"] = False
            self.version += 1
