"""Updates of the live copy of the app: the latest release of this repo on GitHub, made ready in the background, and the
switch to it when you press Restart (Update in the header, UpdateDialog.tsx; Settings → About, About.tsx).

The live copy (deploy/install.sh makes it) lives in SERAPH_HOME (~/seraph), which the service seraph sets:

    current -> releases/<tag>     the release that runs
    releases/<tag>/               a release: its code, .venv, its built page (frontend/dist), .env (a link) and VERSION
    backups/<time>-<tag>/         data/ as it was before each switch (the last 10)
    previous                      "<tag> <backup>": the release before this one, and data/ from just before the switch
    failed                        the release the last switch went to, when it didn't start or went wrong in its first
                                  minutes (switch.sh went back), and failed-reason why
    failed-crashes.json           the errors that release reported, until the release before it reports them (crashes.py)
    check-data/                   a copy of data/ for a new release's check, only while it runs
    data/, .env                   yours, the same for every release

It runs as the user service seraph, which only ./live.sh starts. Without SERAPH_HOME (./run.sh: the code in the
folder you edit) there are no updates, and the version is "dev".

check() asks GitHub for the latest release of SERAPH_REPO with your GitHub sign in (it can read your private repos).
When that isn't the release that runs, it makes it ready: downloads its code, installs its Python packages (uv sync)
and builds its page (npm ci, npm run build), in releases/<tag>/, then checks it (check_release): it starts on a copy of
data/ (check-data/, without the VMs) on its own port (BACKEND_PORT + 2) with SERAPH_CHECK=1 (backend/app.py: nothing
in the background runs), and must answer /api/health, serve its page and send every topic of its live feed with no
error. VERSION is written last, so a release folder with one is ready and checked. A release that fails its check is
never made ready: why is in error, and in the app's errors (crashes.py), so it becomes an issue. Neither is the release
the last switch took back (failed).

Restart in the Update dialog installs a ready release (backend/updates_api.py; AUTO_INSTALL there would do it by
itself). switch() runs deploy/switch.sh outside the app
(systemd-run), since the app stops on the way. It stops the app, copies data/ to backups/, points current at the
release and starts it. When the release doesn't answer on /api/health within a minute, data/ and current go back and
the release before starts again. After that it watches the release for WATCH minutes (switch.sh): when it stops
answering for a minute or reports too many errors, the same happens, and what went wrong is kept for the release before.
"""

import json
import os
import shutil
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
from websockets.sync.client import connect

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# "" in the dev copy: no updates.
HOME = os.environ.get("SERAPH_HOME", "")
# owner/name on GitHub (deploy/install.sh puts it in the live copy's .env).
REPO = os.environ.get("SERAPH_REPO", "")
API = "https://api.github.com"
# How often the backend asks GitHub for a newer release (backend/updates_api.py).
CHECK_SECONDS = 15 * 60
# The most a step of making a release ready may take (npm ci on a slow network).
STEP_SECONDS = 15 * 60
# A new release's check: the most it may take to answer, and how long its live feed is read.
CHECK_START_SECONDS = 120
CHECK_FEED_SECONDS = 10
# Every topic the live feed sends (backend/app.py): the check needs each of them.
TOPICS = ["repos", "issues", "tracked", "explore", "github", "jobs", "inbox", "issue_drafts", "prs", "your_repos", "notifications",
          "agents", "vms", "images", "resource", "updates", "projects", "crashes"]


class Updates:
    def __init__(self, github_account, crashes):
        self.github_account = github_account
        # The app's own errors: a release that fails its check is one.
        self.crashes = crashes
        # Releases that failed their check since the backend started, with why: not made ready again.
        self.rejected = {}
        # Goes up on every change, for the live feed (topic "updates").
        self.version = 0
        # The release that runs: the VERSION file a release gets when it is made ready.
        self.running = "dev"
        if (PROJECT_ROOT / "VERSION").is_file():
            self.running = (PROJECT_ROOT / "VERSION").read_text().strip()
        # The latest release on GitHub: {"tag", "name", "notes", "published_at", "url"}, or None.
        self.latest = None
        # A newer release that is ready to switch to, or None.
        self.ready = None
        # The release being made ready right now, or None.
        self.preparing = None
        self.checking = False
        self.checked_at = None
        self.error = ""
        # Set by Restart and Previous version, until the app stops.
        self.restarting = False
        # Check for updates: the backend checks at once (keep_updates).
        self.asked = False
        self.lock = threading.Lock()

    def previous(self) -> tuple[str | None, str | None]:
        """The release before this one and the copy of data/ from just before the switch to this one (switch.sh)."""
        if HOME == "" or not (Path(HOME) / "previous").is_file():
            return None, None
        tag, backup = (Path(HOME) / "previous").read_text().split()
        return tag, backup

    def summary(self) -> dict:
        previous = self.previous()[0]
        switched_at = None
        if previous is not None:
            switched_at = datetime.fromtimestamp((Path(HOME) / "previous").stat().st_mtime, UTC).isoformat()
        failed = None
        failed_reason = ""
        if HOME != "" and (Path(HOME) / "failed").is_file():
            failed = (Path(HOME) / "failed").read_text().strip()
        if HOME != "" and (Path(HOME) / "failed-reason").is_file():
            failed_reason = (Path(HOME) / "failed-reason").read_text().strip()
        return {
            "live": HOME != "",
            "running": self.running,
            "latest": self.latest,
            "ready": self.ready,
            "preparing": self.preparing,
            "checking": self.checking,
            "checked_at": self.checked_at,
            "error": self.error,
            "previous": previous,
            "switched_at": switched_at,
            "failed": failed,
            "failed_reason": failed_reason,
            "restarting": self.restarting,
        }

    def check(self) -> None:
        """Asks GitHub for the latest release, and makes it ready when it isn't the one that runs. Runs in a thread;
        a check already going makes this one return at once."""
        if HOME == "":
            return
        if not self.lock.acquire(blocking=False):
            return
        self.checking = True
        self.error = ""
        self.version += 1
        try:
            self.check_now()
        except Exception as error:
            self.error = str(error)
        finally:
            self.checking = False
            self.preparing = None
            self.version += 1
            self.lock.release()

    def check_now(self) -> None:
        account = self.github_account.load()
        if account is None:
            raise ValueError("Sign in with GitHub (the GitHub tab, Account) to check for updates.")
        if REPO == "":
            raise ValueError("SERAPH_REPO in .env is empty: the repo to look for releases in.")
        headers = {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {account['token']}", "X-GitHub-Api-Version": "2022-11-28"}
        response = httpx.get(f"{API}/repos/{REPO}/releases/latest", headers=headers, timeout=30)
        self.checked_at = datetime.now(UTC).isoformat()
        # No release yet.
        if response.status_code == 404:
            self.latest = None
            self.ready = None
            return
        response.raise_for_status()
        release = response.json()
        tag = release["tag_name"]
        self.latest = {
            "tag": tag,
            "name": release["name"] or tag,
            "notes": release["body"] or "",
            "published_at": release["published_at"],
            "url": release["html_url"],
        }

        # Only the release that runs, the one before it and the latest stay.
        releases = Path(HOME) / "releases"
        keep = [self.running, tag, self.previous()[0]]
        for folder in releases.iterdir():
            if folder.name in keep:
                continue
            if folder.is_dir() and not folder.is_symlink():
                shutil.rmtree(folder)
            else:
                folder.unlink()

        if tag == self.running:
            self.ready = None
            return
        # Taken back after it went live, or failed its check: never made ready again; a newer release is.
        if tag == self.summary()["failed"]:
            self.ready = None
            raise ValueError(f"{tag} was taken back: {self.summary()['failed_reason'] or 'it went wrong after it went live'}")
        if tag in self.rejected:
            self.ready = None
            raise ValueError(self.rejected[tag])
        if not (releases / tag / "VERSION").is_file():
            self.preparing = tag
            self.version += 1
            self.prepare(tag, headers)
        self.ready = tag

    def prepare(self, tag: str, headers: dict) -> None:
        """Downloads release <tag> into releases/<tag>/ and makes it ready to start. A step that fails raises with the
        end of its output."""
        releases = Path(HOME) / "releases"
        folder = releases / tag
        # A try that stopped half-way starts over.
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
        archive = releases / f"{tag}.tar.gz"
        with httpx.stream("GET", f"{API}/repos/{REPO}/tarball/{tag}", headers=headers, follow_redirects=True, timeout=120) as response:
            response.raise_for_status()
            with open(archive, "wb") as file:
                for chunk in response.iter_bytes():
                    file.write(chunk)

        # The same .env as every release (the live copy's own); the page's build reads it too.
        (folder / ".env").symlink_to(Path(HOME) / ".env")
        # The app's own .venv (uv sync makes it); never the one this backend runs in.
        env = dict(os.environ)
        env.pop("VIRTUAL_ENV", None)
        steps = [
            # GitHub's archive has everything in one folder (owner-name-<commit>): its contents go straight in.
            (["tar", "-xzf", str(archive), "--strip-components=1", "-C", str(folder)], folder),
            (["uv", "sync", "--frozen", "--no-dev"], folder),
            (["npm", "ci", "--no-audit", "--no-fund"], folder / "frontend"),
            (["npm", "run", "build"], folder / "frontend"),
        ]
        for command, cwd in steps:
            result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=STEP_SECONDS)
            if result.returncode != 0:
                output = (result.stdout + result.stderr).strip()
                raise RuntimeError(f"Getting {tag} ready failed at {' '.join(command[:2])}: {output[-1500:]}")
        archive.unlink()
        # Only the built page is needed from here on.
        shutil.rmtree(folder / "frontend" / "node_modules")
        try:
            self.check_release(tag)
        except Exception as error:
            reason = f"{tag} failed its check before going live: {error}"
            self.rejected[tag] = reason
            self.crashes.add("release", reason, "", tag)
            raise RuntimeError(reason)
        (folder / "VERSION").write_text(tag + "\n")

    def check_release(self, tag: str) -> None:
        """Starts release <tag> on a copy of data/ with SERAPH_CHECK=1, on its own port, and checks it answers, serves its
        page and sends every topic of its live feed, with no error. Raises with what went wrong. Its .env is the check's
        while it runs, and the live one's link again after."""
        folder = Path(HOME) / "releases" / tag
        data = Path(HOME) / "check-data"
        port = int(os.environ["BACKEND_PORT"]) + 2
        shutil.rmtree(data, ignore_errors=True)
        # Without the VMs: the check must never see, start or stop one.
        shutil.copytree(Path(HOME) / "data", data, symlinks=True, ignore=shutil.ignore_patterns("vms", "remote_access"))
        lines = []
        for line in (Path(HOME) / ".env").read_text().splitlines():
            if line.split("=")[0].strip() in ["DATA_DIR", "BACKEND_PORT", "SANDBOX_VM_PREFIX", "SERAPH_CHECK"]:
                continue
            lines.append(line)
        lines += [f"DATA_DIR={data}", f"BACKEND_PORT={port}", "SANDBOX_VM_PREFIX=check-", "SERAPH_CHECK=1"]
        env_path = folder / ".env"
        env_path.unlink(missing_ok=True)
        env_path.write_text("\n".join(lines) + "\n")
        env = dict(os.environ)
        env.pop("VIRTUAL_ENV", None)
        log = open(data / "check.log", "w")
        process = subprocess.Popen([str(folder / ".venv" / "bin" / "serve")], cwd=folder, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            health = None
            started = time.monotonic()
            while health is None and time.monotonic() - started < CHECK_START_SECONDS:
                if process.poll() is not None:
                    break
                try:
                    response = httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=5)
                    if response.status_code == 200:
                        health = response.json()
                except httpx.HTTPError:
                    time.sleep(1)
            if health is None:
                log.flush()
                output = (data / "check.log").read_text()[-1500:]
                raise RuntimeError(f"it didn't start: {output}")
            response = httpx.get(f"http://127.0.0.1:{port}/", timeout=30)
            if response.status_code != 200:
                raise RuntimeError(f"its page answered {response.status_code}")
            topics = []
            with connect(f"ws://127.0.0.1:{port}/api/live", open_timeout=30) as socket:
                started = time.monotonic()
                while len(topics) < len(TOPICS) and time.monotonic() - started < CHECK_FEED_SECONDS:
                    try:
                        message = json.loads(socket.recv(timeout=CHECK_FEED_SECONDS))
                    except TimeoutError:
                        break
                    topics.append(message["topic"])
            missing = [topic for topic in TOPICS if topic not in topics]
            if missing:
                log.flush()
                output = (data / "check.log").read_text()[-1500:]
                raise RuntimeError(f"its live feed didn't send {', '.join(missing)}: {output}")
            health = httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=10).json()
            if health.get("errors", 0) > 0:
                errors = json.loads((data / "crashes.json").read_text())
                raise RuntimeError("it reported errors: " + "; ".join(item["message"] for item in errors[: health["errors"]]))
        finally:
            process.terminate()
            try:
                process.wait(30)
            except subprocess.TimeoutExpired:
                process.kill()
            log.close()
            shutil.rmtree(data, ignore_errors=True)
            env_path.unlink(missing_ok=True)
            env_path.symlink_to(Path(HOME) / ".env")

    def switch(self, tag: str, restore: str = "") -> None:
        """Runs deploy/switch.sh outside the app, which stops on the way. restore: a copy of data/ to put in place first
        (Previous version). Raises when it couldn't start."""
        # A unit of its own each time: the last switch may still be watching its release (switch.sh stops watching
        # once current points elsewhere).
        unit = f"seraph-switch-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}"
        command = ["systemd-run", "--user", "--collect", "--unit", unit, str(PROJECT_ROOT / "deploy" / "switch.sh"), tag]
        if restore != "":
            command.append(restore)
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"Could not start the switch: {(result.stdout + result.stderr).strip()}")
