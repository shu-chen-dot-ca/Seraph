"""Your GitHub account: the one you sign in with, whose token sends what you approve in the Inbox, as you, and
that the GitHub tab uses to manage what you sent and to post your own comments.

Sign in works like "Sign in with GitHub" on any website. The GitHub tab's Account page (#/github/account, in its left
list) asks sign_in_url() for GitHub's own page, which asks you whether Seraph may act as you. Once you click Authorize
there, GitHub sends the browser back to the callback (backend/github_account_api.py), and finish_sign_in() trades the
code it brings for your token, with the app's client secret. SCOPES is what it asks for: about all you can do on
github.com yourself (your repos, public and private, workflow files, the organizations you are in, gists,
notifications, your profile). Signing in again later skips GitHub's question; it shows who to sign in as when you
have more than one account on github.com.

For that the app is registered on GitHub as an OAuth App, once, by you (the Account page walks you through it).
save_app() keeps its client ID and secret in DATA_DIR/github_app.json, not .env. An OAuth App, not a GitHub App:
signing in with a GitHub App only works on the repos it is installed on, so it couldn't open PRs on other people's
projects (fine-grained tokens can't either). An organization may block OAuth Apps it hasn't approved; for those,
connect() also takes a classic token pasted by hand (Use a token instead).

connect() checks the token with GitHub and keeps it in DATA_DIR/github_account.json, a file only this computer's user
may read. Sign out (disconnect()) deletes it. The browser only ever gets status(): who you are signed in as, what the
token may do and whether sign in is set up, never the token or the secret. Agents and the VMs never get them
either; only the Inbox's Approve and Send to GitHub (backend/inbox_api.py) and the GitHub tab's buttons
(backend/github_api.py) use the token. It is kept apart from the search tokens in .env (token_balancer.py), which only
read.

send(draft_id) sends a PR, comment or edit draft once, as it was shown in the Inbox. A PR:
1. Your fork of the project, made the first time (GitHub keeps it). Your own repo is its own fork.
2. The pictures the body shows (evidence:ev_...) go on your fork's pr-pictures branch, one folder per
   draft, and the body links to them there: GitHub's API has no way to attach a picture to a PR.
3. The commits, on top of the commit the agent started from (base_sha). The draft's diff is applied
   here, with git apply in a temporary folder, to that commit's copies of the files it touches, read
   from GitHub (tree()). Nothing comes from the VM, so what goes out is exactly the diff you reviewed.
   The branch's own commits (the draft's "commits", kept by draft_pr) are replayed the same way, one by
   one, with their messages. Every one is the agent's and goes out as yours: your GitHub name and
   private noreply address (the VM's git address, also in a message's Signed-off-by, becomes that).
   Nobody else's commit goes out and nothing credits a co-author: draft_pr refuses such a branch, and
   a draft from before that rule with someone else's commit in it isn't sent. If they don't end at
   exactly the reviewed diff, one more commit does, with the PR's title as its message. If they can't
   be replayed (a binary file in one), it is that one commit alone.
4. The last commit on a new branch in your fork: the agent's branch name (fix-<issue> when it worked on
   the main branch), with -2, -3, ... when the name is taken.
5. The PR, from that branch into the branch the agent started from (base "origin/main" is main; else
   the project's default branch), with the draft's title and body. If GitHub refuses it, the new
   branch is deleted again, so trying again starts clean.
A PR waits for the claim of its job (every fix_issue job claims its issue first) to be decided first, and when it was
approved on a repo whose rules want a maintainer's confirmation before a PR (the claim's wait_for_assignment), until
GitHub shows you assigned to the claimed issue (mcp-memory-service#1912 went out 16 minutes after its claim,
unassigned, and its claim check failed).
A comment is posted on its issue or PR (its pictures go to your fork the same way).
An edit (a new title and description for your own PR or issue) changes them on GitHub, only when it is yours and still
has the text the agent saw ("previous"), else it refuses (the agent redrafts on the text as it is now).

A PR draft with update_of is the agent's next version of your open PR (a follow-up: a reviewer asked for
changes, or its checks failed), not a new PR. The PR is read first, with your token: it must be open, opened
by you, with its branch in your fork, and that branch must still be at the commit the agent started from
(base_sha), else it refuses (the agent redrafts on the newest commit). The commits are built as for a new PR
(pictures, the reviewed diff, the agent's own commits replayed, one more commit when needed) but on top of that
commit, in your fork; then the PR's branch moves to the last one (a fast-forward, never forced), and the
draft's body is posted on the PR as your comment (when it has one). If GitHub refuses only the comment (a
locked conversation, say), the push stays sent and "comment_error" says why.

A rebase (update_of with rebase_of) replaces the PR's commits instead: the branch must still be at rebase_of, the
PR's newest commit when the agent drafted it, so nothing it didn't see is lost. The commits are built the same way,
on base_sha (the project's commit the rebased branch starts from, which an old fork may need to catch up to first),
and the PR's branch is force-moved to them, only on your own PR's branch in your fork. Its commits that already were
the PR's are yours (your noreply address), and go out with your name again.

What was sent is kept on the draft as "sent" (Inbox.mark_sent):

    PR:      {"kind": "pr", "url", "number", "repo", "fork", "branch", "base_branch", "base_sha",
              "commit", "as": "<your login>", "at"}
    update:  the same with "update": True ("url" is the PR's, "base_sha" the commit it went on top of),
             "rebase_of": the PR's commit it replaced (a rebase) | None,
             "comment_url": the comment posted with it | None, "comment_error": None | why it wasn't posted
    comment: {"kind": "comment", "url", "id", "repo", "number", "as", "at", "deleted_at" once deleted from the GitHub tab}
    edit:    {"kind": "edit", "url", "repo", "number", "title", "as", "at"}

comment(target, body) posts your own comment, as you, on a PR or issue: the comment box of the GitHub tab's
thread pop-up (backend/github_api.py), after its "are you sure?". No agent and no draft is involved.

manage(action, repo, number) is one change you make from the GitHub tab, as you: close or reopen one
of your PRs, delete a closed PR's branch from your fork, or delete one of your comments (in a PR's or
issue's conversation in the thread pop-up). An agent's update_branch (work_tools.py, where the repo's Level of
automation has Pull requests) is one too: GitHub's Update branch on your open PR, which merges its base in. It
checks first that the PR is yours and the branch is in your fork.
A PR draft with "replaces" (an older PR of yours made again fresh, inbox.py) closes that one once the new one is open;
"sent" then has "closed": the old one's owner/name#n.
open_issue(repo, title, body) opens an issue as you, claimed for you: an agent's open_issue (work_tools.py, where the
repo's Level of automation has Open issues). It is assigned to you; GitHub keeps the assignee only when you may assign
on that repo, so where it doesn't, your comment CLAIM_TEXT says you are on it. Following your PRs is pr_tracking.py.

Sends go one at a time (a second click waits, then finds the draft sent). A failure raises SendError
with what GitHub said and at which step; nothing is kept on the draft then. While one goes, sending_draft and step say
which draft it is and where it is ("replaying commit 3 of 6"), for the Inbox to show.
"""

import base64
import hashlib
import json
import os
import secrets
import subprocess
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv

from github_searcher.jobs import EVIDENCE_DIR

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
API = "https://api.github.com"
# What signing in asks GitHub for (module docstring).
SCOPES = "repo workflow read:org gist notifications user"
PICTURES_BRANCH = "pr-pictures"
# The comment that claims an issue opened as you where GitHub doesn't let you assign yourself (open_issue).
CLAIM_TEXT = "I'm working on a fix for this and will open a PR."
# Seconds a new fork may take before its branches can be used.
FORK_WAIT = 120
# A text file up to this size goes inside the tree it is in (tree()); a bigger one is uploaded on its own.
INLINE_BYTES = 1_000_000
# git without the user's own git settings, and never looking for a repo above the temporary folder.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CEILING_DIRECTORIES": tempfile.gettempdir()}


class SendError(Exception):
    pass


class GithubAccount:
    def __init__(self, inbox):
        self.inbox = inbox
        self.path = DATA_DIR / "github_account.json"
        # The OAuth App sign in goes through (module docstring): {"client_id", "client_secret"}.
        self.app_path = DATA_DIR / "github_app.json"
        # The state the last sign in went to GitHub with: the callback must bring it back, so only a sign in
        # started here can sign you in. One at a time; a newer one replaces it.
        self.sign_in_state = None
        self.send_lock = threading.Lock()
        # The step a send is at, for its error message and for the Inbox while it waits (backend/github_account_api.py).
        # Only changed with send_lock held. sending_draft is the draft being sent, None between sends.
        self.step = ""
        self.sending_draft = None
        # What the send going on knows from GitHub already (send(), tree()).
        self.listings = {}
        self.blobs = {}

    def load(self) -> dict | None:
        if not self.path.is_file():
            return None
        return json.loads(self.path.read_text())

    def status(self) -> dict:
        """What the browser may know: who it is, what the token may do and whether sign in is set up. Never the token."""
        account = self.load()
        can_sign_in = self.app_path.is_file()
        if account is None:
            return {"connected": False, "can_sign_in": can_sign_in}
        return {
            "connected": True,
            "can_sign_in": can_sign_in,
            "login": account["login"],
            "name": account["name"],
            "scopes": account["scopes"],
            "connected_at": account["connected_at"],
        }

    def save_app(self, client_id: str, client_secret: str) -> None:
        """Keeps the OAuth App's client ID and secret (from its page on GitHub). ValueError says why they won't do."""
        client_id = client_id.strip()
        client_secret = client_secret.strip()
        if client_id == "" or client_secret == "":
            raise ValueError("Paste both the Client ID and the client secret.")
        # A GitHub App's client ID starts with Iv: signing in with one couldn't open PRs on other people's projects.
        if client_id.startswith("Iv"):
            raise ValueError("That is a GitHub App's Client ID. Register an OAuth App instead (step 1).")
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        # Made readable by this computer's user only, before the secret goes in. Write, then rename.
        temporary = self.app_path.with_name("github_app.json.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(json.dumps({"client_id": client_id, "client_secret": client_secret}, indent=2))
        temporary.replace(self.app_path)

    def sign_in_url(self) -> str:
        """GitHub's page that asks you to let the app act as you. ValueError when sign in isn't set up."""
        if not self.app_path.is_file():
            raise ValueError("Sign in isn't set up yet: register the app on GitHub first (the steps on this page).")
        app = json.loads(self.app_path.read_text())
        self.sign_in_state = secrets.token_urlsafe(32)
        # prompt=select_account: with more than one account on github.com, GitHub asks which one.
        query = {"client_id": app["client_id"], "scope": SCOPES, "state": self.sign_in_state, "prompt": "select_account"}
        return "https://github.com/login/oauth/authorize?" + urlencode(query)

    def finish_sign_in(self, code: str, state: str) -> dict:
        """The callback's half: trades GitHub's code for your token and keeps it (connect). ValueError says why not."""
        if self.sign_in_state is None or state != self.sign_in_state:
            raise ValueError("That sign in didn't start here, or is too old. Click Sign in with GitHub again.")
        self.sign_in_state = None
        app = json.loads(self.app_path.read_text())
        form = {"client_id": app["client_id"], "client_secret": app["client_secret"], "code": code}
        try:
            response = httpx.post("https://github.com/login/oauth/access_token", data=form, headers={"Accept": "application/json"}, timeout=30)
        except httpx.HTTPError as error:
            raise ValueError(f"Could not reach GitHub: {error}")
        if response.status_code != 200:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
        # GitHub says what went wrong in the answer, still with 200.
        answer = response.json()
        if answer.get("error") == "incorrect_client_credentials":
            raise ValueError("GitHub doesn't accept the app's client secret. Change app settings, then sign in again.")
        if "access_token" not in answer:
            raise ValueError(answer.get("error_description") or answer.get("error") or "GitHub sent no token back.")
        return self.connect(answer["access_token"])

    def connect(self, token: str) -> dict:
        """Checks the token with GitHub and keeps it. ValueError says why a token won't do."""
        token = token.strip()
        if token == "":
            raise ValueError("Paste a token first.")
        if token.startswith("github_pat_"):
            raise ValueError(
                "That is a fine-grained token. GitHub doesn't let those open PRs on projects you don't own: "
                "make a classic token with the public_repo scope."
            )
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}", "X-GitHub-Api-Version": "2022-11-28"}
        try:
            response = httpx.get(f"{API}/user", headers=headers, timeout=30)
        except httpx.HTTPError as error:
            raise ValueError(f"Could not reach GitHub: {error}")
        if response.status_code == 401:
            raise ValueError("GitHub doesn't accept this token. Copy it again, or make a new one.")
        if response.status_code != 200:
            raise ValueError(f"GitHub answered {response.status_code}: {response.text[:200]}")
        # A classic token's scopes come in this header.
        scopes = [scope.strip() for scope in response.headers.get("x-oauth-scopes", "").split(",") if scope.strip()]
        if "public_repo" not in scopes and "repo" not in scopes:
            raise ValueError("This token can't open PRs: make a classic token with the public_repo scope.")
        user = response.json()
        account = {
            "token": token,
            "login": user["login"],
            "id": user["id"],
            "name": user["name"] or user["login"],
            "scopes": scopes,
            "connected_at": datetime.now(UTC).isoformat(),
        }
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        # Made readable by this computer's user only, before the token goes in. Write, then rename.
        temporary = self.path.with_name("github_account.json.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.chmod(temporary, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(json.dumps(account, indent=2))
        temporary.replace(self.path)
        return self.status()

    def disconnect(self) -> None:
        self.path.unlink(missing_ok=True)

    def send(self, draft_id: str) -> dict:
        """Sends a PR or comment draft to GitHub as you, once. Returns the draft with "sent". Runs in a thread."""
        account = self.load()
        if account is None:
            raise SendError("Sign in with GitHub first: the GitHub tab, Account.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        with self.send_lock:
            draft = self.inbox.get(draft_id)
            if draft["sent"] is not None:
                raise SendError(f"It is on GitHub already: {draft['sent']['url']}")
            if draft["kind"] not in ["pr", "comment", "edit"]:
                raise SendError("Only PRs, comments and new titles and descriptions go to GitHub.")
            # The claim a repo's rules ask for goes out before the PR (agents.py): on a fix_issue job, its one comment.
            claims = []
            if draft["kind"] == "pr" and draft["update_of"] is None and draft["job"] is not None:
                for other in self.inbox.list():
                    if other["job"] == draft["job"] and other["kind"] == "comment" and other["status"] == "pending":
                        raise SendError(f"Approve or reject {other['title']} first: the project's rules ask for it before the PR.")
                    # Claims from before the flag were only made where the rules want an assignment (None).
                    waits = other.get("wait_for_assignment") is not False
                    if other["job"] == draft["job"] and other["kind"] == "comment" and other["status"] == "approved" and waits:
                        claims.append(other)
            # A claim whose project's rules want a maintainer to confirm it before a PR (they assign you,
            # wait_for_assignment): the PR waits until GitHub shows you assigned to that issue, so it never goes out
            # unclaimed. A rejected claim doesn't hold it.
            for claim in claims:
                claim_repo, _, claim_number = claim["target"].rpartition("#")
                try:
                    response = httpx.get(f"{API}/repos/{claim_repo}/issues/{claim_number}", headers=headers, timeout=60)
                    response.raise_for_status()
                    assignees = [each["login"].lower() for each in response.json()["assignees"]]
                except httpx.HTTPError as error:
                    raise SendError(f"Could not check whether you are assigned to {claim['target']}: {error}") from None
                if account["login"].lower() not in assignees:
                    raise SendError(
                        f"Not sent yet: the project's rules ask for a maintainer to assign you to {claim['target']} before a PR, "
                        "and GitHub doesn't show you assigned yet. It can go once they do."
                    )
            self.step = "starting"
            self.sending_draft = draft_id
            # What this send already knows from GitHub (tree()): each tree's file list by its sha, and each file's
            # content by its blob sha, so replaying many commits reads every file and list only once.
            self.listings = {}
            self.blobs = {}
            try:
                with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                    if draft["kind"] == "pr" and draft["update_of"]:
                        sent = self.send_update(client, account, draft)
                    elif draft["kind"] == "pr":
                        sent = self.send_pr(client, account, draft)
                        # Made again fresh in place of an older PR of yours: that one is closed now that this one is open.
                        # The new PR is out either way, so a failure here only leaves the old one open.
                        if draft["replaces"] is not None:
                            old_repo, _, old_number = draft["replaces"].rpartition("#")
                            self.step = f"closing {draft['replaces']}"
                            try:
                                response = client.get(f"/repos/{old_repo}/pulls/{old_number}")
                                old = response.json() if response.is_success else None
                                if old is not None and old["state"] == "open" and old["user"]["login"].lower() == account["login"].lower():
                                    response = client.patch(f"/repos/{old_repo}/pulls/{old_number}", json={"state": "closed"})
                                    sent["closed"] = draft["replaces"] if response.is_success else None
                            except httpx.HTTPError:
                                pass
                    elif draft["kind"] == "edit":
                        sent = self.send_edit(client, account, draft)
                    else:
                        sent = self.post_comment(client, account, draft)
            except httpx.HTTPStatusError as error:
                response = error.response
                try:
                    data = response.json()
                except ValueError:
                    data = {}
                message = data.get("message") or f"{response.status_code} {response.reason_phrase}"
                # A 422's reasons are in "errors", as texts or as objects.
                details = []
                for each in data.get("errors", []):
                    if isinstance(each, str):
                        details.append(each)
                    elif isinstance(each, dict):
                        details.append(each.get("message") or each.get("code", ""))
                if details:
                    message += ": " + "; ".join(details)
                if response.status_code == 401:
                    message += ". Sign in with GitHub again: the GitHub tab, Account."
                raise SendError(f"GitHub refused while {self.step}: {message}") from None
            except httpx.HTTPError as error:
                raise SendError(f"Could not reach GitHub while {self.step}: {error}") from None
            finally:
                self.sending_draft = None
            return self.inbox.mark_sent(draft_id, sent)

    def fork(self, client: httpx.Client, account: dict, repo: str) -> str:
        """Your fork of the project ("you/name"), made the first time. Your own repo is its own fork."""
        self.step = "reading the project"
        response = client.get(f"/repos/{repo}")
        response.raise_for_status()
        upstream = response.json()
        if upstream["owner"]["login"].lower() == account["login"].lower():
            return upstream["full_name"]
        self.step = "making your fork"
        # GitHub answers with the fork you already have, when there is one.
        response = client.post(f"/repos/{upstream['full_name']}/forks", json={"default_branch_only": True})
        response.raise_for_status()
        fork = response.json()["full_name"]
        # A new fork takes a moment before its branches can be used.
        self.step = "waiting for your fork"
        deadline = time.monotonic() + FORK_WAIT
        while True:
            response = client.get(f"/repos/{fork}/branches", params={"per_page": 1})
            if response.status_code == 200 and response.json():
                return fork
            if time.monotonic() > deadline:
                raise SendError("GitHub is still making your fork. Try again in a minute.")
            time.sleep(2)

    def pictures(self, client: httpx.Client, account: dict, fork: str, draft: dict) -> str:
        """The draft's body, with its pictures (evidence:ev_...) put on the fork's pr-pictures branch and linked there."""
        body = draft["body"]
        shown = [item for item in draft["evidence"] if item["file"] is not None and f"evidence:{item['id']}" in body]
        if not shown:
            return body
        self.step = "uploading the pictures"
        response = client.get(f"/repos/{fork}/git/ref/heads/{PICTURES_BRANCH}")
        parents = []
        payload = {"tree": []}
        if response.status_code == 200:
            parents = [response.json()["object"]["sha"]]
            response = client.get(f"/repos/{fork}/git/commits/{parents[0]}")
            response.raise_for_status()
            payload["base_tree"] = response.json()["tree"]["sha"]
        elif response.status_code != 404:
            response.raise_for_status()
        for item in shown:
            content = base64.b64encode((EVIDENCE_DIR / item["file"]).read_bytes()).decode()
            response = client.post(f"/repos/{fork}/git/blobs", json={"content": content, "encoding": "base64"})
            response.raise_for_status()
            payload["tree"].append({"path": f"{draft['id']}/{item['file']}", "mode": "100644", "type": "blob", "sha": response.json()["sha"]})
        response = client.post(f"/repos/{fork}/git/trees", json=payload)
        response.raise_for_status()
        author = {"name": account["name"], "email": f"{account['id']}+{account['login']}@users.noreply.github.com"}
        message = f"Pictures for {draft['title']}"
        response = client.post(f"/repos/{fork}/git/commits", json={"message": message, "tree": response.json()["sha"], "parents": parents, "author": author})
        response.raise_for_status()
        commit = response.json()["sha"]
        if parents:
            response = client.patch(f"/repos/{fork}/git/refs/heads/{PICTURES_BRANCH}", json={"sha": commit})
        else:
            response = client.post(f"/repos/{fork}/git/refs", json={"ref": f"refs/heads/{PICTURES_BRANCH}", "sha": commit})
        response.raise_for_status()
        # By the commit, so a link never changes. A private repo's raw files need a sign-in that raw.githubusercontent.com
        # never gets from a page: there GitHub's own address shows them, to whoever may see the repo.
        response = client.get(f"/repos/{fork}")
        response.raise_for_status()
        private = response.json()["private"]
        for item in shown:
            link = f"https://raw.githubusercontent.com/{fork}/{commit}/{draft['id']}/{item['file']}"
            if private:
                link = f"https://github.com/{fork}/blob/{commit}/{draft['id']}/{item['file']}?raw=true"
            body = body.replace(f"evidence:{item['id']}", link)
        return body

    def tree(self, client: httpx.Client, fork: str, base_tree: str, diff: str) -> str:
        """The tree of the base commit with the diff applied, made in the fork. Returns its sha."""
        with tempfile.TemporaryDirectory() as folder:
            patch = Path(folder) / "change.patch"
            work = Path(folder) / "files"
            work.mkdir()
            # git apply wants the last line to end with a newline.
            if not diff.endswith("\n"):
                diff = diff + "\n"
            patch.write_text(diff)

            # Every path the diff touches. -z keeps odd names whole: "added\tremoved\tpath" each, "-" counts for a
            # binary file. A rename is there by its new name only; its old name is in the diff's "rename from" line.
            result = subprocess.run(["git", "apply", "--numstat", "-z", str(patch)], cwd=work, capture_output=True, text=True, env=GIT_ENV)
            if result.returncode != 0:
                raise SendError(f"The diff can't be read: {result.stderr.strip()}")
            paths = []
            for part in result.stdout.split("\0"):
                if part == "":
                    continue
                fields = part.split("\t", 2)
                if fields[0] == "-":
                    raise SendError("The diff changes a binary file, which a diff can't carry. Download the .patch and send it yourself.")
                paths.append(fields[2])
            # Header lines only: a changed line in a hunk always starts with " ", "+", "-" or "\".
            for line in diff.split("\n"):
                if not line.startswith("rename from ") and not line.startswith("copy from "):
                    continue
                old = line.split(" ", 2)[2]
                if old.startswith('"'):
                    raise SendError(f"The diff renames a file with an unusual name ({old}). Download the .patch and send it yourself.")
                paths.append(old)

            # Those files as the base commit has them, from GitHub: its file list, read once per send for the first
            # tree (the next ones are known from what was changed), and each file once. The caller's step says which
            # change this is.
            entries = self.listings.get(base_tree)
            if entries is None:
                response = client.get(f"/repos/{fork}/git/trees/{base_tree}", params={"recursive": "1"})
                response.raise_for_status()
                listing = response.json()
                if listing["truncated"]:
                    raise SendError("The project has too many files for GitHub to list at once, so the change can't be built here. Download the .patch and send it yourself.")
                entries = {item["path"]: item for item in listing["tree"]}
            for path in paths:
                entry = entries.get(path)
                # A new file.
                if entry is None:
                    continue
                if entry["type"] != "blob":
                    raise SendError(f"The change touches {path}, a folder or submodule in the project, which can't be sent from here.")
                content = self.blobs.get(entry["sha"])
                if content is None:
                    response = client.get(f"/repos/{fork}/git/blobs/{entry['sha']}")
                    response.raise_for_status()
                    content = base64.b64decode(response.json()["content"])
                    self.blobs[entry["sha"]] = content
                target = work / path
                target.parent.mkdir(parents=True, exist_ok=True)
                if entry["mode"] == "120000":
                    os.symlink(content.decode(), target)
                    continue
                target.write_bytes(content)
                if entry["mode"] == "100755":
                    target.chmod(0o755)

            result = subprocess.run(["git", "apply", str(patch)], cwd=work, capture_output=True, text=True, env=GIT_ENV)
            if result.returncode != 0:
                raise SendError(f"The diff doesn't apply to the commit the agent started from: {result.stderr.strip()}")

            # What each path is now: gone (deleted, or the old name of a rename), or a file to upload.
            # A link is read as a link, never followed, so nothing outside the folder can get in.
            # A file GitHub has already (its blob sha, worked out here the way git does) is only named; a text file
            # goes inside the tree itself, one request for all of them; only another kind is uploaded on its own.
            root = work.resolve()
            tree = []
            changed = {}
            made = {}
            for path in paths:
                target = work / path
                if target.parent.resolve() != root and root not in target.parent.resolve().parents:
                    raise SendError(f"{path} is outside the project.")
                if not os.path.lexists(target):
                    if path in entries:
                        tree.append({"path": path, "mode": entries[path]["mode"], "type": "blob", "sha": None})
                        changed[path] = None
                    continue
                if target.is_symlink():
                    mode = "120000"
                    content = os.readlink(target).encode()
                else:
                    mode = "100644"
                    if os.access(target, os.X_OK):
                        mode = "100755"
                    content = target.read_bytes()
                sha = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
                changed[path] = {"path": path, "mode": mode, "type": "blob", "sha": sha}
                if sha in self.blobs:
                    tree.append({"path": path, "mode": mode, "type": "blob", "sha": sha})
                    continue
                text = None
                if len(content) < INLINE_BYTES:
                    try:
                        text = content.decode("utf-8")
                    except UnicodeDecodeError:
                        text = None
                if text is not None:
                    tree.append({"path": path, "mode": mode, "type": "blob", "content": text})
                    made[sha] = content
                    continue
                encoded = base64.b64encode(content).decode()
                response = client.post(f"/repos/{fork}/git/blobs", json={"content": encoded, "encoding": "base64"})
                response.raise_for_status()
                self.blobs[response.json()["sha"]] = content
                tree.append({"path": path, "mode": mode, "type": "blob", "sha": response.json()["sha"]})

        response = client.post(f"/repos/{fork}/git/trees", json={"base_tree": base_tree, "tree": tree})
        response.raise_for_status()
        new_tree = response.json()["sha"]
        # GitHub has the text files now too, and the new tree's file list is the old one with these changes.
        self.blobs.update(made)
        new_entries = dict(entries)
        for path, entry in changed.items():
            if entry is None:
                new_entries.pop(path, None)
            else:
                new_entries[path] = entry
        self.listings[base_tree] = entries
        self.listings[new_tree] = new_entries
        return new_tree

    def send_pr(self, client: httpx.Client, account: dict, draft: dict) -> dict:
        repo = draft["repo"]
        base_sha = draft["base_sha"]
        if repo is None or base_sha == "":
            raise SendError(
                "This draft is from before sending was added, and doesn't say which commit it starts from. "
                "Reply to the agent to draft it again, or download the .patch and send it yourself."
            )
        # Only the agent's own commits go out (the user's rule): a draft from before draft_pr refused others' isn't sent.
        for each in draft["commits"]:
            if not each["own"]:
                raise SendError(
                    f"The commit {each['sha'][:10]} is by {each['author']['name']}, not the agent, and nobody else's work goes out "
                    "with your name. Reply to the agent to redo the fix on its own and draft it again."
                )
        fork = self.fork(client, account, repo)
        base_branch = ""
        if draft["base"].startswith("origin/"):
            base_branch = draft["base"].removeprefix("origin/")
        if base_branch == "" or base_branch == "HEAD":
            self.step = "reading the project"
            response = client.get(f"/repos/{repo}")
            response.raise_for_status()
            base_branch = response.json()["default_branch"]

        # GitHub shares the project's commits with its forks; an old fork may need to catch up first.
        self.step = "finding the agent's starting commit in your fork"
        response = client.get(f"/repos/{fork}/git/commits/{base_sha}")
        if response.status_code == 404:
            client.post(f"/repos/{fork}/merge-upstream", json={"branch": base_branch})
            response = client.get(f"/repos/{fork}/git/commits/{base_sha}")
        response.raise_for_status()
        base_tree = response.json()["tree"]["sha"]

        body = self.pictures(client, account, fork, draft)
        # Exactly the diff you reviewed: where the commits must end.
        self.step = "building the change you reviewed"
        tree = self.tree(client, fork, base_tree, draft["diff"])
        you = {"name": account["name"], "email": f"{account['id']}+{account['login']}@users.noreply.github.com"}

        # The branch's commits as the agent made them, each on the last.
        commit = base_sha
        commit_tree = base_tree
        try:
            for index, each in enumerate(draft["commits"]):
                self.step = f"replaying commit {index + 1} of {len(draft['commits'])} ({each['sha'][:10]})"
                each_tree = commit_tree
                if each["diff"].strip() != "":
                    each_tree = self.tree(client, fork, commit_tree, each["diff"])
                message = each["message"]
                if each["vm_email"] != "":
                    message = message.replace(each["vm_email"], you["email"])
                payload = {"message": message, "tree": each_tree, "parents": [commit], "author": you, "committer": you}
                response = client.post(f"/repos/{fork}/git/commits", json=payload)
                response.raise_for_status()
                commit = response.json()["sha"]
                commit_tree = each_tree
        except SendError:
            # They don't replay (a binary file in one, say): one commit then.
            commit = base_sha
            commit_tree = base_tree
        # What the commits don't have (changes never committed, or no commits kept): one more commit.
        if commit_tree != tree:
            self.step = "making the commit"
            message = draft["title"]
            response = client.post(f"/repos/{fork}/git/commits", json={"message": message, "tree": tree, "parents": [commit], "author": you})
            response.raise_for_status()
            commit = response.json()["sha"]

        # The agent's branch name, unless it worked on the main branch (or no branch at all).
        self.step = "making the branch in your fork"
        name = draft["branch"]
        if name in ["", "HEAD", "main", "master", base_branch]:
            number = (draft["target"] or "").rpartition("#")[2]
            name = f"fix-{number}" if number.isdigit() else f"fix-{draft['id'].removeprefix('draft_')}"
        branch = name
        # 422: a branch of that name is there already.
        for attempt in range(2, 12):
            response = client.post(f"/repos/{fork}/git/refs", json={"ref": f"refs/heads/{branch}", "sha": commit})
            if response.status_code != 422:
                break
            branch = f"{name}-{attempt}"
        response.raise_for_status()

        self.step = "opening the PR"
        head = branch
        if fork != repo:
            head = f"{fork.split('/')[0]}:{branch}"
        payload = {"title": draft["title"], "body": body, "head": head, "base": base_branch, "maintainer_can_modify": True}
        response = client.post(f"/repos/{repo}/pulls", json=payload)
        if response.status_code >= 400:
            # No PR, no branch left behind: trying again starts clean.
            client.delete(f"/repos/{fork}/git/refs/heads/{branch}")
        response.raise_for_status()
        pull = response.json()
        return {
            "kind": "pr",
            "url": pull["html_url"],
            "number": pull["number"],
            "repo": repo,
            "fork": fork,
            "branch": branch,
            "base_branch": base_branch,
            "base_sha": base_sha,
            "commit": commit,
            "as": account["login"],
            "at": datetime.now(UTC).isoformat(),
        }

    def send_update(self, client: httpx.Client, account: dict, draft: dict) -> dict:
        """The agent's next version of your open PR: its commits on top of the PR's newest commit, the PR's branch moved
        to them (no force), then the body posted on the PR as your comment. A rebase (rebase_of): its commits on
        base_sha instead, and the branch force-moved to them, only while it is still at rebase_of."""
        repo, _, number = (draft["update_of"] or "").rpartition("#")
        base_sha = draft["base_sha"]
        if repo == "" or not number.isdigit() or base_sha == "":
            raise SendError("This draft doesn't say which PR or commit it is for. Reply to the agent to draft it again.")
        # Only the agent's own commits go out (the user's rule), as for a new PR.
        for each in draft["commits"]:
            if not each["own"]:
                raise SendError(
                    f"The commit {each['sha'][:10]} is by {each['author']['name']}, not the agent, and nobody else's work goes out "
                    "with your name. Reply to the agent to redo the fix on its own and draft it again."
                )

        self.step = "reading the PR"
        response = client.get(f"/repos/{repo}/pulls/{number}")
        response.raise_for_status()
        pull = response.json()
        if pull["merged"]:
            raise SendError(f"{repo}#{number} is merged already: there is no PR to push onto.")
        if pull["state"] != "open":
            raise SendError(f"{repo}#{number} is closed: reopen it first.")
        if pull["user"]["login"].lower() != account["login"].lower():
            raise SendError(f"{repo}#{number} isn't yours: it was opened by {pull['user']['login']}.")
        head = pull["head"]
        if head["repo"] is None:
            raise SendError("The PR's branch is gone: its fork was deleted.")
        if head["repo"]["owner"]["login"].lower() != account["login"].lower():
            raise SendError(f"The PR's branch is in {head['repo']['full_name']}, not in your fork.")
        # Where the branch must still be: the PR's newest commit the agent saw. A new version starts there; a rebase
        # replaces it.
        rebase_of = draft["rebase_of"]
        expected = base_sha
        if rebase_of:
            expected = rebase_of
        if head["sha"] != expected:
            raise SendError("The PR's branch changed since the agent drafted this: Redraft, so the agent works on top of its newest commit.")
        fork = head["repo"]["full_name"]
        branch = head["ref"]

        self.step = "reading the commit the new version starts from"
        response = client.get(f"/repos/{fork}/git/commits/{base_sha}")
        # A rebase starts on the project's newer commit: GitHub shares it with forks, but an old fork may need to catch up.
        if response.status_code == 404 and rebase_of:
            client.post(f"/repos/{fork}/merge-upstream", json={"branch": pull["base"]["ref"]})
            response = client.get(f"/repos/{fork}/git/commits/{base_sha}")
        response.raise_for_status()
        base_tree = response.json()["tree"]["sha"]

        body = self.pictures(client, account, fork, draft)
        # Exactly the diff you reviewed: where the commits must end.
        self.step = "building the change you reviewed"
        tree = self.tree(client, fork, base_tree, draft["diff"])
        you = {"name": account["name"], "email": f"{account['id']}+{account['login']}@users.noreply.github.com"}

        # The agent's commits as it made them, each on the last, starting at the PR's newest commit.
        commit = base_sha
        commit_tree = base_tree
        try:
            for index, each in enumerate(draft["commits"]):
                self.step = f"replaying commit {index + 1} of {len(draft['commits'])} ({each['sha'][:10]})"
                each_tree = commit_tree
                if each["diff"].strip() != "":
                    each_tree = self.tree(client, fork, commit_tree, each["diff"])
                message = each["message"]
                if each["vm_email"] != "":
                    message = message.replace(each["vm_email"], you["email"])
                payload = {"message": message, "tree": each_tree, "parents": [commit], "author": you, "committer": you}
                response = client.post(f"/repos/{fork}/git/commits", json=payload)
                response.raise_for_status()
                commit = response.json()["sha"]
                commit_tree = each_tree
        except SendError:
            # They don't replay (a binary file in one, say): one commit then.
            commit = base_sha
            commit_tree = base_tree
        # What the commits don't have (changes never committed, or no commits kept): one more commit.
        if commit_tree != tree:
            self.step = "making the commit"
            message = draft["title"]
            response = client.post(f"/repos/{fork}/git/commits", json={"message": message, "tree": tree, "parents": [commit], "author": you})
            response.raise_for_status()
            commit = response.json()["sha"]

        # A fast-forward only: if the branch moved in the meantime, GitHub refuses and nothing is lost.
        if not rebase_of:
            self.step = "pushing onto the PR's branch"
            response = client.patch(f"/repos/{fork}/git/refs/heads/{branch}", json={"sha": commit, "force": False})
            response.raise_for_status()
        # A rebase is a force push, which GitHub can't make wait for the branch to be where it was: it is read once
        # more right before, so the time a push of yours could land in between and be lost is as short as can be.
        if rebase_of:
            self.step = "checking the PR's branch once more"
            response = client.get(f"/repos/{fork}/git/ref/heads/{branch}")
            response.raise_for_status()
            if response.json()["object"]["sha"] != rebase_of:
                raise SendError("The PR's branch changed while this was being sent: nothing was pushed. Redraft, so the agent works on its newest commit.")
            self.step = "force-pushing onto the PR's branch"
            response = client.patch(f"/repos/{fork}/git/refs/heads/{branch}", json={"sha": commit, "force": True})
            response.raise_for_status()

        # The new version is on the PR now: a comment GitHub refuses (a locked conversation, say) doesn't undo that, so
        # it is kept with what was sent instead of failing the send.
        comment_url = None
        comment_error = None
        if body.strip() != "":
            self.step = "posting the comment on the PR"
            try:
                response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": body})
            except httpx.HTTPError as error:
                comment_error = f"Could not reach GitHub: {error}"
            if comment_error is None and response.status_code >= 400:
                comment_error = f"GitHub answered {response.status_code}: {response.text[:200]}"
            if comment_error is None:
                comment_url = response.json()["html_url"]
        return {
            "kind": "pr",
            "update": True,
            "rebase_of": rebase_of,
            "url": pull["html_url"],
            "number": int(number),
            "repo": repo,
            "fork": fork,
            "branch": branch,
            "base_branch": pull["base"]["ref"],
            "base_sha": base_sha,
            "commit": commit,
            "comment_url": comment_url,
            "comment_error": comment_error,
            "as": account["login"],
            "at": datetime.now(UTC).isoformat(),
        }

    def post_comment(self, client: httpx.Client, account: dict, draft: dict) -> dict:
        repo, _, number = (draft["target"] or "").rpartition("#")
        if repo == "" or not number.isdigit():
            raise SendError("This comment has no issue or PR to go on.")
        body = draft["body"]
        # Pictures need a place on GitHub: your fork.
        if any(item["file"] is not None and f"evidence:{item['id']}" in body for item in draft["evidence"]):
            fork = self.fork(client, account, repo)
            body = self.pictures(client, account, fork, draft)
        self.step = "posting the comment"
        response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": body})
        response.raise_for_status()
        comment = response.json()
        return {
            "kind": "comment",
            "url": comment["html_url"],
            "id": comment["id"],
            "repo": repo,
            "number": int(number),
            "as": account["login"],
            "at": datetime.now(UTC).isoformat(),
        }

    def send_edit(self, client: httpx.Client, account: dict, draft: dict) -> dict:
        """A new title and description for your own PR or issue, only while it still has the text the agent saw."""
        repo, _, number = (draft["target"] or "").rpartition("#")
        if repo == "" or not number.isdigit() or draft["previous"] is None:
            raise SendError("This draft doesn't say which PR or issue it is for. Reply to the agent to draft it again.")
        # GitHub's issues API is the PR's too, for its title and description.
        self.step = "reading it"
        response = client.get(f"/repos/{repo}/issues/{number}")
        response.raise_for_status()
        thread = response.json()
        if thread["user"]["login"].lower() != account["login"].lower():
            raise SendError(f"{repo}#{number} isn't yours: it was opened by {thread['user']['login']}.")
        # Someone may have changed it since (you, on GitHub): nothing of theirs is written over. Line ends as GitHub's
        # web editor saves them don't count.
        now_title = thread["title"]
        now_body = (thread["body"] or "").replace("\r\n", "\n").strip()
        if now_title != draft["previous"]["title"] or now_body != draft["previous"]["body"].replace("\r\n", "\n").strip():
            raise SendError("Its title or description changed since the agent drafted this: Redraft, so the agent works on the text as it is now.")
        body = draft["body"]
        if any(item["file"] is not None and f"evidence:{item['id']}" in body for item in draft["evidence"]):
            fork = self.fork(client, account, repo)
            body = self.pictures(client, account, fork, draft)
        self.step = "changing the title and description"
        response = client.patch(f"/repos/{repo}/issues/{number}", json={"title": draft["title"], "body": body})
        response.raise_for_status()
        return {
            "kind": "edit",
            "url": thread["html_url"],
            "repo": repo,
            "number": int(number),
            "title": draft["title"],
            "as": account["login"],
            "at": datetime.now(UTC).isoformat(),
        }

    def comment(self, target: str, body: str) -> dict:
        """Posts your own comment, as you, on a PR or issue (target "owner/name#n"): the comment box on the GitHub tab.
        Returns {"url", "id"}; SendError says why it didn't. Runs in a thread."""
        account = self.load()
        if account is None:
            raise SendError("Sign in with GitHub first: the GitHub tab, Account.")
        repo, _, number = target.rpartition("#")
        if repo.count("/") != 1 or not number.isdigit():
            raise SendError(f"{target} isn't a PR or issue (owner/name#number).")
        if body.strip() == "":
            raise SendError("The comment is empty.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        try:
            with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                response = client.post(f"/repos/{repo}/issues/{number}/comments", json={"body": body})
                response.raise_for_status()
                comment = response.json()
        except httpx.HTTPStatusError as error:
            response = error.response
            try:
                data = response.json()
            except ValueError:
                data = {}
            message = data.get("message") or f"{response.status_code} {response.reason_phrase}"
            # A 422's reasons are in "errors", as texts or as objects.
            details = []
            for each in data.get("errors", []):
                if isinstance(each, str):
                    details.append(each)
                elif isinstance(each, dict):
                    details.append(each.get("message") or each.get("code", ""))
            if details:
                message += ": " + "; ".join(details)
            if response.status_code == 401:
                message += ". Sign in with GitHub again: the GitHub tab, Account."
            raise SendError(f"GitHub refused: {message}") from None
        except httpx.HTTPError as error:
            raise SendError(f"Could not reach GitHub: {error}") from None
        return {"url": comment["html_url"], "id": comment["id"]}

    def open_issue(self, repo: str, title: str, body: str) -> dict:
        """Opens an issue on repo ("owner/name") as you, claimed for you. Returns {"repo" (GitHub's spelling), "number",
        "url", "title", "claimed": "assigned" (GitHub kept you as its assignee), "comment" (it didn't, so your comment
        CLAIM_TEXT says you are on it) or "none" (that comment failed too)}; SendError says why it didn't open. Runs in
        a thread."""
        account = self.load()
        if account is None:
            raise SendError("Sign in with GitHub first: the GitHub tab, Account.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        try:
            with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                response = client.post(f"/repos/{repo}/issues", json={"title": title, "body": body, "assignees": [account["login"]]})
                response.raise_for_status()
                issue = response.json()
        except httpx.HTTPStatusError as error:
            response = error.response
            try:
                data = response.json()
            except ValueError:
                data = {}
            message = data.get("message") or f"{response.status_code} {response.reason_phrase}"
            # A 422's reasons are in "errors", as texts or as objects.
            details = []
            for each in data.get("errors", []):
                if isinstance(each, str):
                    details.append(each)
                elif isinstance(each, dict):
                    details.append(each.get("message") or each.get("code", ""))
            if details:
                message += ": " + "; ".join(details)
            if response.status_code == 401:
                message += ". Sign in with GitHub again: the GitHub tab, Account."
            raise SendError(f"GitHub refused: {message}") from None
        except httpx.HTTPError as error:
            raise SendError(f"Could not reach GitHub: {error}") from None
        repo_name = issue["repository_url"].removeprefix(f"{API}/repos/")
        # Claimed for you: assigned, or where GitHub doesn't let you assign (not one of the repo's own people), your
        # comment saying you are on it. The issue is open either way, so a failed comment doesn't fail it.
        claimed = "assigned"
        if not any(each["login"].lower() == account["login"].lower() for each in issue["assignees"]):
            claimed = "none"
            try:
                with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                    response = client.post(f"/repos/{repo_name}/issues/{issue['number']}/comments", json={"body": CLAIM_TEXT})
                    if response.is_success:
                        claimed = "comment"
            except httpx.HTTPError:
                pass
        return {
            "repo": repo_name,
            "number": issue["number"],
            "url": issue["html_url"],
            "title": issue["title"],
            "claimed": claimed,
        }

    def manage(self, action: str, repo: str, number: int, sha: str = "", expected_head: str = "") -> str:
        """One change on GitHub from the GitHub tab, as you. action: "close" or "reopen" your PR repo#number,
        "update_branch" (your open PR: GitHub merges its base in), "reset_branch" (your open PR's branch in your fork goes
        back to sha, force-pushed, only while its newest commit is still expected_head), "delete_branch" (a closed or
        merged PR's branch, from your fork), or "delete_comment" (number is the comment's id on GitHub). Returns what
        happened, in words; SendError says why it didn't. Runs in a thread."""
        account = self.load()
        if account is None:
            raise SendError("Sign in with GitHub first: the GitHub tab, Account.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        try:
            with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                if action == "delete_comment":
                    response = client.delete(f"/repos/{repo}/issues/comments/{number}")
                    if response.status_code == 404:
                        return "The comment is gone already."
                    response.raise_for_status()
                    return "Deleted the comment."

                response = client.get(f"/repos/{repo}/pulls/{number}")
                response.raise_for_status()
                pull = response.json()
                if pull["user"]["login"].lower() != account["login"].lower():
                    raise SendError(f"{repo}#{number} isn't yours: it was opened by {pull['user']['login']}.")
                if action in ["close", "reopen"]:
                    if pull["merged"]:
                        raise SendError("It is merged already.")
                    state = "closed"
                    if action == "reopen":
                        state = "open"
                    response = client.patch(f"/repos/{repo}/pulls/{number}", json={"state": state})
                    response.raise_for_status()
                    if action == "reopen":
                        return "Reopened it."
                    return "Closed it."
                if action == "reset_branch":
                    if pull["state"] != "open":
                        raise SendError("It isn't open.")
                    head = pull["head"]
                    if head["repo"] is None or head["repo"]["owner"]["login"].lower() != account["login"].lower():
                        raise SendError("Its branch isn't in your fork.")
                    if head["sha"] != expected_head:
                        raise SendError("Its branch moved since the last push from here (someone else pushed): nothing was taken back.")
                    response = client.patch(f"/repos/{head['repo']['full_name']}/git/refs/heads/{head['ref']}", json={"sha": sha, "force": True})
                    response.raise_for_status()
                    return f"Its branch {head['ref']} is back at {sha[:10]}: the commits after it are off the PR."
                if action == "update_branch":
                    if pull["state"] != "open":
                        raise SendError("It isn't open.")
                    # Only from the head GitHub has now, so nothing pushed meanwhile is merged over unseen.
                    response = client.put(f"/repos/{repo}/pulls/{number}/update-branch", json={"expected_head_sha": pull["head"]["sha"]})
                    response.raise_for_status()
                    return f"GitHub is merging the newest {pull['base']['ref']} into its branch now."
                if action == "delete_branch":
                    # Deleting an open PR's branch would close it without a word: close it first.
                    if pull["state"] != "closed":
                        raise SendError("Close the PR first.")
                    head = pull["head"]
                    if head["repo"] is None:
                        return "Its branch is gone already."
                    if head["repo"]["owner"]["login"].lower() != account["login"].lower():
                        raise SendError(f"Its branch is in {head['repo']['full_name']}, not in your fork.")
                    response = client.delete(f"/repos/{head['repo']['full_name']}/git/refs/heads/{head['ref']}")
                    if response.status_code in [404, 422]:
                        return "Its branch is gone already."
                    response.raise_for_status()
                    return f"Deleted the branch {head['ref']} from {head['repo']['full_name']}."
        except httpx.HTTPStatusError as error:
            response = error.response
            try:
                data = response.json()
            except ValueError:
                data = {}
            message = data.get("message") or f"{response.status_code} {response.reason_phrase}"
            if response.status_code == 401:
                message += ". Sign in with GitHub again: the GitHub tab, Account."
            raise SendError(f"GitHub refused: {message}") from None
        except httpx.HTTPError as error:
            raise SendError(f"Could not reach GitHub: {error}") from None
        raise SendError(f"Unknown action {action}.")
