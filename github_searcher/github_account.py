"""Your GitHub account: the one token that sends what you approve in the Inbox, as you.

Settings (SettingsDialog.tsx) takes the token. connect() checks it with GitHub and keeps it in
DATA_DIR/github_account.json, a file only this computer's user may read. The browser only ever gets
status(): who it is connected as and what the token may do, never the token. Agents, Sherpa and the
VMs never get it either; only the Inbox's Approve and Send to GitHub use it (backend/inbox_api.py).
It is kept apart from the search tokens in .env (token_balancer.py), which only read.

It must be a classic token with the public_repo scope: GitHub's fine-grained tokens can't open a PR
or post a comment on a project you don't own.

send(draft_id) sends a PR or comment draft once, as it was shown in the Inbox. A PR:
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
A comment is posted on its issue or PR (its pictures go to your fork the same way).

What was sent is kept on the draft as "sent" (Inbox.mark_sent):

    PR:      {"kind": "pr", "url", "number", "repo", "fork", "branch", "base_branch", "base_sha",
              "commit", "as": "<your login>", "at"}
    comment: {"kind": "comment", "url", "id", "repo", "number", "as", "at"}

Later (not built yet): following a sent PR and acting on it. "sent" has what that needs: the number,
to read the PR's reviews, comments and checks into the Inbox; and the fork, branch and commit, to
push the agent's next version onto the same PR (tree() on base_sha with the new diff, in a commit
whose parent is "commit").

Sends go one at a time (a second click waits, then finds the draft sent). A failure raises SendError
with what GitHub said and at which step; nothing is kept on the draft then.
"""

import base64
import json
import os
import subprocess
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

from github_searcher.jobs import EVIDENCE_DIR

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
API = "https://api.github.com"
PICTURES_BRANCH = "pr-pictures"
# Seconds a new fork may take before its branches can be used.
FORK_WAIT = 120
# git without the user's own git settings, and never looking for a repo above the temporary folder.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CEILING_DIRECTORIES": tempfile.gettempdir()}


class SendError(Exception):
    pass


class GithubAccount:
    def __init__(self, inbox):
        self.inbox = inbox
        self.path = DATA_DIR / "github_account.json"
        self.send_lock = threading.Lock()
        # The step a send is at, for its error message. Only changed with send_lock held.
        self.step = ""

    def load(self) -> dict | None:
        if not self.path.is_file():
            return None
        return json.loads(self.path.read_text())

    def status(self) -> dict:
        """What the browser may know: who it is and what the token may do. Never the token."""
        account = self.load()
        if account is None:
            return {"connected": False}
        return {"connected": True, "login": account["login"], "name": account["name"], "scopes": account["scopes"], "connected_at": account["connected_at"]}

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
            raise SendError("Connect your GitHub account in Settings first.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        with self.send_lock:
            draft = self.inbox.get(draft_id)
            if draft["sent"] is not None:
                raise SendError(f"It is on GitHub already: {draft['sent']['url']}")
            if draft["kind"] not in ["pr", "comment"]:
                raise SendError("Only PRs and comments go to GitHub.")
            self.step = "starting"
            try:
                with httpx.Client(base_url=API, headers=headers, timeout=60) as client:
                    if draft["kind"] == "pr":
                        sent = self.send_pr(client, account, draft)
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
                    message += ". Connect your account again in Settings, with a new token."
                raise SendError(f"GitHub refused while {self.step}: {message}") from None
            except httpx.HTTPError as error:
                raise SendError(f"Could not reach GitHub while {self.step}: {error}") from None
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
        # By the commit, so a link never changes.
        for item in shown:
            body = body.replace(f"evidence:{item['id']}", f"https://raw.githubusercontent.com/{fork}/{commit}/{draft['id']}/{item['file']}")
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

            # Those files as the base commit has them, from GitHub.
            self.step = "reading the files the change touches"
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
                response = client.get(f"/repos/{fork}/git/blobs/{entry['sha']}")
                response.raise_for_status()
                content = base64.b64decode(response.json()["content"])
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
            self.step = "uploading the change"
            root = work.resolve()
            tree = []
            for path in paths:
                target = work / path
                if target.parent.resolve() != root and root not in target.parent.resolve().parents:
                    raise SendError(f"{path} is outside the project.")
                if not os.path.lexists(target):
                    if path in entries:
                        tree.append({"path": path, "mode": entries[path]["mode"], "type": "blob", "sha": None})
                    continue
                if target.is_symlink():
                    mode = "120000"
                    content = os.readlink(target).encode()
                else:
                    mode = "100644"
                    if os.access(target, os.X_OK):
                        mode = "100755"
                    content = target.read_bytes()
                encoded = base64.b64encode(content).decode()
                response = client.post(f"/repos/{fork}/git/blobs", json={"content": encoded, "encoding": "base64"})
                response.raise_for_status()
                tree.append({"path": path, "mode": mode, "type": "blob", "sha": response.json()["sha"]})

        response = client.post(f"/repos/{fork}/git/trees", json={"base_tree": base_tree, "tree": tree})
        response.raise_for_status()
        return response.json()["sha"]

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
        tree = self.tree(client, fork, base_tree, draft["diff"])
        you = {"name": account["name"], "email": f"{account['id']}+{account['login']}@users.noreply.github.com"}

        # The branch's commits as the agent made them, each on the last.
        commit = base_sha
        commit_tree = base_tree
        try:
            for each in draft["commits"]:
                self.step = f"replaying the commit {each['sha'][:10]}"
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
