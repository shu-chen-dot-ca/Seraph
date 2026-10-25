"""The images VMs start from: list them, pick the default, rename, delete, and make new ones.

An image is an Incus image with a name (an Incus alias). Incus also keeps unnamed images, like the
downloads builds start from; those aren't ours and aren't listed.

Each image we make is defined by one file, image.yaml: the system, the desktop, package lists, and steps for
anything else (see image_build.py). Under it go the defaults (DATA_DIR/images/defaults.yaml, the Defaults tab: the
same lists and steps for every image), unless it says defaults: false. A build turns the two into the image,
mechanically, from official sources only; what the app itself needs in every image comes from
sandbox/image/base_layer.sh, in neither. DATA_DIR/images/definitions/<name>/ holds:

    image.yaml   the definition: what the next build makes
    chat.json    the image agent's conversation

and DATA_DIR/images/built/ (image_build.BUILT_DIR) what each build was made from: <fingerprint>.yaml its image.yaml,
<fingerprint>.defaults.yaml the defaults (when it had them). So what a VM was made from (its image_fingerprint) is
known for good, also after its image is rebuilt or the defaults change.

How images come and change. Each runs in the background, as a task shown above the list:
- New image: the image's agent (image_agent.py) writes image.yaml from what the user picked and builds it ("agent"
  task while it works; each of its builds is a "build" task).
- Rebuild: image.yaml is built again, with no agent (image_build.py, "build" task). Only what changed since the
  last build runs again: its builder VM keeps snapshots between builds. The new build replaces the image; VMs made
  from the old one keep their own disk.
- The user changes image.yaml in Details > Definition, or asks the image's agent to. Every change is checked first
  (image_build.parse_definition). Nothing changes in the image until it is rebuilt: definition_changed (in the live
  feed) says image.yaml, or the defaults it has, differ from what the image was built from, and the Images tab
  shows a dot. A change to the defaults gives every image that has them a dot.
- save a VM: `incus publish` of a stopped VM (a few minutes): everything on its disk comes along. It has no
  image.yaml until its agent writes one, so it can't be rebuilt until then.
An image can only be deleted once no VM was made from it (stopped ones count too). Its builder VM goes with it.

What an image has (system, languages, tools, packages, models) is listed once, by sandbox/image/inspect.sh:
a throwaway VM from the image runs inventory.py, and the list goes to DATA_DIR/images/inventory/<fingerprint>.json.
Images never change, so that list stays true. Builds and saves inspect the new image at the end; an older
image is inspected with an inspect task (about two minutes). Lists of images that are gone (deleted, or
replaced by a rebuild) are kept, since VMs made from them still have what they listed.

A task (build, save, inspect) is a process of its own (its own session) that writes DATA_DIR/images/<task id>.log
and prints "==> Done" last when it worked. Its record in DATA_DIR/images/tasks.json keeps the pid, so a
backend restart (it reloads on code changes) doesn't stop it: the task is followed again from there.
The agent's work on a new image ("agent" task) has no process: the agent writes its log and ends it, and a backend
restart ends it as failed (the conversation went with the backend). One build at a time, and none while the agent
makes another image. Tasks that worked are dropped once the image shows up; failed ones stay until the user
dismisses them.

The default image (what New VM picks first) is saved in DATA_DIR/images/settings.json. Until one is picked the default is SANDBOX_IMAGE from .env. Deleting the default
leaves no default ("") until the user makes another one the default.

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
import sys
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox import image_build
from sandbox.vm import VM
from sandbox.vms import VMs, VMsError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

IMAGES_DIR = PROJECT_ROOT / os.environ["DATA_DIR"] / "images"
DEFAULT_IMAGE = os.environ["SANDBOX_IMAGE"]
INSPECT_SCRIPT = PROJECT_ROOT / "sandbox" / "image" / "inspect.sh"
INVENTORY_DIR = IMAGES_DIR / "inventory"
DEFINITIONS_DIR = IMAGES_DIR / "definitions"
# What New image offers. GNOME first: the default. None is a terminal-only image (no desktop, no browser).
DESKTOPS = list(image_build.DESKTOPS.values())
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
        settings_path = IMAGES_DIR / "settings.json"
        if settings_path.exists():
            settings = json.loads(settings_path.read_text())
            # "" stays "": the default was deleted and none is picked yet.
            self.default = settings.get("default", DEFAULT_IMAGE)
        # The short version of each inspected image's list (see highlights()), by fingerprint; lists never change.
        self.highlights_by_fingerprint: dict[str, dict] = {}
        # {"id", "kind": "agent" | "build" | "save" | "inspect", "name", "vm" (saved VM), "pid" (None for "agent"),
        #  "status": "running" | "failed", "error", "started_at"}
        self.tasks: list[dict] = []
        tasks_path = IMAGES_DIR / "tasks.json"
        if tasks_path.exists():
            self.tasks = json.loads(tasks_path.read_text())
        # The agent's work can't go on after a restart: its conversation ended with the backend. A build it
        # started is a process of its own and goes on.
        for task in self.tasks:
            if task["kind"] == "agent" and task["status"] == "running":
                task["status"] = "failed"
                task["error"] = "The backend restarted while the agent worked. Dismiss this and make the image again."
        self.refresh()
        threading.Thread(target=self.watch, daemon=True).start()

    # --- Saving -------------------------------------------------------------------

    def save_settings(self) -> None:
        temporary = IMAGES_DIR / "settings.json.tmp"
        temporary.write_text(json.dumps({"default": self.default}, indent=2))
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
            image["definition_changed"] = self.definition_changed(image)
            image["definition_updated_at"] = self.definition_updated_at(image["name"])
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
        if (DEFINITIONS_DIR / name).exists():
            # A folder left by an image deleted outside the app would be in the way.
            shutil.rmtree(DEFINITIONS_DIR / new_name, ignore_errors=True)
            (DEFINITIONS_DIR / name).rename(DEFINITIONS_DIR / new_name)
        # Its builder VM (with the snapshots the next build starts from) goes along, if it has one.
        VM(image_build.BUILDER_PREFIX + new_name).delete()
        subprocess.run(
            ["incus", "rename", image_build.BUILDER_PREFIX + name, image_build.BUILDER_PREFIX + new_name],
            capture_output=True,
            stdin=subprocess.DEVNULL,
        )
        with self.lock:
            if self.default == name:
                self.default = new_name
                self.save_settings()
        self.refresh()

    def delete(self, name: str) -> None:
        """Delete an image no VM was made from (running or not). Deleting the default leaves no default."""
        image = self.find(name)
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
        shutil.rmtree(DEFINITIONS_DIR / image["name"], ignore_errors=True)
        VM(image_build.BUILDER_PREFIX + image["name"]).delete()
        with self.lock:
            if self.default == image["name"]:
                self.default = ""
                self.save_settings()
                self.version += 1
        self.refresh()

    # --- The image's definition -----------------------------------------------------

    def new_options(self) -> dict:
        """What New image offers, and the system it picks first."""
        systems = [{"id": system["id"], "label": system["label"]} for system in image_build.SYSTEMS]
        return {"systems": systems, "desktops": DESKTOPS, "system": image_build.SYSTEMS[0]["id"]}

    def new_request(self, name: str, system: str, desktop: str, use_defaults: bool, comments: str) -> str:
        """What the user asked for in New image, for the agent that writes the new image's image.yaml.
        Makes the image's folder (without image.yaml yet)."""
        if not re.fullmatch(NAME_PATTERN, name):
            raise ImagesError("The name must start with a letter and have only a-z, 0-9 and -, at most 41 characters")
        if name in self.names():
            raise ImagesError(f"There is already an image named {name}")
        labels = [each["label"] for each in image_build.SYSTEMS if each["id"] == system]
        if not labels:
            raise ImagesError(f"Unknown system {system}")
        if desktop not in DESKTOPS:
            raise ImagesError(f"Unknown desktop {desktop}")
        lines = [f"New image {name}", f"System: {labels[0]} ({system})", f"Desktop: {desktop}"]
        # Firefox on every desktop; a terminal-only image has no browser.
        if desktop != DESKTOPS[-1]:
            lines.append("Browser: Firefox")
        if use_defaults:
            lines.append("Defaults: in (everything in the defaults goes under its image.yaml)")
        else:
            lines.append("Defaults: left out (its image.yaml says defaults: false)")
        if comments.strip():
            lines += ["Comments:", comments.strip()]
        # A folder left by an image of this name that is gone would be in the way.
        shutil.rmtree(DEFINITIONS_DIR / name, ignore_errors=True)
        (DEFINITIONS_DIR / name).mkdir(parents=True)
        return "\n".join(lines)

    # --- The defaults ----------------------------------------------------------------

    def read_defaults(self) -> dict:
        """The defaults as they are now, and as the app first had them (to go back to)."""
        return {"defaults": image_build.read_defaults(), "original": image_build.DEFAULTS_TEMPLATE.read_text()}

    def write_defaults(self, text: str) -> None:
        """Change the defaults, only to ones that are right. Every image that has them changes at its next Rebuild."""
        try:
            image_build.parse_definition(text, defaults=True)
        except image_build.DefinitionError as error:
            raise ImagesError(str(error))
        # Write, then rename: a crash never leaves half a file.
        temporary = image_build.DEFAULTS_FILE.with_suffix(".yaml.tmp")
        temporary.write_text(text)
        temporary.replace(image_build.DEFAULTS_FILE)
        with self.lock:
            self.version += 1

    def image_dir(self, name: str) -> Path:
        """The image's folder (made when missing: an image saved from a VM has none until its agent writes to it)."""
        # The name comes from the URL too: nothing outside DEFINITIONS_DIR.
        if not re.fullmatch(NAME_PATTERN, name):
            raise ImagesError(f"{name} can't have a definition: the name must have only a-z, 0-9 and -")
        folder = DEFINITIONS_DIR / name
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def built_definition(self, fingerprint: str, suffix: str = ".yaml") -> str | None:
        """What the image with this fingerprint was built from: its image.yaml, or (suffix ".defaults.yaml") the
        defaults under it. None when it had none (saved from a VM, built without the defaults)."""
        if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
            return None
        path = image_build.BUILT_DIR / f"{fingerprint}{suffix}"
        return path.read_text() if path.exists() else None

    def defaults_changed(self, image: dict) -> bool:
        """Whether the image was built with the defaults and they changed since."""
        built = self.built_definition(image["fingerprint"], ".defaults.yaml")
        return built is not None and built != image_build.read_defaults()

    def definition_changed(self, image: dict) -> bool:
        """Whether a Rebuild would make something else: image.yaml differs from what the image was built from (or it
        was never built from one), or it is the same and has the defaults, which changed since."""
        path = DEFINITIONS_DIR / image["name"] / "image.yaml"
        if not path.exists():
            return False
        if path.read_text() != self.built_definition(image["fingerprint"]):
            return True
        return self.defaults_changed(image)

    def definition_updated_at(self, name: str) -> float:
        """When image.yaml last changed (0 without one), so the browser knows to fetch it again."""
        path = DEFINITIONS_DIR / name / "image.yaml"
        return path.stat().st_mtime if path.exists() else 0.0

    def read_definition(self, name: str) -> str:
        """image.yaml as it is now ("" before it is written)."""
        path = self.image_dir(name) / "image.yaml"
        return path.read_text() if path.exists() else ""

    def write_definition(self, name: str, text: str) -> None:
        """Change image.yaml, only to one that is right (image_build.parse_definition says what isn't). The image
        itself only changes when it is rebuilt."""
        try:
            image_build.parse_definition(text)
        except image_build.DefinitionError as error:
            raise ImagesError(str(error))
        folder = self.image_dir(name)
        # Write, then rename: a crash never leaves half a file.
        (folder / "image.yaml.tmp").write_text(text)
        (folder / "image.yaml.tmp").replace(folder / "image.yaml")
        with self.lock:
            self.version += 1

    def definition(self, name: str) -> dict:
        """image.yaml now, a diff from what the image was built from ("" when the same or never built), whether the
        defaults it has changed since, and what a build makes of it now (combined with the defaults; "" while it
        isn't right). Also for an image still being made (it has a folder but isn't listed yet)."""
        if not (DEFINITIONS_DIR / name).exists():
            name = self.find(name)["name"]
        now = self.read_definition(name)
        built = None
        defaults_changed = False
        if name in self.names():
            built = self.built_definition(self.find(name)["fingerprint"])
            defaults_changed = now == built and self.defaults_changed(self.find(name))
        diff = ""
        if built is not None:
            diff = "".join(difflib.unified_diff(built.splitlines(keepends=True), now.splitlines(keepends=True), "built", "image.yaml"))
        combined = ""
        try:
            definition = image_build.parse_definition(now)
            defaults = image_build.parse_definition(image_build.read_defaults(), defaults=True)
            combined = image_build.combined_yaml(image_build.combine(definition, defaults))
        except image_build.DefinitionError:
            pass
        return {"definition": now, "diff": diff, "defaults_changed": defaults_changed, "combined": combined}

    def discard_changes(self, name: str) -> None:
        """Put image.yaml back to what the image was built from."""
        image = self.find(name)
        built = self.built_definition(image["fingerprint"])
        if built is None:
            raise ImagesError(f"{name} wasn't built from an image.yaml, so there is nothing to go back to.")
        (self.image_dir(image["name"]) / "image.yaml").write_text(built)
        with self.lock:
            self.version += 1

    def last_failed_build(self, name: str) -> dict | None:
        """The image's latest failed build or agent work that is still listed: its error and its log."""
        with self.lock:
            failed = [dict(task) for task in self.tasks if task["name"] == name and task["status"] == "failed" and task["kind"] in ["agent", "build"]]
        if not failed:
            return None
        return {"error": failed[-1]["error"], "log": self.read_log(failed[-1]["id"])}

    # --- Builds ------------------------------------------------------------------------

    def build(self, name: str) -> dict:
        """Build the image from its image.yaml (image_build.py), as a task, replacing the image of that name. Also for
        an image the agent is still making (it has a folder but isn't listed yet). Minutes: only what changed since
        the last build runs again."""
        if not (DEFINITIONS_DIR / name).exists():
            name = self.find(name)["name"]
        text = self.read_definition(name)
        if not text:
            raise ImagesError(f"{name} has no image.yaml, so it can't be built. Ask its agent to write one.")
        try:
            image_build.parse_definition(text)
        except image_build.DefinitionError as error:
            raise ImagesError(f"{name}'s image.yaml isn't right: {error}")
        with self.lock:
            building = [task for task in self.tasks if task["status"] == "running" and task["kind"] == "build"]
            agents = [task for task in self.tasks if task["status"] == "running" and task["kind"] == "agent" and task["name"] != name]
            busy = [task for task in self.tasks if task["status"] == "running" and task["name"] == name and task["kind"] != "agent"]
        if building or agents:
            raise ImagesError(f"{(building + agents)[0]['name']} is being made; one image at a time.")
        if busy:
            raise ImagesError(f"{name} is busy ({busy[0]['kind']} is running); wait until that is done.")
        script = f"set -e\n{sys.executable} -m sandbox.image_build {name} {self.image_dir(name)}\nbash {INSPECT_SCRIPT} {name} {INVENTORY_DIR}\necho '==> Done'\n"
        task, process = self.start_task("build", name, None, script)
        # Reap it when it ends, so it doesn't stay a zombie; check_tasks reads the outcome from the log.
        threading.Thread(target=process.wait, daemon=True).start()
        return task

    def task_state(self, task_id: str) -> tuple[str, str | None]:
        """"running", "failed" (and why) or "done": a task that worked is dropped, so one that isn't listed is done."""
        with self.lock:
            for task in self.tasks:
                if task["id"] == task_id:
                    return task["status"], task["error"]
        return "done", None

    # --- The agent making a new image ------------------------------------------------------

    def start_agent_build(self, name: str) -> dict:
        """A task for the agent's work on a new image, until it ends its turn; one at a time, and not during a build."""
        with self.lock:
            building = [task for task in self.tasks if task["status"] == "running" and task["kind"] in ["agent", "build"]]
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
        """Add a line to the agent's task log (what the task row and its Log show)."""
        with open(IMAGES_DIR / f"{task_id}.log", "a") as log:
            log.write(" ".join(text.split())[:500] + "\n")
        with self.lock:
            self.version += 1

    def end_agent_build(self, task_id: str, error: str | None) -> None:
        """The agent's work on a new image ended. Worked (error None): the task goes. Failed: it stays until dismissed."""
        with self.lock:
            for task in self.tasks:
                if task["id"] != task_id:
                    continue
                task["status"] = "failed" if error else "done"
                task["error"] = error
            self.tasks = [task for task in self.tasks if task["status"] != "done"]
            self.save_tasks()
            self.version += 1
        if error is None:
            (IMAGES_DIR / f"{task_id}.log").unlink(missing_ok=True)

    def get_task(self, task_id: str) -> dict:
        with self.lock:
            for task in self.tasks:
                if task["id"] == task_id:
                    return dict(task)
        raise ImagesError(f"There is no task {task_id}")

    def dismiss(self, task_id: str) -> None:
        """Forget a failed task and its log. A failed build's builder VM stays: its snapshots are the next build's start."""
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
        # A new image that was never made: its builder VM would only take up disk.
        if matches[0]["kind"] == "agent" and matches[0]["name"] not in self.names():
            VM(image_build.BUILDER_PREFIX + matches[0]["name"]).delete()

    def stop(self, task_id: str) -> None:
        """Stop a running build, save or inspect: its whole process group. A build's process stops its builder VM
        on the way out. (The agent's work is stopped through the agent.)"""
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
                "go into the image. Remove them in its Settings (or in Settings, for all VMs) while it runs, then stop it and save again."
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
