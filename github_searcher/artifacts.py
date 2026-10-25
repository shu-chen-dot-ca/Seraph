"""Each agent's artifacts: a folder of its own on this computer, DATA_DIR/artifacts/<agent id>/, shown in the
Artifacts tab of its page. The user puts files and folders in there for it (pictures to look at, files to use in
its VM); the agent keeps what it makes there (screenshots of its VM, files it copies out of the VM) and can look at
any picture or text in it. Its tools for that are in github_searcher/agent/work_tools.py.

Paths are relative to the agent's folder: "" is the folder itself, "screenshots/before.png" a file in it.
resolve() refuses any path that leads out of the folder (.., an absolute path, a link that points out), so neither
the agent nor a request can reach another file on this computer. Nothing here overwrites: a name that is
taken is refused.

What comes out of a VM is copied into a hidden folder first and cleaned there: links and anything that isn't a
plain file or folder are taken out, so a link made in the VM can't later point a copy back into the VM at a file
of this computer. A copy out of a VM is FROM_VM_LIMIT at most.

Every change goes up in stamps (by agent), and on_change is called, so the live feed sends the agent list and an
open Artifacts tab reads its folder again. An agent's folder goes when the agent is deleted, not when it is archived.

    artifacts = Artifacts()
    artifacts.list("agent_a1b2c3", "screenshots")
"""

import os
import secrets
import shlex
import shutil
import threading
from pathlib import Path

from dotenv import load_dotenv

from sandbox.file_transfer import to_computer

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
ROOT = DATA_DIR / "artifacts"
# The most one copy out of a VM may hold, so a VM can't fill this computer's disk.
FROM_VM_LIMIT = 200_000_000


class ArtifactsError(Exception):
    pass


class Artifacts:
    def __init__(self):
        self.lock = threading.Lock()
        # Changes per agent id, for the live feed.
        self.stamps: dict[str, int] = {}
        self.on_change = None

    def changed(self, agent_id: str) -> None:
        with self.lock:
            self.stamps[agent_id] = self.stamps.get(agent_id, 0) + 1
        if self.on_change is not None:
            self.on_change()

    def resolve(self, agent_id: str, path: str) -> Path:
        """The real path of `path` in the agent's folder (made if missing). Refuses one that leads out of it."""
        base = (ROOT / agent_id).resolve()
        base.mkdir(parents=True, exist_ok=True)
        target = (base / path.strip().lstrip("/")).resolve()
        if target != base and not target.is_relative_to(base):
            raise ArtifactsError(f"{path} is not in the artifacts")
        return target

    def name_of(self, agent_id: str, target: Path) -> str:
        """The path of a file in the agent's folder, as the agent and the page write it ("" for the folder)."""
        base = (ROOT / agent_id).resolve()
        if target == base:
            return ""
        return str(target.relative_to(base))

    def list(self, agent_id: str, path: str) -> dict:
        """A folder: {"path", "parent" (None at the top), "entries": [{"name", "kind", "size", "modified"}, ...]},
        folders first, then by name. Hidden names (the copies coming in) are left out."""
        folder = self.resolve(agent_id, path)
        if not folder.is_dir():
            raise ArtifactsError(f"{path} is not a folder in the artifacts")
        entries = []
        for item in os.scandir(folder):
            if item.name.startswith(".incoming-"):
                continue
            stat = item.stat(follow_symlinks=False)
            kind = "folder" if item.is_dir(follow_symlinks=False) else "file"
            size = stat.st_size
            if kind == "folder":
                size = 0
            entries.append({"name": item.name, "kind": kind, "size": size, "modified": stat.st_mtime})
        entries.sort(key=lambda entry: (entry["kind"] != "folder", entry["name"].lower()))
        name = self.name_of(agent_id, folder)
        parent = None
        if name != "":
            parent = str(Path(name).parent)
            if parent == ".":
                parent = ""
        return {"path": name, "parent": parent, "entries": entries}

    def new_file(self, agent_id: str, path: str) -> Path:
        """Where a new file goes: its folder is made, and a name that is taken is refused."""
        target = self.resolve(agent_id, path)
        if target.name == "":
            raise ArtifactsError("Give the file a name")
        if target.exists() or target.is_symlink():
            raise ArtifactsError(f"{self.name_of(agent_id, target)} is already in the artifacts")
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def save(self, agent_id: str, path: str, data: bytes) -> str:
        """A new file with these bytes. Returns its path."""
        target = self.new_file(agent_id, path)
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_bytes(data)
        temporary.replace(target)
        self.changed(agent_id)
        return self.name_of(agent_id, target)

    def make_folder(self, agent_id: str, path: str) -> None:
        target = self.resolve(agent_id, path)
        if target.exists():
            raise ArtifactsError(f"{self.name_of(agent_id, target)} is already in the artifacts")
        target.mkdir(parents=True)
        self.changed(agent_id)

    def rename(self, agent_id: str, path: str, new_name: str) -> None:
        """A new name in the same folder."""
        new_name = new_name.strip()
        if new_name == "" or "/" in new_name or new_name in [".", ".."]:
            raise ArtifactsError("A name can't be empty or have a / in it")
        target = self.resolve(agent_id, path)
        if self.name_of(agent_id, target) == "":
            raise ArtifactsError("The artifacts folder itself can't be renamed")
        if not target.exists():
            raise ArtifactsError(f"{path} is not in the artifacts anymore")
        renamed = target.with_name(new_name)
        if renamed.exists():
            raise ArtifactsError(f"{new_name} is already in that folder")
        target.rename(renamed)
        self.changed(agent_id)

    def delete(self, agent_id: str, path: str) -> None:
        """A file, or a folder with everything in it."""
        target = self.resolve(agent_id, path)
        if self.name_of(agent_id, target) == "":
            raise ArtifactsError("The artifacts folder itself can't be deleted")
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        else:
            raise ArtifactsError(f"{path} is not in the artifacts anymore")
        self.changed(agent_id)

    def delete_all(self, agent_id: str) -> None:
        """The agent was deleted: its folder goes too."""
        shutil.rmtree(ROOT / agent_id, ignore_errors=True)
        self.changed(agent_id)

    def has_links(self, agent_id: str, path: str) -> bool:
        """Whether a file or folder is, or holds, a link (a copy into a VM would follow it)."""
        target = self.resolve(agent_id, path)
        if target.is_symlink():
            return True
        for folder, folders, files in os.walk(target):
            for name in folders + files:
                if os.path.islink(os.path.join(folder, name)):
                    return True
        return False

    def from_vm(self, agent_id: str, vm, source: str, folder: str) -> str:
        """Copy a file or folder from the VM (an absolute path) into a folder of the artifacts. Returns its path."""
        target_folder = self.resolve(agent_id, folder)
        target_folder.mkdir(parents=True, exist_ok=True)
        name = Path(source).name
        if (target_folder / name).exists():
            raise ArtifactsError(f"{self.name_of(agent_id, target_folder / name)} is already in the artifacts")
        size = vm.exec(f"du -sb {shlex.quote(source)} | cut -f1", 120)
        if size.returncode != 0 or not size.stdout.strip().isdigit():
            raise ArtifactsError(f"{source} is not in the VM")
        if int(size.stdout.strip()) > FROM_VM_LIMIT:
            raise ArtifactsError(f"{source} is over {FROM_VM_LIMIT // 1_000_000} MB; copy only what you need")

        # Into a hidden folder first, cleaned of links and special files, then into its place.
        incoming = (ROOT / agent_id).resolve() / f".incoming-{secrets.token_hex(3)}"
        incoming.mkdir()
        try:
            to_computer(vm, source, str(incoming))
            for current, folders, files in os.walk(incoming):
                for item in folders + files:
                    item_path = Path(current) / item
                    if item_path.is_symlink() or not (item_path.is_dir() or item_path.is_file()):
                        item_path.unlink()
            if not (incoming / name).exists():
                raise ArtifactsError(f"{source} is a link or a special file; copy what it points to instead")
            (incoming / name).rename(target_folder / name)
        finally:
            shutil.rmtree(incoming, ignore_errors=True)
        self.changed(agent_id)
        return self.name_of(agent_id, target_folder / name)
