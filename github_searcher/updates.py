"""Updates of the live copy of the app: the latest release of this repo on GitHub, made ready in the background, and the
switch to it when you press Restart (Update in the header, UpdateDialog.tsx; Settings → About, About.tsx).

The live copy (deploy/install.sh makes it) lives in SERAPH_HOME (~/seraph), which the service seraph sets:

    current -> releases/<tag>     the release that runs
    releases/<tag>/               a release: its code, .venv, its built page (frontend/dist), .env (a link) and VERSION
    backups/<time>-<tag>/         data/ as it was before each switch (the last 10)
    previous                      "<tag> <backup>": the release before this one, and data/ from just before the switch
    failed                        the release the last switch went to, when it didn't start (switch.sh went back)
    data/, .env                   yours, the same for every release

Without SERAPH_HOME (the dev copy, ./run.sh) there are no updates, and the version is "dev".

check() asks GitHub for the latest release of SERAPH_REPO with your GitHub sign in (it can read your private repos).
When that isn't the release that runs, it makes it ready: downloads its code, installs its Python packages (uv sync)
and builds its page (npm ci, npm run build), in releases/<tag>/. VERSION is written last, so a release folder with one
is ready. Nothing restarts by itself.

switch() runs deploy/switch.sh outside the app (systemd-run), since the app stops on the way. It stops the app, copies
data/ to backups/, points current at the release and starts it. When the release doesn't answer on /api/health within
a minute, data/ and current go back and the release before starts again.
"""

import os
import shutil
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path

import httpx

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


class Updates:
    def __init__(self, github_account):
        self.github_account = github_account
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
        if HOME != "" and (Path(HOME) / "failed").is_file():
            failed = (Path(HOME) / "failed").read_text().strip()
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
        (folder / "VERSION").write_text(tag + "\n")

    def switch(self, tag: str, restore: str = "") -> None:
        """Runs deploy/switch.sh outside the app, which stops on the way. restore: a copy of data/ to put in place first
        (Previous version). Raises when it couldn't start."""
        command = ["systemd-run", "--user", "--collect", "--unit", "seraph-switch", str(PROJECT_ROOT / "deploy" / "switch.sh"), tag]
        if restore != "":
            command.append(restore)
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(f"Could not start the switch: {(result.stdout + result.stderr).strip()}")
