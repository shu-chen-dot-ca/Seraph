"""Copying files and folders between this computer and a VM: the VM page's Resources tab. Only the user does it.

Agents can't do this with any folder of this computer. The one place they may copy to and from is their own
artifacts folder (github_searcher/artifacts.py: it checks the paths, and cleans links out of what comes from
the VM); the VM itself can't reach this computer. Otherwise only the backend's endpoints call this
(backend/vms_api.py), and the backend only listens on 127.0.0.1, for the browser.

Listing a folder, on this computer (as the backend's user) or in the VM (as the user of the VM object's desktop:
desktop 1's for the Resources tab, the agent's own for its artifacts). An empty path is that user's home. Both give back:

    {"path": the folder's absolute path, "parent": its parent folder (None at /),
     "entries": [{"name", "kind": "folder" | "file", "size" (bytes), "modified" (Unix time)}, ...]}

folders first, then by name. A link counts as what it points to, so a linked folder can be opened.

Copying never moves and never overwrites: a name that is already in the target folder is refused.
It waits until the copy is done, so a big folder can take minutes. `incus file push` writes as root in the VM,
so a copy into the VM is given to the desktop's user afterwards. The VM must be running for either.
"""

import os
import shlex
import subprocess
from pathlib import Path

from sandbox.vm import VM


class FileTransferError(Exception):
    pass


def list_computer(path: str) -> dict:
    folder = Path(path).expanduser() if path else Path.home()
    folder = folder.resolve()
    if not folder.is_dir():
        raise FileTransferError(f"{folder} is not a folder on this computer")
    entries = []
    try:
        for item in os.scandir(folder):
            # A broken link, or one we may not look at: still listed, as a file of size 0.
            try:
                kind = "folder" if item.is_dir() else "file"
                stat = item.stat()
                size = stat.st_size
                modified = stat.st_mtime
            except OSError:
                kind = "file"
                size = 0
                modified = 0
            entries.append({"name": item.name, "kind": kind, "size": size, "modified": modified})
    except PermissionError:
        raise FileTransferError(f"You may not open {folder} on this computer")
    entries.sort(key=lambda entry: (entry["kind"] != "folder", entry["name"].lower()))
    parent = None if folder == folder.parent else str(folder.parent)
    return {"path": str(folder), "parent": parent, "entries": entries}


def list_vm(vm: VM, path: str) -> dict:
    # cd with no folder goes home. %Y is the type a link points to; \0 ends each entry, since a name may hold anything.
    go = f"cd {shlex.quote(path)}" if path else "cd"
    command = f"{go} || exit 3; pwd; find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%s\\t%T@\\t%f\\0' 2>/dev/null; true"
    result = vm.exec(command, 60)
    if result.returncode != 0:
        raise FileTransferError(result.stderr.strip() or f"Could not open {path} in the VM")
    folder, _, listing = result.stdout.partition("\n")
    entries = []
    for line in listing.split("\0"):
        if line == "":
            continue
        kind, size, modified, name = line.split("\t", 3)
        entries.append({"name": name, "kind": "folder" if kind == "d" else "file", "size": int(size), "modified": float(modified)})
    entries.sort(key=lambda entry: (entry["kind"] != "folder", entry["name"].lower()))
    parent = None if folder == "/" else str(Path(folder).parent)
    return {"path": folder, "parent": parent, "entries": entries}


def to_vm(vm: VM, source: str, target_dir: str) -> None:
    """Copy a file or folder from this computer into target_dir in the VM."""
    source_path = Path(source)
    if not source_path.is_absolute() or not target_dir.startswith("/"):
        raise FileTransferError("Paths must be absolute")
    if source_path.name == "":
        raise FileTransferError("The whole disk can't be copied")
    if not source_path.exists():
        raise FileTransferError(f"{source} is not on this computer anymore")
    target = str(Path(target_dir) / source_path.name)
    check = vm.exec(f"test -d {shlex.quote(target_dir)} && ! test -e {shlex.quote(target)}", 30)
    if check.returncode != 0:
        raise FileTransferError(f"{source_path.name} is already in {target_dir} in the VM (or that folder is gone)")

    # A target ending in / is a folder: the copy goes in it under its own name.
    command = ["incus", "file", "push", str(source_path), f"{vm.name}{target_dir.rstrip('/')}/"]
    if source_path.is_dir():
        command.insert(3, "-r")
    result = subprocess.run(command, capture_output=True, stdin=subprocess.DEVNULL, text=True)
    if result.returncode != 0:
        raise FileTransferError(f"Could not copy {source_path.name} into the VM: {result.stderr.strip()}")
    user = vm.exec("id -un", 30).stdout.strip()
    owner = vm.exec_root(f"chown -R {shlex.quote(user)}: {shlex.quote(target)}", 600)
    if owner.returncode != 0:
        raise FileTransferError(f"Copied, but could not give {target} to the VM's user: {owner.stderr.strip()}")


def to_computer(vm: VM, source: str, target_dir: str) -> None:
    """Copy a file or folder from the VM into target_dir on this computer."""
    target_path = Path(target_dir)
    if not source.startswith("/") or not target_path.is_absolute():
        raise FileTransferError("Paths must be absolute")
    name = Path(source).name
    if name == "":
        raise FileTransferError("The whole disk can't be copied")
    if not target_path.is_dir():
        raise FileTransferError(f"{target_dir} is not a folder on this computer anymore")
    if (target_path / name).exists() or (target_path / name).is_symlink():
        raise FileTransferError(f"{name} is already in {target_dir} on this computer")
    check = vm.exec(f"test -e {shlex.quote(source)} || exit 3; test -d {shlex.quote(source)}", 30)
    if check.returncode == 3:
        raise FileTransferError(f"{source} is not in the VM anymore")

    command = ["incus", "file", "pull", f"{vm.name}{source}", str(target_path) + "/"]
    # test -d said it is a folder.
    if check.returncode == 0:
        command.insert(3, "-r")
    result = subprocess.run(command, capture_output=True, stdin=subprocess.DEVNULL, text=True)
    if result.returncode != 0:
        raise FileTransferError(f"Could not copy {name} to this computer: {result.stderr.strip()}")
