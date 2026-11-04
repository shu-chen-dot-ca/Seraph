"""Your groups of repositories, and the ones pinned to the left list (the Repositories page,
frontend/src/pages/ProjectsPage.tsx).

The Repositories page shows every repository you work on in your groups, in their order, and the ones in no group
under them, as Ungrouped. A pinned one also shows in the left list, under Repositories. Kept in
DATA_DIR/repo_groups.json:

    {"groups": [{"name": "Work", "repos": ["owner/name", ...]}, ...], "pinned": ["owner/name", ...]}

Repos are in lower case, each in one group at most. One that is no longer a project keeps its group and its pin, and
shows there again if it comes back.
"""

import copy
import json
import os
import re
import threading
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
NAME_CHARS = 60
REPO = re.compile(r"^[\w.-]+/[\w.-]+$")


class RepoGroups:
    def __init__(self):
        self.path = DATA_DIR / "repo_groups.json"
        self.lock = threading.Lock()
        self.version = 0
        self.data = {"groups": [], "pinned": []}
        if self.path.exists():
            self.data = json.loads(self.path.read_text())

    def get(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.data)

    def set(self, groups: list[dict], pinned: list[str]) -> dict:
        """All the groups and pins at once, as the page has them now. Raises ValueError on a group name that is empty,
        too long or used twice, or on a repo that isn't "owner/name". A repo in two groups stays in the first."""
        names = []
        seen = []
        clean_groups = []
        for group in groups:
            name = group["name"].strip()
            if name == "":
                raise ValueError("A group needs a name.")
            if len(name) > NAME_CHARS:
                raise ValueError(f"A group's name is {NAME_CHARS} characters at most.")
            if name.lower() in names:
                raise ValueError(f"There is a group {name!r} already.")
            names.append(name.lower())
            repos = []
            for repo in group["repos"]:
                if not REPO.match(repo):
                    raise ValueError(f"{repo!r} isn't a repository (owner/name).")
                if repo.lower() in seen:
                    continue
                seen.append(repo.lower())
                repos.append(repo.lower())
            clean_groups.append({"name": name, "repos": repos})
        clean_pinned = []
        for repo in pinned:
            if not REPO.match(repo):
                raise ValueError(f"{repo!r} isn't a repository (owner/name).")
            if repo.lower() not in clean_pinned:
                clean_pinned.append(repo.lower())

        with self.lock:
            self.data = {"groups": clean_groups, "pinned": clean_pinned}
            self.version += 1
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # Write, then rename: a crash never leaves half a file.
            temporary = self.path.with_name(self.path.name + ".tmp")
            temporary.write_text(json.dumps(self.data, indent=2))
            temporary.replace(self.path)
            return copy.deepcopy(self.data)
