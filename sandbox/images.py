"""The images VMs start from: list them, pick the default, rename, describe, delete, and make new ones.

An image is an Incus image with a name (an Incus alias). Incus also keeps unnamed images, like the
download build.sh starts from; those aren't ours and aren't listed.

New images come two ways. Both are slow, so each runs as a task in the background:
- build: sandbox/image/build.sh <name> (about an hour): a fresh Ubuntu desktop plus provision.sh.
  Building with the name of an existing image replaces it (that's how an image is updated).
  VMs made from the old one keep their own disk.
- save a VM: `incus publish` of a stopped VM (a few minutes): everything on its disk comes along.

A task is a process of its own (its own session) that writes DATA_DIR/images/<task id>.log and
prints "==> Done" last when it worked. Its record in DATA_DIR/images/tasks.json keeps the pid, so a
backend restart (it reloads on code changes) doesn't stop it: the task is followed again from there.
Tasks that worked are dropped once the image shows up; failed ones stay until the user dismisses them.

The default image (what New VM picks first) is saved in DATA_DIR/images/settings.json. Until one is
picked it is SANDBOX_IMAGE from .env.

Images.version goes up on every change, so the live feed (backend /api/live) sends the list again.
"""

import json
import os
import re
import secrets
import signal
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.vms import VMs, VMsError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

IMAGES_DIR = PROJECT_ROOT / os.environ["DATA_DIR"] / "images"
DEFAULT_IMAGE = os.environ["SANDBOX_IMAGE"]
BUILD_SCRIPT = PROJECT_ROOT / "sandbox" / "image" / "build.sh"
NAME_PATTERN = r"[a-z][a-z0-9-]{0,40}"
# Tasks are checked this often; Incus's image list is read again every REFRESH_SECONDS.
CHECK_SECONDS = 2
REFRESH_SECONDS = 10
# How much of a task's log the live feed carries.
LOG_TAIL_LINES = 3


class ImagesError(Exception):
    pass


class Images:
    def __init__(self, vms: VMs):
        self.vms = vms
        self.lock = threading.Lock()  # Guards everything below.
        self.version = 0
        # The last list read from Incus: {"name", "aliases", "fingerprint", "description", "size_gb", "created_at"}.
        self.images: list[dict] = []
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        self.default = DEFAULT_IMAGE
        settings_path = IMAGES_DIR / "settings.json"
        if settings_path.exists():
            self.default = json.loads(settings_path.read_text()).get("default") or DEFAULT_IMAGE
        # {"id", "kind": "build" | "save", "name", "vm", "description", "pid", "status": "running" | "failed",
        #  "error", "started_at"}
        self.tasks: list[dict] = []
        tasks_path = IMAGES_DIR / "tasks.json"
        if tasks_path.exists():
            self.tasks = json.loads(tasks_path.read_text())
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
                    "description": image["properties"].get("description", ""),
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
            tasks = [dict(task) for task in self.tasks if task["status"] == "running"]
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
        return {"images": images, "default": default, "tasks": tasks}

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
        result = subprocess.run(["incus", "image", "alias", "rename", name, new_name], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise ImagesError(f"Could not rename {name}: {result.stderr.strip()}")
        with self.lock:
            if self.default == name:
                self.default = new_name
                self.save_settings()
        self.refresh()

    def set_description(self, name: str, description: str) -> None:
        image = self.find(name)
        result = subprocess.run(
            ["incus", "image", "set-property", image["fingerprint"], f"description={description}"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            raise ImagesError(f"Could not change the description of {name}: {result.stderr.strip()}")
        self.refresh()

    def delete(self, name: str) -> None:
        """Delete an image. VMs made from it keep working: each has its own disk."""
        image = self.find(name)
        if image["name"] == self.get_default():
            raise ImagesError(f"{name} is the default image. Make another one the default first.")
        with self.lock:
            busy = [task for task in self.tasks if task["status"] == "running" and task["name"] == image["name"]]
        if busy:
            raise ImagesError(f"{name} is being rebuilt; wait until that is done.")
        result = subprocess.run(["incus", "image", "delete", image["fingerprint"]], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise ImagesError(f"Could not delete {name}: {result.stderr.strip()}")
        self.refresh()

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

    def stop(self, task_id: str) -> None:
        """Stop a running task: its whole process group. build.sh deletes its builder VM on the way out."""
        with self.lock:
            matches = [task for task in self.tasks if task["id"] == task_id and task["status"] == "running"]
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

    def build(self, name: str, description: str) -> dict:
        """Build an image with sandbox/image/build.sh (about an hour). Only one build at a time: they share one builder VM."""
        if not re.fullmatch(NAME_PATTERN, name):
            raise ImagesError("The name must start with a letter and have only a-z, 0-9 and -, at most 41 characters")
        with self.lock:
            building = [task for task in self.tasks if task["status"] == "running" and task["kind"] == "build"]
            saving = [task for task in self.tasks if task["status"] == "running" and task["name"] == name]
        if building:
            raise ImagesError(f"{building[0]['name']} is being built; only one build runs at a time.")
        if saving:
            raise ImagesError(f"{name} is being made already.")
        script = f"set -e\nbash {BUILD_SCRIPT} {name}\n"
        if description:
            script += f"incus image set-property {name} description={self.quote(description)}\n"
        script += "echo '==> Done'\n"
        task, process = self.start_task("build", name, None, description, script)
        # Reap it when it ends, so it doesn't stay a zombie; check_tasks reads the outcome from the log.
        threading.Thread(target=process.wait, daemon=True).start()
        return task

    def save_vm(self, vm_name: str, name: str, description: str) -> dict:
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
        # Uncompressed, like build.sh: bigger on disk, but new VMs unpack it faster.
        script = f"set -e\nincus publish {record.incus_name} --alias {name} --compression none\n"
        if description:
            script += f"incus image set-property {name} description={self.quote(description)}\n"
        script += "echo '==> Done'\n"
        # Held until the task ends, so neither the user nor an agent starts the VM meanwhile.
        if not record.lock.acquire(blocking=False):
            raise ImagesError(f"{vm_name} is busy")
        try:
            task, process = self.start_task("save", name, vm_name, description, script)
        except Exception:
            record.lock.release()
            raise
        threading.Thread(target=self.wait_then_release, args=(process, record), daemon=True).start()
        return task

    def wait_then_release(self, process: subprocess.Popen, record) -> None:
        process.wait()
        record.lock.release()

    def quote(self, text: str) -> str:
        """Single-quote text for the task's bash script."""
        return "'" + text.replace("'", "'\\''") + "'"

    def start_task(self, kind: str, name: str, vm_name: str | None, description: str, script: str) -> tuple[dict, subprocess.Popen]:
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
            "description": description,
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
