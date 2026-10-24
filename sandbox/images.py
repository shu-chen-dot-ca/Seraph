"""The images VMs start from: list them, pick the default, rename, delete, and make new ones.

An image is an Incus image with a name (an Incus alias). Incus also keeps unnamed images, like the
downloads builds start from; those aren't ours and aren't listed.

New images come two ways. Both run in the background, as a task shown above the list:
- New image: the image's agent (image_agent.py) makes it. It starts a builder VM from an official system image
  (SYSTEMS, from Incus's image server: downloaded, not built), installs the desktop (or none: terminal only)
  and everything in the image's description, checks what the app needs, and publishes it. Rebuild does it again from the description;
  the new build replaces the image, and VMs made from the old one keep their own disk.
- save a VM: `incus publish` of a stopped VM (a few minutes): everything on its disk comes along.
(sandbox/image/build.sh, the hour-long Ubuntu build from provision.sh, is still there for the command line.)
An image can only be deleted once no VM was made from it (stopped ones count too).

Each image has a description: what it should have (system, desktop, its dependencies, comments), in markdown. New image writes it from the dialog; the image's agent changes it when the user asks in its chat;
nothing changes in the image until it is rebuilt. DATA_DIR/images/specs/<image name>/ holds:

    spec.md     the description: what the next build makes
    built.md    the description the image was last built from
    chat.json   the agent's conversation

spec_changed (in the live feed) says spec.md differs from built.md: the image is behind its description.
Images made before descriptions get a short one the first time it's needed, which counts as built.

What an image has (system, languages, tools, packages, models) is listed once, by sandbox/image/inspect.sh:
a throwaway VM from the image runs inventory.py, and the list goes to DATA_DIR/images/inventory/<fingerprint>.json.
Images never change, so that list stays true. New image and save inspect the new image at the end; an older
image is inspected with an inspect task (about two minutes). Lists of images that are gone (deleted, or
replaced by a rebuild) are kept, since VMs made from them still have what they listed.

A task (save, inspect) is a process of its own (its own session) that writes DATA_DIR/images/<task id>.log and
prints "==> Done" last when it worked. Its record in DATA_DIR/images/tasks.json keeps the pid, so a
backend restart (it reloads on code changes) doesn't stop it: the task is followed again from there.
An agent's build ("agent" task) has no process: the agent writes its log and ends it, and a backend restart
ends it as failed (the conversation went with the backend). Tasks that worked are dropped once the image
shows up; failed ones stay until the user dismisses them (which deletes a failed build's builder VM).

The default image (what New VM picks first) and the list that goes in every new image are saved in
DATA_DIR/images/settings.json. Until one is picked the default is SANDBOX_IMAGE from .env.

Images.version goes up on every change, so the live feed (backend /api/live) sends the list again.
"""

import difflib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.vm import VM
from sandbox.vms import VMs, VMsError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

IMAGES_DIR = PROJECT_ROOT / os.environ["DATA_DIR"] / "images"
DEFAULT_IMAGE = os.environ["SANDBOX_IMAGE"]
INSPECT_SCRIPT = PROJECT_ROOT / "sandbox" / "image" / "inspect.sh"
INVENTORY_DIR = IMAGES_DIR / "inventory"
SPECS_DIR = IMAGES_DIR / "specs"
# What New image offers. A system's sources are the official images (Incus's images: server) a build may start
# from: Ubuntu has a desktop variant (GNOME) and a plain one, where the agent puts another desktop.
SYSTEMS = [
    {"id": "ubuntu-24.04", "label": "Ubuntu 24.04 LTS", "sources": ["ubuntu/noble", "ubuntu/noble/desktop"]},
    {"id": "ubuntu-26.04", "label": "Ubuntu 26.04 LTS", "sources": ["ubuntu/26.04", "ubuntu/26.04/desktop"]},
    {"id": "ubuntu-22.04", "label": "Ubuntu 22.04 LTS", "sources": ["ubuntu/jammy", "ubuntu/jammy/desktop"]},
    {"id": "fedora-44", "label": "Fedora 44", "sources": ["fedora/44"]},
    {"id": "fedora-43", "label": "Fedora 43", "sources": ["fedora/43"]},
    {"id": "debian-13", "label": "Debian 13", "sources": ["debian/13"]},
    {"id": "debian-12", "label": "Debian 12", "sources": ["debian/12"]},
]
# GNOME first: the default. None is a terminal-only image (no desktop, no browser).
DESKTOPS = ["GNOME", "KDE Plasma", "None (terminal only)"]
# What goes in every new image until the user changes the list in New image (its Dependencies).
DEFAULT_PACKAGES = [
    "Git and Git LFS",
    "Build tools (gcc, make, pkg-config)",
    "Python 3 and uv",
    "Node.js LTS with npm, pnpm and Yarn",
    "Docker with Compose",
    "Playwright with Chromium",
    "VS Code",
    "GitHub CLI",
    "tmux, ripgrep, jq, htop, unzip",
    "SQLite and the PostgreSQL client",
]
NAME_PATTERN = r"[a-z][a-z0-9-]{0,40}"
# Tasks are checked this often; Incus's image list is read again every REFRESH_SECONDS.
CHECK_SECONDS = 2
REFRESH_SECONDS = 10
# How much of a task's log the live feed carries.
LOG_TAIL_LINES = 3


class ImagesError(Exception):
    pass


def load_inventory(fingerprint: str) -> dict | None:
    """What an image has (inventory.py's list), or None if it wasn't inspected. Also used by the agents' tools."""
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        return None
    path = INVENTORY_DIR / f"{fingerprint}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


class Images:
    def __init__(self, vms: VMs):
        self.vms = vms
        self.lock = threading.Lock()  # Guards everything below.
        self.version = 0
        # The last list read from Incus: {"name", "aliases", "fingerprint", "size_gb", "created_at"}.
        self.images: list[dict] = []
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        self.default = DEFAULT_IMAGE
        # What goes in every new image (New image starts with this list).
        self.packages = list(DEFAULT_PACKAGES)
        settings_path = IMAGES_DIR / "settings.json"
        if settings_path.exists():
            settings = json.loads(settings_path.read_text())
            self.default = settings.get("default") or DEFAULT_IMAGE
            self.packages = settings.get("packages") or list(DEFAULT_PACKAGES)
        # The short version of each inspected image's list (see highlights()), by fingerprint; lists never change.
        self.highlights_by_fingerprint: dict[str, dict] = {}
        # {"id", "kind": "agent" | "save" | "inspect", "name", "vm" (saved VM), "builder" (agent's VM), "pid",
        #  "status": "running" | "failed", "error", "started_at"}
        self.tasks: list[dict] = []
        tasks_path = IMAGES_DIR / "tasks.json"
        if tasks_path.exists():
            self.tasks = json.loads(tasks_path.read_text())
        # An agent's build can't go on after a restart: its conversation ended with the backend.
        for task in self.tasks:
            if task["kind"] == "agent" and task["status"] == "running":
                task["status"] = "failed"
                task["error"] = "The backend restarted during the build. Dismiss this and make the image again."
                threading.Thread(target=VM(task["builder"]).delete, daemon=True).start()
        self.refresh()
        threading.Thread(target=self.watch, daemon=True).start()

    # --- Saving -------------------------------------------------------------------

    def save_settings(self) -> None:
        temporary = IMAGES_DIR / "settings.json.tmp"
        temporary.write_text(json.dumps({"default": self.default, "packages": self.packages}, indent=2))
        temporary.replace(IMAGES_DIR / "settings.json")

    def save_tasks(self) -> None:
        temporary = IMAGES_DIR / "tasks.json.tmp"
        temporary.write_text(json.dumps(self.tasks, indent=2))
        temporary.replace(IMAGES_DIR / "tasks.json")

    # --- Reading ------------------------------------------------------------------

    def refresh(self) -> None:
        """Read the named images from Incus."""
        result = subprocess.run(["incus", "image", "list", "--format", "json"], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            return
        images = []
        for image in json.loads(result.stdout):
            if not image["aliases"]:
                continue
            aliases = sorted(alias["name"] for alias in image["aliases"])
            images.append(
                {
                    "name": aliases[0],
                    "aliases": aliases,
                    "fingerprint": image["fingerprint"],
                    "size_gb": image["size"] / 1024**3,
                    "created_at": image["created_at"],
                }
            )
        images.sort(key=lambda image: image["name"])
        with self.lock:
            if images != self.images:
                self.images = images
                self.version += 1

    def watch(self) -> None:
        """Follow the running tasks, and read Incus's list now and then, for as long as the backend runs."""
        last_refresh = time.monotonic()
        while True:
            time.sleep(CHECK_SECONDS)
            try:
                self.check_tasks()
                if time.monotonic() - last_refresh > REFRESH_SECONDS:
                    self.refresh()
                    last_refresh = time.monotonic()
            except Exception:
                pass  # Incus hiccup; try again next round.

    def check_tasks(self) -> None:
        """A task whose process ended worked if its log ends with "==> Done"; then it is dropped."""
        finished = []
        with self.lock:
            # An agent's build has no process: the agent ends it.
            tasks = [dict(task) for task in self.tasks if task["status"] == "running" and task["pid"] is not None]
        for task in tasks:
            if Path(f"/proc/{task['pid']}").exists() and not self.is_zombie(task["pid"]):
                continue
            log = self.read_log(task["id"])
            lines = log.strip().splitlines()
            worked = bool(lines) and lines[-1].strip() == "==> Done"
            error = None
            if not worked:
                error = lines[-1].strip() if lines else "It stopped without a word."
            if not worked and task.get("stopped"):
                error = "Stopped by you."
            finished.append((task["id"], worked, error))
        if not finished:
            return
        self.refresh()
        with self.lock:
            self.highlights_by_fingerprint = {}
            for task_id, worked, error in finished:
                for task in self.tasks:
                    if task["id"] != task_id:
                        continue
                    task["status"] = "done" if worked else "failed"
                    task["error"] = error
            self.tasks = [task for task in self.tasks if task["status"] != "done"]
            self.save_tasks()
            self.version += 1
        for task_id, worked, error in finished:
            if worked:
                (IMAGES_DIR / f"{task_id}.log").unlink(missing_ok=True)

    def is_zombie(self, pid: int) -> bool:
        """An ended child of this process stays in /proc until it is waited for; it counts as ended."""
        try:
            return Path(f"/proc/{pid}/stat").read_text().split(") ")[1].startswith("Z")
        except (OSError, IndexError):
            return True

    def read_log(self, task_id: str) -> str:
        # The id comes from the URL too: nothing but a task's own log may be read.
        if not re.fullmatch(r"task_[0-9a-f]{6}", task_id):
            return ""
        path = IMAGES_DIR / f"{task_id}.log"
        if not path.exists():
            return ""
        return path.read_text(errors="replace")

    def get_default(self) -> str:
        with self.lock:
            return self.default

    def names(self) -> list[str]:
        with self.lock:
            return [image["name"] for image in self.images]

    def find(self, name: str) -> dict:
        with self.lock:
            for image in self.images:
                if name in image["aliases"]:
                    return dict(image)
        raise ImagesError(f"There is no image {name}")

    def summary(self) -> dict:
        """For the live feed: the images (with the VMs made from each), the default, and the tasks with their last log lines."""
        used_by: dict[str, list[str]] = {}
        for record in self.vms.list():
            used_by.setdefault(record.image_fingerprint, []).append(record.name)
        with self.lock:
            images = []
            for image in self.images:
                images.append({**image, "default": image["name"] == self.default, "used_by": used_by.get(image["fingerprint"], [])})
            tasks = [dict(task) for task in self.tasks]
            default = self.default
        for task in tasks:
            task["log_tail"] = self.read_log(task["id"]).strip().splitlines()[-LOG_TAIL_LINES:]
        inspecting = [task["name"] for task in tasks if task["status"] == "running"]
        for image in images:
            image["inventory"] = self.highlights(image["fingerprint"])
            image["inspecting"] = image["name"] in inspecting
            image["spec_changed"] = self.spec_changed(image["name"])
        return {"images": images, "default": default, "tasks": tasks}

    def highlights(self, fingerprint: str) -> dict | None:
        """The short version of an image's list, for the live feed: everything but the packages, which are counted."""
        with self.lock:
            if fingerprint in self.highlights_by_fingerprint:
                return self.highlights_by_fingerprint[fingerprint]
        inventory = load_inventory(fingerprint)
        if inventory is None:
            return None
        counts: dict[str, int] = {}
        for package in inventory["packages"]:
            counts[package["kind"]] = counts.get(package["kind"], 0) + 1
        highlights = {
            "image": inventory["image"],
            "inspected_at": inventory["inspected_at"],
            "system": inventory["system"],
            "languages": inventory["languages"],
            "tools": inventory["tools"],
            "docker_images": [package["name"] for package in inventory["packages"] if package["kind"] == "docker"],
            "models": inventory["models"],
            "caches": inventory["caches"],
            "counts": counts,
        }
        with self.lock:
            self.highlights_by_fingerprint[fingerprint] = highlights
        return highlights

    # --- Changing -----------------------------------------------------------------

    def set_default(self, name: str) -> None:
        image = self.find(name)
        with self.lock:
            self.default = image["name"]
            self.save_settings()
            self.version += 1

    def rename(self, name: str, new_name: str) -> None:
        if not re.fullmatch(NAME_PATTERN, new_name):
            raise ImagesError("The name must start with a letter and have only a-z, 0-9 and -, at most 41 characters")
        self.find(name)
        if new_name in self.names():
            raise ImagesError(f"There is already an image named {new_name}")
        with self.lock:
            busy = [task for task in self.tasks if task["status"] == "running" and task["name"] == name]
        if busy:
            raise ImagesError(f"{name} is busy ({busy[0]['kind']} is running); wait until that is done.")
        result = subprocess.run(["incus", "image", "alias", "rename", name, new_name], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise ImagesError(f"Could not rename {name}: {result.stderr.strip()}")
        if (SPECS_DIR / name).exists():
            # A description left by an image deleted outside the app would be in the way.
            shutil.rmtree(SPECS_DIR / new_name, ignore_errors=True)
            (SPECS_DIR / name).rename(SPECS_DIR / new_name)
        with self.lock:
            if self.default == name:
                self.default = new_name
                self.save_settings()
        self.refresh()

    def delete(self, name: str) -> None:
        """Delete an image no VM was made from (running or not)."""
        image = self.find(name)
        if image["name"] == self.get_default():
            raise ImagesError(f"{name} is the default image. Make another one the default first.")
        made = [record.name for record in self.vms.list() if record.image_fingerprint == image["fingerprint"]]
        if made:
            raise ImagesError(f"VMs were made from {name} ({', '.join(made)}). Delete them first.")
        with self.lock:
            busy = [task for task in self.tasks if task["status"] == "running" and task["name"] == image["name"]]
        if busy:
            raise ImagesError(f"{name} is busy ({busy[0]['kind']} is running); wait until that is done.")
        result = subprocess.run(["incus", "image", "delete", image["fingerprint"]], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise ImagesError(f"Could not delete {name}: {result.stderr.strip()}")
        shutil.rmtree(SPECS_DIR / image["name"], ignore_errors=True)
        self.refresh()

    # --- Descriptions -------------------------------------------------------------

    def new_options(self) -> dict:
        """What New image offers, the list that goes in every new image, and what it picks first."""
        with self.lock:
            packages = list(self.packages)
        systems = [{"id": system["id"], "label": system["label"]} for system in SYSTEMS]
        return {"systems": systems, "desktops": DESKTOPS, "packages": packages, "system": SYSTEMS[0]["id"]}

    def set_packages(self, packages: list[str]) -> None:
        """The list that goes in every new image from now on."""
        with self.lock:
            self.packages = [item.strip() for item in packages if item.strip()]
            self.save_settings()

    def new_spec(self, name: str, system: str, desktop: str, packages: list[str], comments: str) -> None:
        """Write the description of an image to make (New image). The agent builds it next."""
        if not re.fullmatch(NAME_PATTERN, name):
            raise ImagesError("The name must start with a letter and have only a-z, 0-9 and -, at most 41 characters")
        if name in self.names():
            raise ImagesError(f"There is already an image named {name}")
        labels = [each["label"] for each in SYSTEMS if each["id"] == system]
        if not labels:
            raise ImagesError(f"Unknown system {system}")
        if desktop not in DESKTOPS:
            raise ImagesError(f"Unknown desktop {desktop}")
        lines = [f"# {name}", "", f"System: {labels[0]}", f"Desktop: {desktop}"]
        # Firefox on every desktop; a terminal-only image has no browser.
        if desktop != DESKTOPS[-1]:
            lines.append("Browser: Firefox")
        lines += ["", "## Dependencies", ""]
        for item in packages:
            if item.strip():
                lines.append(f"- {item.strip()}")
        if comments.strip():
            lines += ["", "## Comments", "", comments.strip()]
        # A description left by an image of this name that is gone would be in the way. Not built yet: no built.md.
        shutil.rmtree(SPECS_DIR / name, ignore_errors=True)
        (SPECS_DIR / name).mkdir(parents=True)
        (SPECS_DIR / name / "spec.md").write_text("\n".join(lines) + "\n")

    def spec_dir(self, name: str) -> Path:
        """The image's description folder. An image from before descriptions gets a short one, which counts as built."""
        # The name comes from the URL too: nothing outside SPECS_DIR.
        if not re.fullmatch(NAME_PATTERN, name):
            raise ImagesError(f"{name} can't have a description: the name must have only a-z, 0-9 and -")
        folder = SPECS_DIR / name
        if (folder / "spec.md").exists():
            return folder
        text = (
            f"# {name}\n\n"
            "Made before images had a description, so this only says roughly what it is. What it has is in its\n"
            "Overview and Packages (find_installed). If it was built by sandbox/image/provision.sh, that script\n"
            "(reference) says how: Ubuntu 24.04's desktop image (GNOME on X11) with everything the script installs.\n"
        )
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "built.md").write_text(text)
        (folder / "spec.md").write_text(text)
        return folder

    def spec_changed(self, name: str) -> bool:
        """Whether the description differs from what the image was built from. False while it has none."""
        folder = SPECS_DIR / name
        if not (folder / "spec.md").exists():
            return False
        built = (folder / "built.md").read_text() if (folder / "built.md").exists() else ""
        return (folder / "spec.md").read_text() != built

    def read_spec(self, name: str) -> str:
        return (self.spec_dir(name) / "spec.md").read_text()

    def write_spec(self, name: str, text: str) -> None:
        """Change the description. The image itself only changes when it is rebuilt."""
        folder = self.spec_dir(name)
        # Write, then rename: a crash never leaves half a file.
        (folder / "spec.md.tmp").write_text(text)
        (folder / "spec.md.tmp").replace(folder / "spec.md")
        with self.lock:
            self.version += 1

    def spec_diff(self, name: str) -> str:
        """A unified diff from the description the image was built from to the one now, or "" when they are the same."""
        folder = self.spec_dir(name)
        built = (folder / "built.md").read_text() if (folder / "built.md").exists() else ""
        now = (folder / "spec.md").read_text()
        lines = difflib.unified_diff(built.splitlines(keepends=True), now.splitlines(keepends=True), "built", "now")
        return "".join(lines)

    def discard_spec(self, name: str) -> None:
        """Put the description back to what the image was built from."""
        name = self.find(name)["name"]
        folder = self.spec_dir(name)
        if (folder / "built.md").exists():
            shutil.copy(folder / "built.md", folder / "spec.md")
        with self.lock:
            self.version += 1

    # --- Builds by the agent ---------------------------------------------------------

    def start_agent_build(self, name: str) -> dict:
        """A task for a build the image's agent does. Its builder VM is image-build-<task id>; one build at a time."""
        with self.lock:
            building = [task for task in self.tasks if task["status"] == "running" and task["kind"] == "agent"]
            busy = [task for task in self.tasks if task["status"] == "running" and task["name"] == name]
        if building:
            raise ImagesError(f"{building[0]['name']} is being made; one image at a time.")
        if busy:
            raise ImagesError(f"{name} is busy ({busy[0]['kind']} is running); wait until that is done.")
        task_id = "task_" + secrets.token_hex(3)
        (IMAGES_DIR / f"{task_id}.log").write_text("")
        task = {
            "id": task_id,
            "kind": "agent",
            "name": name,
            "vm": None,
            # Not named like the app's VMs (SANDBOX_VM_PREFIX), so the VM list never picks it up.
            "builder": f"image-build-{task_id.removeprefix('task_')}",
            "pid": None,
            "status": "running",
            "error": None,
            "started_at": datetime.now(UTC).isoformat(),
        }
        with self.lock:
            self.tasks.append(task)
            self.save_tasks()
            self.version += 1
        return dict(task)

    def log_task(self, task_id: str, text: str) -> None:
        """Add a line to an agent build's log (what the task row and its Log show)."""
        with open(IMAGES_DIR / f"{task_id}.log", "a") as log:
            log.write(" ".join(text.split())[:500] + "\n")
        with self.lock:
            self.version += 1

    def end_agent_build(self, task_id: str, error: str | None) -> None:
        """The agent's build ended. Worked (error None): the task goes. Failed: it stays, and its builder VM goes."""
        builder = None
        with self.lock:
            for task in self.tasks:
                if task["id"] != task_id:
                    continue
                task["status"] = "failed" if error else "done"
                task["error"] = error
                builder = task["builder"]
            self.tasks = [task for task in self.tasks if task["status"] != "done"]
            self.save_tasks()
            self.version += 1
        if error is None:
            (IMAGES_DIR / f"{task_id}.log").unlink(missing_ok=True)
            return
        if builder is not None:
            VM(builder).delete()

    def publish_build(self, task_id: str, name: str, builder: str, spec: str) -> None:
        """Make the agent's builder VM the image name (replacing an image of that name), then list what it has."""
        vm = VM(builder)
        vm.stop()
        # Uncompressed: bigger on disk, but new VMs unpack it faster.
        result = subprocess.run(
            ["incus", "publish", builder, "--alias", name, "--reuse", "--compression", "none"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            raise ImagesError(f"Could not publish {builder} as {name}: {result.stderr.strip()}")
        vm.delete()
        folder = self.spec_dir(name)
        (folder / "built.md").write_text(spec)
        self.end_agent_build(task_id, None)
        self.refresh()
        try:
            self.inspect(name)
        except ImagesError:
            # The image is made either way; Inspect in its row lists it later.
            pass

    def get_task(self, task_id: str) -> dict:
        with self.lock:
            for task in self.tasks:
                if task["id"] == task_id:
                    return dict(task)
        raise ImagesError(f"There is no task {task_id}")

    def dismiss(self, task_id: str) -> None:
        """Forget a failed task and its log."""
        with self.lock:
            matches = [task for task in self.tasks if task["id"] == task_id]
            if not matches:
                raise ImagesError(f"There is no task {task_id}")
            if matches[0]["status"] == "running":
                raise ImagesError("It is still running; stop it first.")
            self.tasks = [task for task in self.tasks if task["id"] != task_id]
            self.save_tasks()
            self.version += 1
        (IMAGES_DIR / f"{task_id}.log").unlink(missing_ok=True)
        if matches[0].get("builder"):
            VM(matches[0]["builder"]).delete()

    def stop(self, task_id: str) -> None:
        """Stop a running save or inspect: its whole process group. (An agent's build is stopped through the agent.)"""
        with self.lock:
            matches = [task for task in self.tasks if task["id"] == task_id and task["status"] == "running" and task["pid"] is not None]
        if not matches:
            raise ImagesError(f"There is no running task {task_id}")
        with self.lock:
            for task in self.tasks:
                if task["id"] == task_id:
                    task["stopped"] = True
            self.save_tasks()
        try:
            os.killpg(matches[0]["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass

    def save_vm(self, vm_name: str, name: str) -> dict:
        """Make an image from a stopped VM (a few minutes). The VM can't start until it is done."""
        if not re.fullmatch(NAME_PATTERN, name):
            raise ImagesError("The name must start with a letter and have only a-z, 0-9 and -, at most 41 characters")
        if name in self.names():
            raise ImagesError(f"There is already an image named {name}")
        try:
            record = self.vms.get(vm_name)
        except VMsError as error:
            raise ImagesError(str(error))
        if record.vm.status() != "Stopped":
            raise ImagesError(f"Stop {vm_name} first: only a stopped VM can be saved as an image.")
        # Values the VM's env file holds would go into every VM made from the image.
        if record.secrets_in_vm:
            raise ImagesError(
                f"{vm_name}'s files still hold environment variable values ({', '.join(record.secrets_in_vm)}), and they would "
                "go into the image. Remove them in its Settings while it runs, then stop it and save again."
            )
        with self.lock:
            saving = [task for task in self.tasks if task["status"] == "running" and (task["name"] == name or task["vm"] == vm_name)]
        if saving:
            raise ImagesError(f"{saving[0]['name']} is being made from {vm_name} already.")
        # Uncompressed, like the agent's builds: bigger on disk, but new VMs unpack it faster.
        script = f"set -e\nincus publish {record.incus_name} --alias {name} --compression none\nbash {INSPECT_SCRIPT} {name} {INVENTORY_DIR}\necho '==> Done'\n"
        # Held until the task ends, so neither the user nor an agent starts the VM meanwhile.
        if not record.lock.acquire(blocking=False):
            raise ImagesError(f"{vm_name} is busy")
        try:
            task, process = self.start_task("save", name, vm_name, script)
        except Exception:
            record.lock.release()
            raise
        threading.Thread(target=self.wait_then_release, args=(process, record), daemon=True).start()
        return task

    def wait_then_release(self, process: subprocess.Popen, record) -> None:
        process.wait()
        record.lock.release()

    def inspect(self, name: str) -> dict:
        """List what an image has (about two minutes, in a throwaway VM). New image and save do this by themselves."""
        image = self.find(name)
        with self.lock:
            busy = [task for task in self.tasks if task["status"] == "running" and task["name"] == image["name"]]
        if busy:
            raise ImagesError(f"{image['name']} is busy: {busy[0]['kind']} is running.")
        script = f"set -e\nbash {INSPECT_SCRIPT} {image['name']} {INVENTORY_DIR}\necho '==> Done'\n"
        task, process = self.start_task("inspect", image["name"], None, script)
        # Reap it when it ends, so it doesn't stay a zombie; check_tasks reads the outcome from the log.
        threading.Thread(target=process.wait, daemon=True).start()
        return task

    def start_task(self, kind: str, name: str, vm_name: str | None, script: str) -> tuple[dict, subprocess.Popen]:
        """Start the task's script; the caller waits for the process (so it is reaped)."""
        task_id = "task_" + secrets.token_hex(3)
        log = open(IMAGES_DIR / f"{task_id}.log", "w")
        # Its own session, so it outlives a backend restart and can be stopped as a group. Only what incus
        # needs from the environment: the backend's own variables (tokens from .env) stay out of it.
        env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "LANG": os.environ.get("LANG", "C.UTF-8")}
        process = subprocess.Popen(
            ["bash", "-c", script],
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            cwd=PROJECT_ROOT,
            env=env,
            start_new_session=True,
        )
        log.close()
        task = {
            "id": task_id,
            "kind": kind,
            "name": name,
            "vm": vm_name,
            "pid": process.pid,
            "status": "running",
            "error": None,
            "started_at": datetime.now(UTC).isoformat(),
        }
        with self.lock:
            self.tasks.append(task)
            self.save_tasks()
            self.version += 1
        return dict(task), process
