"""All VMs: create, delete, rename, start, stop, their settings, and how much they use.

A VM is a resource, not tied to a repo or an agent. Each one is an Incus VM named
<SANDBOX_VM_PREFIX><name> (e.g. sandbox-vm1) plus a record on disk:

    DATA_DIR/vms/<name>.json   {"name", "incus_name", "image", "image_fingerprint", "cpus", "memory_gb",
                                "disk_gb", "internet", "env", "secrets_in_vm", "autostart", "status",
                                "created_at", "forked_from", "holder", "priority", "queue", "runs", "traffic",
                                "notes"}

"image" is the name of the image it was made from (sandbox/images.py) and "image_fingerprint" the exact
build, since an image can be rebuilt or renamed later. A fork (a copy of a stopped VM, see VMs.fork) has its
source's image and "forked_from" names the source. "secrets_in_vm" are the env variables whose values
are written in the VM's files right now, so an image is never saved from a VM that still holds them.

"notes" are what is set up in the VM, so the next agent knows before it picks the VM or starts in it (e.g.
"openclaw cloned in ~/openclaw and built, on main; a plugin added for issue 123"). Oldest first:

    [{"id": "note_a1b2c3", "text", "by": an agent id or "user", "at"}]

The agent holding the VM adds and removes them (work_tools.py), the user on the VM page's Notes tab. Agents can't
remove the user's. A fork starts with its source's notes, since its disk is a copy.

Every VM gets this machine's time zone when it is made and whenever it starts (VM.use_host_timezone): it goes out
through this machine's network, and a browser whose clock doesn't match where its address is looks like a bot.
For the same reason Firefox in every VM names a common graphics card to sites instead of "llvmpipe" (software
drawing: the VM has no graphics card), also set at every start (VM.set_firefox_graphics_name).
Every start also puts the agents' browser in the VM and starts it (VM.set_up_browser,
sandbox/agent/browser_service.py): a Firefox nobody sees, one session per agent, that the browser_* tools use.

The env variables for all VMs (set in the Settings dialog) are in DATA_DIR/global_env.json, not in vms/
(every .json there is a VM's record). Every VM gets them, with its own on top (see VMRecord.write_env).

holder, priority, queue and runs belong to VMQueue (vm_queue.py); they live here so they are saved with the VM.
runs are the long commands agents left going in it (sandbox/agent/long_runs.py).
Only kept while the backend runs: usage (on, whether it answers, CPU %, memory and disk in use, internet
download and upload speed), samples (the last 60 of those, one per second) and locked_by (who locked the
human out of the desktop).

Internet use is counted inside the VM, so the user can watch it on a metered connection (a phone hotspot).
Counting the VM's network card from outside would also count the desktop and terminals the browser shows,
which never leave this machine. So two iptables rules in the VM count only what goes to or comes from
outside the VM's own network (TRAFFIC_SCRIPT). Their counters start at zero when the VM boots; "traffic"
adds up what they counted into totals that survive restarts, until the user resets them:

    "traffic": {"down", "up" (bytes since "since"), "since", "boot_id", "last_down", "last_up"}

boot_id and last_* are the VM's counters at the last read, so a backend restart doesn't count anything twice.

A rename (VMs.rename) only changes the record: the Incus VM keeps the name it was made with, so a running VM
can be renamed too. A new VM whose Incus name is still taken that way gets a number after it (sandbox-vm1-2).

Incus is the truth: an Incus VM with the prefix but no record (e.g. data/ was deleted) gets a
new record, so it shows up and can be used or deleted. It is looked for at start and every
SCAN_SECONDS. The image builder VM is never one of them.

Status: creating -> running -> stopping -> stopped -> starting -> running, or failed.
"missing" means the Incus VM is gone. Only one lifecycle action runs on a VM at a time;
a second one gets VMsError.

VMs.version goes up on every record change and every usage sample, so the live feed
(backend /api/live) sends the VM list whenever anything in it changed.
"""

import json
import os
import re
import secrets
import shlex
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

from sandbox.vm import VM

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

VMS_DIR = PROJECT_ROOT / os.environ["DATA_DIR"] / "vms"
GLOBAL_ENV_PATH = PROJECT_ROOT / os.environ["DATA_DIR"] / "global_env.json"
VM_PREFIX = os.environ["SANDBOX_VM_PREFIX"]
# The VM that builds the image may have the same prefix but is not one of ours.
BUILD_VM = os.environ["SANDBOX_BUILD_VM"]
PROFILE = os.environ["SANDBOX_PROFILE"]
OFFLINE_ACL = os.environ["SANDBOX_OFFLINE_ACL"]
VM_ENV_FILE = os.environ["SANDBOX_VM_ENV_FILE"]
CPUS_DEFAULT = int(os.environ["SANDBOX_CPUS_DEFAULT"])
CPUS_ALLOWED = [int(cpus) for cpus in os.environ["SANDBOX_CPUS_ALLOWED"].split(",")]
MEMORY_GB_DEFAULT = int(os.environ["SANDBOX_MEMORY_GB_DEFAULT"])
MEMORY_GB_ALLOWED = [int(gb) for gb in os.environ["SANDBOX_MEMORY_GB_ALLOWED"].split(",")]
DISK_GB_DEFAULT = int(os.environ["SANDBOX_DISK_GB_DEFAULT"])
DISK_GB_MIN = int(os.environ["SANDBOX_DISK_GB_MIN"])
DISK_GB_MAX = int(os.environ["SANDBOX_DISK_GB_MAX"])
MIN_FREE_RAM_GB = int(os.environ["SANDBOX_MIN_FREE_RAM_GB"])
NAME_PATTERN = r"[a-z][a-z0-9-]{0,30}"
SCAN_SECONDS = 10
SAMPLES_KEPT = 60
# Disk use is read inside the VM (df), so not every second.
DISK_SECONDS = 30
# Internet use is read inside the VM too. Bytes counted between the last read and a reboot are lost,
# so it is read often.
NETWORK_SECONDS = 2
# Run as root in the VM: make the counting rules if they aren't there yet (after a boot), then print
# the boot id and the bytes counted. The VM's own network is the Incus bridge: this machine, the
# desktop and terminals the browser shows, DNS. Docker's networks never pass the VM's network card.
TRAFFIC_SCRIPT = """
dev=$(ip -4 route show default | awk '{print $5; exit}')
net=$(ip -4 -o addr show dev "$dev" | awk '{print $4; exit}')
[ -n "$dev" ] && [ -n "$net" ] || { echo "No network yet" >&2; exit 3; }
iptables -w -t mangle -C PREROUTING -i "$dev" ! -s "$net" -m comment --comment sandbox-internet-down 2>/dev/null ||
    iptables -w -t mangle -A PREROUTING -i "$dev" ! -s "$net" -m comment --comment sandbox-internet-down
iptables -w -t mangle -C POSTROUTING -o "$dev" ! -d "$net" -m comment --comment sandbox-internet-up 2>/dev/null ||
    iptables -w -t mangle -A POSTROUTING -o "$dev" ! -d "$net" -m comment --comment sandbox-internet-up
cat /proc/sys/kernel/random/boot_id
iptables -w -t mangle -L -v -x -n | awk '/sandbox-internet-down/ {print "down", $2} /sandbox-internet-up/ {print "up", $2}'
"""


class VMsError(Exception):
    pass


class VMRecord:
    # The env variables for all VMs (the Settings dialog), the same for every record. VMs loads it and
    # replaces it whole on a change, so a reader never sees half of it.
    global_env: dict[str, str] = {}

    def __init__(self, record: dict, changed):
        self.name = record["name"]
        self.incus_name = record["incus_name"]
        self.vm = VM(record["incus_name"])
        # Records from before images could be picked have none; refresh() reads the fingerprint from Incus.
        self.image = record.get("image", "")
        self.image_fingerprint = record.get("image_fingerprint", "")
        self.cpus = record["cpus"]
        self.memory_gb = record["memory_gb"]
        self.disk_gb = record["disk_gb"]
        self.internet = record["internet"]
        self.env = record["env"]
        # Records from before this was kept: assume the values set are the ones written.
        self.secrets_in_vm = record.get("secrets_in_vm", [key for key, value in record["env"].items() if value])
        self.autostart = record["autostart"]
        self.status = record["status"]
        self.created_at = record["created_at"]
        # Who uses the VM ("user", an agent id or None) and the agents waiting for it. Changed by VMQueue only.
        self.holder = record["holder"]
        self.queue = record["queue"]
        # Agents that stepped aside (checked first for the next turn), and the long runs agents left going in the VM.
        # Changed by VMQueue only. Records from before stepping aside have neither.
        self.priority = record.get("priority", [])
        self.runs = record.get("runs", [])
        # The VM this one is a copy of, or "" (records from before forks have none).
        self.forked_from = record.get("forked_from", "")
        # Records from before internet use was counted have no traffic.
        self.traffic = record.get("traffic") or {
            "down": 0,
            "up": 0,
            "since": datetime.now(UTC).isoformat(),
            "boot_id": None,
            "last_down": 0,
            "last_up": 0,
        }
        # The watcher adds to traffic while the user may reset it.
        self.traffic_lock = threading.Lock()
        # Records from before notes were kept have none.
        self.notes = record.get("notes", [])
        # The agent holding the VM and the user may change the notes at the same time.
        self.notes_lock = threading.Lock()
        # Called after every save; VMs bumps its version there.
        self.changed = changed
        # One lifecycle action at a time (create, start, stop, delete, resources).
        self.lock = threading.Lock()
        # Two threads may save at once (the watcher and VMQueue): one write at a time.
        self.save_lock = threading.Lock()
        # Set once the VM is deleted, so a late save doesn't bring the record back.
        self.deleted = False
        # Runtime only, kept fresh by VMs' watcher thread. Reading them never waits on Incus.
        self.usage = {
            "on": False,
            "responding": False,
            "cpu_percent": None,
            "memory_used_gb": None,
            "disk_used_gb": None,
            "net_down_rate": None,
            "net_up_rate": None,
        }
        self.samples: list[dict] = []
        # Who locked the human's mouse and keyboard out of the desktop: "user", "agent" or None.
        self.locked_by: str | None = None
        # Why the last create, start or stop failed (None when it worked).
        self.error: str | None = None
        # The last CPU reading (nanoseconds used, time read), to work out CPU % between two reads.
        self.last_cpu: tuple[int, float] | None = None
        # The last disk reading (GB used, time read).
        self.last_disk: tuple[float, float] | None = None
        # When the internet counters were last asked for, and last read; the speed (bytes a second) between two reads.
        self.traffic_tried_at: float | None = None
        self.traffic_read_at: float | None = None
        self.net_down_rate: float | None = None
        self.net_up_rate: float | None = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "incus_name": self.incus_name,
            "image": self.image,
            "image_fingerprint": self.image_fingerprint,
            "cpus": self.cpus,
            "memory_gb": self.memory_gb,
            "disk_gb": self.disk_gb,
            "internet": self.internet,
            "env": dict(self.env),
            "secrets_in_vm": list(self.secrets_in_vm),
            "autostart": self.autostart,
            "status": self.status,
            "created_at": self.created_at,
            "holder": self.holder,
            "priority": list(self.priority),
            "queue": list(self.queue),
            "runs": [dict(run) for run in self.runs],
            "forked_from": self.forked_from,
            "traffic": dict(self.traffic),
            "notes": list(self.notes),
        }

    def save(self) -> None:
        with self.save_lock:
            if self.deleted:
                return
            VMS_DIR.mkdir(parents=True, exist_ok=True)
            # Write, then rename: a crash never leaves half a record.
            temporary = VMS_DIR / f"{self.name}.json.tmp"
            temporary.write_text(json.dumps(self.to_dict(), indent=2))
            temporary.replace(VMS_DIR / f"{self.name}.json")
        self.changed()

    # --- Lifecycle -------------------------------------------------------------

    def launch(self) -> None:
        """Make the Incus VM and wait until its desktop is up (about a minute). Nothing is cloned.

        If it fails the record stays, as "failed", so the user sees why and can delete it.
        """
        if not self.lock.acquire(blocking=False):
            raise VMsError(f"{self.name} is busy")
        try:
            self.error = None
            self.status = "creating"
            self.save()
            self.vm.launch(self.image, PROFILE, self.cpus, self.memory_gb, f"{self.disk_gb}GiB")
            self.image_fingerprint = self.vm.base_image()
            self.vm.wait_ready()
            self.vm.guard_memory()
            self.vm.guard_shadow_stack()
            self.vm.use_host_timezone()
            self.vm.set_firefox_graphics_name()
            self.vm.set_up_browser()
            self.write_env()
            self.status = "running"
            self.save()
        except Exception as error:
            self.error = str(error)
            self.status = "failed"
            self.save()
            raise
        finally:
            self.lock.release()

    def fork_from(self, source: "VMRecord") -> None:
        """Copy the stopped source VM into this one, then start it. The caller holds source.lock; it is released
        once the copy is made, so the source can start again while this one boots.

        If it fails the record stays, as "failed", so the user sees why and can delete it.
        """
        if not self.lock.acquire(blocking=False):
            source.lock.release()
            raise VMsError(f"{self.name} is busy")
        try:
            self.error = None
            self.status = "creating"
            self.save()
            try:
                source.vm.copy(self.incus_name)
            finally:
                source.lock.release()
            self.vm.start()
            self.vm.wait_ready()
            self.vm.guard_memory()
            self.vm.guard_shadow_stack()
            self.vm.use_host_timezone()
            self.vm.set_firefox_graphics_name()
            self.vm.set_up_browser()
            self.write_env()
            self.status = "running"
            self.save()
        except Exception as error:
            self.error = str(error)
            self.status = "failed"
            self.save()
            raise
        finally:
            self.lock.release()

    def start(self) -> None:
        if not self.lock.acquire(blocking=False):
            raise VMsError(f"{self.name} is busy")
        try:
            if self.vm.status() == "Running":
                if self.status != "running":
                    self.status = "running"
                    self.save()
                return
            # Keep MIN_FREE_RAM_GB free for this machine after the VM takes its memory.
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            if free_gb - self.memory_gb < MIN_FREE_RAM_GB:
                raise VMsError(
                    f"Not enough free memory: {free_gb:.1f}GB free, the VM needs {self.memory_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )
            self.error = None
            self.status = "starting"
            self.save()
            self.vm.start()
            self.vm.wait_ready()
            # Also here, so VMs made before these guards existed get them.
            self.vm.guard_memory()
            self.vm.guard_shadow_stack()
            self.vm.use_host_timezone()
            self.vm.set_firefox_graphics_name()
            self.vm.set_up_browser()
            self.write_env()
            self.status = "running"
            self.save()
        except Exception as error:
            self.error = str(error)
            self.status = "running" if self.vm.status() == "Running" else "stopped"
            self.save()
            raise
        finally:
            self.lock.release()

    def stop(self) -> None:
        """Shut the VM down. Its disk is kept, so start() brings it back."""
        if not self.lock.acquire(blocking=False):
            raise VMsError(f"{self.name} is busy")
        try:
            self.error = None
            self.status = "stopping"
            self.save()
            self.vm.stop()
            self.status = "stopped"
            self.save()
        except Exception as error:
            self.error = str(error)
            self.status = "running" if self.vm.status() == "Running" else "stopped"
            self.save()
            raise
        finally:
            self.lock.release()

    def restart(self) -> None:
        """Stop and start again. A frozen VM is forced off (vm.stop does that), so this also unfreezes it."""
        self.stop()
        self.start()

    def read_usage(self) -> dict:
        """Whether the VM is on, and its CPU %, memory and disk in use and internet speed right now.

        CPU % is measured between two calls, so the first call after a start has none.
        Incus doesn't report disk use for VMs on this storage pool, so it is read with df inside
        the VM every DISK_SECONDS; it is None until the VM answers commands.
        The internet counters are read every NETWORK_SECONDS (count_traffic); the speed is None until two reads.
        """
        state = self.vm.state()
        if state is None or state["status"] != "Running":
            self.last_cpu = None
            self.last_disk = None
            self.traffic_tried_at = None
            self.traffic_read_at = None
            self.net_down_rate = None
            self.net_up_rate = None
            return {
                "on": False,
                "responding": False,
                "cpu_percent": None,
                "memory_used_gb": None,
                "disk_used_gb": None,
                "net_down_rate": None,
                "net_up_rate": None,
            }

        # Incus only counts processes through the VM's Incus agent: -1 means it doesn't answer, so the VM
        # is still booting, or it froze or crashed while Incus still says Running.
        responding = state.get("processes", -1) != -1
        now = time.monotonic()
        cpu_ns = state["cpu"]["usage"]
        cpu_percent = None
        if self.last_cpu is not None and now > self.last_cpu[1]:
            seconds = now - self.last_cpu[1]
            cpu_percent = (cpu_ns - self.last_cpu[0]) / (seconds * 1e9 * self.cpus) * 100
            cpu_percent = max(0.0, min(100.0, cpu_percent))
        self.last_cpu = (cpu_ns, now)
        memory_used_gb = state["memory"]["usage"] / 1024**3
        disk_used_gb = None
        if self.last_disk is not None:
            disk_used_gb = self.last_disk[0]
        disks = state.get("disk") or {}
        if "root" in disks and disks["root"].get("usage"):
            disk_used_gb = disks["root"]["usage"] / 1024**3
        elif responding and (self.last_disk is None or now - self.last_disk[1] > DISK_SECONDS):
            # Noted even when it fails, so a VM that doesn't answer yet is asked again later, not every second.
            self.last_disk = (disk_used_gb, now)
            result = self.vm.exec_root("df -B1 --output=used / | tail -1", 10)
            if result.returncode == 0 and result.stdout.strip().isdigit():
                disk_used_gb = int(result.stdout.strip()) / 1024**3
                self.last_disk = (disk_used_gb, now)
        if responding and (self.traffic_tried_at is None or now - self.traffic_tried_at >= NETWORK_SECONDS):
            self.traffic_tried_at = now
            self.count_traffic()
        return {
            "on": True,
            "responding": responding,
            "cpu_percent": cpu_percent,
            "memory_used_gb": memory_used_gb,
            "disk_used_gb": disk_used_gb,
            "net_down_rate": self.net_down_rate,
            "net_up_rate": self.net_up_rate,
        }

    def count_traffic(self) -> None:
        """Read the VM's internet counters, add what is new to the totals, and work out the speed."""
        result = self.vm.exec_root(TRAFFIC_SCRIPT, 10)
        if result.returncode != 0:
            # No speed rather than an old one; the next read that works counts what was missed.
            self.net_down_rate = None
            self.net_up_rate = None
            return
        lines = result.stdout.splitlines()
        boot_id = lines[0].strip() if lines else ""
        down = None
        up = None
        for line in lines[1:]:
            if line.startswith("down "):
                down = int(line.split()[1])
            if line.startswith("up "):
                up = int(line.split()[1])
        if not boot_id or down is None or up is None:
            return

        now = time.monotonic()
        with self.traffic_lock:
            traffic = self.traffic
            same_counters = traffic["boot_id"] == boot_id and down >= traffic["last_down"] and up >= traffic["last_up"]
            if same_counters:
                down_new = down - traffic["last_down"]
                up_new = up - traffic["last_up"]
            else:
                # The VM booted again (or the rules were made again): its counters started from zero.
                down_new = down
                up_new = up
            traffic["down"] += down_new
            traffic["up"] += up_new
            traffic["boot_id"] = boot_id
            traffic["last_down"] = down
            traffic["last_up"] = up
        if same_counters and self.traffic_read_at is not None and now > self.traffic_read_at:
            self.net_down_rate = down_new / (now - self.traffic_read_at)
            self.net_up_rate = up_new / (now - self.traffic_read_at)
        else:
            self.net_down_rate = None
            self.net_up_rate = None
        self.traffic_read_at = now
        if down_new or up_new or not same_counters:
            self.save()

    def reset_traffic(self) -> None:
        """Start counting internet use from zero, from now."""
        with self.traffic_lock:
            self.traffic["down"] = 0
            self.traffic["up"] = 0
            self.traffic["since"] = datetime.now(UTC).isoformat()
        self.save()

    def add_note(self, text: str, by: str) -> dict:
        """Note what is set up in the VM. by is an agent id or "user"."""
        text = text.strip()
        if not text:
            raise VMsError("The note is empty")
        note = {"id": f"note_{secrets.token_hex(3)}", "text": text, "by": by, "at": datetime.now(UTC).isoformat()}
        with self.notes_lock:
            # A new list, so a reader never sees one half changed.
            self.notes = self.notes + [note]
        self.save()
        return note

    def remove_notes(self, ids: list[str], by: str) -> list[str]:
        """Take notes off by id, and give back the ones removed. Only the user removes the user's own notes."""
        removed = []
        with self.notes_lock:
            kept = []
            for note in self.notes:
                if note["id"] in ids and (by == "user" or note["by"] != "user"):
                    removed.append(note["id"])
                else:
                    kept.append(note)
            self.notes = kept
        self.save()
        return removed

    def refresh(self) -> None:
        """Make the status match what Incus says (after a backend restart or a crash)."""
        vm_status = self.vm.status()
        if vm_status is not None and not self.image_fingerprint:
            self.image_fingerprint = self.vm.base_image()
        if vm_status is None:
            self.status = "missing"
        elif self.status in ("creating", "failed"):
            # A create that didn't finish (e.g. the backend stopped mid-way) stays failed.
            self.status = "failed"
        elif vm_status == "Running":
            self.status = "running"
        else:
            self.status = "stopped"
        self.save()

    # --- Settings ----------------------------------------------------------------

    def set_internet(self, enabled: bool) -> None:
        """Turn the VM's internet on or off. Applies right away, running or not."""
        try:
            self.vm.set_internet(enabled, OFFLINE_ACL)
        except Exception as error:
            raise VMsError(f"Could not turn the internet {'on' if enabled else 'off'}: {error}")
        self.internet = enabled
        self.save()

    def set_env(self, env: dict[str, str]) -> None:
        """Environment variables for everything in the VM: terminals, desktop, the agent's commands.

        Shells started after this see them (desktop terminals too, through ~/.bashrc);
        ones already open keep the old values. A stopped VM gets them when it starts.
        """
        for key in env:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise VMsError(f"Not a valid variable name: {key}")
        self.env = dict(env)
        self.save()
        if self.vm.status() == "Running":
            self.write_env()

    def write_env(self) -> None:
        """Put the variables in the VM (it must be running): the ones for all VMs, and the VM's own.

        A name the VM has itself wins over the one for all VMs, unless its value is empty (an agent
        asked for it and nobody filled it in): then the value for all VMs is used.
        They go in VM_ENV_FILE, which login shells read (the browser terminals, the agent).
        Terminals opened on the desktop are not login shells and only read ~/.bashrc,
        so ~/.bashrc gets a line that reads the file too (once).
        """
        env = dict(self.global_env)
        for key, value in self.env.items():
            if value or key not in env:
                env[key] = value
        lines = ["# Set in Settings (all VMs) and the VM's Settings tab. Rewritten whenever they change."]
        for key, value in env.items():
            lines.append(f"export {key}={shlex.quote(value)}")
        try:
            self.vm.write_file(VM_ENV_FILE, "\n".join(lines) + "\n")
        except Exception as error:
            raise VMsError(str(error))
        line = f"[ -f {VM_ENV_FILE} ] && . {VM_ENV_FILE}  # sandbox environment variables"
        self.secrets_in_vm = [key for key, value in env.items() if value]
        self.save()
        result = self.vm.exec(f"grep -qxF {shlex.quote(line)} ~/.bashrc || echo {shlex.quote(line)} >> ~/.bashrc", timeout=30)
        if result.returncode != 0:
            raise VMsError(f"Could not add the variables to ~/.bashrc: {result.stderr.strip()}")

    def set_autostart(self, enabled: bool) -> None:
        """Start the VM when this computer starts."""
        try:
            self.vm.set_config("boot.autostart", "true" if enabled else "false")
        except Exception as error:
            raise VMsError(str(error))
        self.autostart = enabled
        self.save()

    def set_resources(self, cpus: int, memory_gb: int) -> None:
        """Change CPU and memory. Only while the VM is off; they apply when it starts."""
        if cpus not in CPUS_ALLOWED:
            raise VMsError(f"cpus must be one of {CPUS_ALLOWED}")
        if memory_gb not in MEMORY_GB_ALLOWED:
            raise VMsError(f"memory_gb must be one of {MEMORY_GB_ALLOWED}")
        if not self.lock.acquire(blocking=False):
            raise VMsError(f"{self.name} is busy")
        try:
            if self.vm.status() == "Running":
                raise VMsError("Stop the VM first; CPU and memory change while it is off.")
            self.vm.set_config("limits.cpu", str(cpus))
            self.vm.set_config("limits.memory", f"{memory_gb}GiB")
            self.cpus = cpus
            self.memory_gb = memory_gb
            self.save()
        except VMsError:
            raise
        except Exception as error:
            raise VMsError(str(error))
        finally:
            self.lock.release()


class VMs:
    def __init__(self):
        self.records: dict[str, VMRecord] = {}
        self.lock = threading.Lock()  # Guards self.records and self.version.
        self.version = 0
        # One change to the env variables for all VMs at a time, so an agent adding an empty one never
        # writes back an older copy over a value the user just saved. Reentrant: the agents' changes call set_global_env.
        self.global_env_lock = threading.RLock()
        if GLOBAL_ENV_PATH.exists():
            VMRecord.global_env = json.loads(GLOBAL_ENV_PATH.read_text())
        for path in sorted(VMS_DIR.glob("*.json")):
            record = VMRecord(json.loads(path.read_text()), self.changed)
            record.refresh()
            self.records[record.name] = record
            threading.Thread(target=self.watch, args=(record,), daemon=True).start()
        self.find_orphans()
        threading.Thread(target=self.scan, daemon=True).start()

    def changed(self) -> None:
        """Something about the VMs changed: the live feed sends the list again."""
        with self.lock:
            self.version += 1

    def scan(self) -> None:
        """Look for our Incus VMs without a record every SCAN_SECONDS, for as long as the backend runs."""
        while True:
            time.sleep(SCAN_SECONDS)
            try:
                self.find_orphans()
            except Exception:
                pass

    def find_orphans(self) -> None:
        """Give every Incus VM named <VM_PREFIX><name> that has no record a new one, so it shows up.

        What Incus knows comes back (CPUs, memory, disk, internet, autostart, when it was made).
        The env variables are lost; nobody holds or waits for it.
        """
        result = subprocess.run(
            ["incus", "list", "--format", "csv", "--columns", "n"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
            check=True,
        )
        for incus_name in result.stdout.split():
            if not incus_name.startswith(VM_PREFIX) or incus_name == BUILD_VM:
                continue
            name = incus_name[len(VM_PREFIX):]
            with self.lock:
                taken = name in self.records
                for record in self.records.values():
                    if record.incus_name == incus_name:
                        taken = True
            if taken:
                continue
            result = subprocess.run(
                ["incus", "query", f"/1.0/instances/{incus_name}"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                text=True,
            )
            if result.returncode != 0:
                continue  # Deleted in the meantime.
            instance = json.loads(result.stdout)
            config = instance["config"]
            memory = config.get("limits.memory", "")
            disk = instance["expanded_devices"].get("root", {}).get("size", "")
            record = VMRecord(
                {
                    "name": name,
                    "incus_name": incus_name,
                    "cpus": int(config.get("limits.cpu", CPUS_DEFAULT)),
                    "memory_gb": int(memory.removesuffix("GiB")) if memory.endswith("GiB") else MEMORY_GB_DEFAULT,
                    "disk_gb": int(disk.removesuffix("GiB")) if disk.endswith("GiB") else DISK_GB_DEFAULT,
                    # The offline ACL sits on the VM's own eth0 card (see VM.set_internet).
                    "internet": "security.acls" not in instance["devices"].get("eth0", {}),
                    "env": {},
                    "autostart": config.get("boot.autostart") == "true",
                    "status": "stopped",
                    "created_at": instance["created_at"],
                    "holder": None,
                    "queue": [],
                },
                self.changed,
            )
            with self.lock:
                self.records[name] = record
            record.refresh()
            threading.Thread(target=self.watch, args=(record,), daemon=True).start()

    def watch(self, record: VMRecord) -> None:
        """Keep record.usage and record.samples fresh, about once a second, until the VM is deleted.

        One thread per VM, so a slow VM never holds up the others.
        """
        while not record.deleted:
            try:
                usage = record.read_usage()
                changed = usage != record.usage
                record.usage = usage
                if usage["on"]:
                    sample = {
                        "cpu_percent": usage["cpu_percent"],
                        "memory_used_gb": usage["memory_used_gb"],
                        "net_down_rate": usage["net_down_rate"],
                        "net_up_rate": usage["net_up_rate"],
                    }
                    # A new list each time, so a reader never sees one half changed.
                    record.samples = record.samples[-(SAMPLES_KEPT - 1):] + [sample]
                    changed = True
                elif record.samples:
                    record.samples = []
                    changed = True
                # Shut down from inside (the desktop's power menu, `sudo poweroff`): say so,
                # so the UI offers Start instead of waiting for a desktop that isn't coming.
                if not usage["on"] and record.status == "running" and not record.lock.locked():
                    record.status = "stopped"
                    record.save()
                # Started from outside (Incus autostart after the backend came up, `incus start`).
                if usage["on"] and record.status == "stopped" and not record.lock.locked():
                    record.status = "running"
                    record.save()
                if changed:
                    self.changed()
            except Exception:
                pass  # Incus hiccup; try again next round.
            time.sleep(1)

    def options(self) -> dict:
        """What the create dialog may offer, and what it starts with."""
        number = 1
        with self.lock:
            while f"vm{number}" in self.records:
                number += 1
        return {
            "cpus": CPUS_ALLOWED,
            "cpus_default": CPUS_DEFAULT,
            "memory_gb": MEMORY_GB_ALLOWED,
            "memory_gb_default": MEMORY_GB_DEFAULT,
            "disk_gb_min": DISK_GB_MIN,
            "disk_gb_max": DISK_GB_MAX,
            "disk_gb_default": DISK_GB_DEFAULT,
            "next_name": f"vm{number}",
        }

    def list(self) -> list[VMRecord]:
        with self.lock:
            records = list(self.records.values())
        return sorted(records, key=lambda record: record.created_at)

    def set_global_env(self, env: dict[str, str]) -> list[str]:
        """The env variables for all VMs (the Settings dialog). Running VMs get them now, the others when they start.

        Gives back the running VMs they could not be written to, each with why; the others got them.
        """
        for key in env:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise VMsError(f"Not a valid variable name: {key}")
        with self.global_env_lock:
            GLOBAL_ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
            # Write, then rename: a crash never leaves half a file.
            temporary = GLOBAL_ENV_PATH.parent / "global_env.json.tmp"
            temporary.write_text(json.dumps(env, indent=2))
            temporary.replace(GLOBAL_ENV_PATH)
            VMRecord.global_env = dict(env)
        # Not under the lock: write_env always writes what global_env is at that moment.
        with self.lock:
            records = list(self.records.values())
        failed = []
        for record in records:
            # One that is starting writes them itself once it is up.
            if record.status != "running":
                continue
            try:
                record.write_env()
            except Exception as error:
                failed.append(f"{record.name}: {error}")
        return failed

    def add_empty_global_env(self, name: str) -> None:
        """An agent asks for a secret for all VMs: a new, empty variable for the user to fill in. Agents can never set a value."""
        with self.global_env_lock:
            if name in VMRecord.global_env:
                raise VMsError(f"{name} already exists, for all VMs")
            env = dict(VMRecord.global_env)
            env[name] = ""
            self.set_global_env(env)

    def remove_empty_global_env(self, name: str) -> None:
        """An agent takes back an empty variable for all VMs. One with a value only the user can remove."""
        with self.global_env_lock:
            if name not in VMRecord.global_env:
                raise VMsError(f"There is no {name} for all VMs")
            if VMRecord.global_env[name] != "":
                raise VMsError(f"{name} has a value; only the user can remove it")
            env = dict(VMRecord.global_env)
            del env[name]
            self.set_global_env(env)

    def get(self, name: str) -> VMRecord:
        with self.lock:
            record = self.records.get(name)
        if record is None:
            raise VMsError(f"There is no VM {name}")
        return record

    def create(self, name: str, image: str, cpus: int, memory_gb: int, disk_gb: int) -> VMRecord:
        """Make a VM from an image (its name). Returns at once with status "creating"; launching takes about a minute in a thread."""
        if not re.fullmatch(NAME_PATTERN, name):
            raise VMsError("The name must start with a letter and have only a-z, 0-9 and -, at most 31 characters")
        if cpus not in CPUS_ALLOWED:
            raise VMsError(f"cpus must be one of {CPUS_ALLOWED}")
        if memory_gb not in MEMORY_GB_ALLOWED:
            raise VMsError(f"memory_gb must be one of {MEMORY_GB_ALLOWED}")
        if disk_gb < DISK_GB_MIN or disk_gb > DISK_GB_MAX:
            raise VMsError(f"The disk must be {DISK_GB_MIN} to {DISK_GB_MAX} GB")

        with self.lock:
            if name in self.records:
                raise VMsError(f"There is already a VM named {name}")
            # Keep MIN_FREE_RAM_GB free for this machine. VMs still being created haven't
            # taken their memory yet, so count it here.
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            for other in self.records.values():
                if other.status == "creating":
                    free_gb -= other.memory_gb
            if free_gb - memory_gb < MIN_FREE_RAM_GB:
                raise VMsError(
                    f"Not enough free memory: {max(free_gb, 0):.1f}GB free, the VM needs {memory_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )
            # A renamed VM keeps its Incus name, so this one may be taken.
            incus_name = VM_PREFIX + name
            number = 2
            while any(other.incus_name == incus_name for other in self.records.values()):
                incus_name = f"{VM_PREFIX}{name}-{number}"
                number += 1
            record = VMRecord(
                {
                    "name": name,
                    "incus_name": incus_name,
                    "image": image,
                    "image_fingerprint": "",
                    "cpus": cpus,
                    "memory_gb": memory_gb,
                    "disk_gb": disk_gb,
                    "internet": True,
                    "env": {},
                    "secrets_in_vm": [],
                    "autostart": False,
                    "status": "creating",
                    "created_at": datetime.now(UTC).isoformat(),
                    "holder": None,
                    "queue": [],
                },
                self.changed,
            )
            self.records[name] = record
        record.save()
        threading.Thread(target=self.watch, args=(record,), daemon=True).start()
        threading.Thread(target=record.launch, daemon=True).start()
        return record

    def fork(self, source_name: str, name: str) -> VMRecord:
        """Copy a stopped VM into a new one: its disk (everything installed and cloned in it), CPU, memory, disk size,
        internet setting and env variables. Returns at once with status "creating"; the copy starts by itself."""
        if not re.fullmatch(NAME_PATTERN, name):
            raise VMsError("The name must start with a letter and have only a-z, 0-9 and -, at most 31 characters")
        source = self.get(source_name)
        if source.status != "stopped" or source.vm.status() != "Stopped":
            raise VMsError(f"Stop {source_name} first: only a stopped VM can be forked.")
        with self.lock:
            if name in self.records:
                raise VMsError(f"There is already a VM named {name}")
            free_gb = int(Path("/proc/meminfo").read_text().split("MemAvailable:")[1].split()[0]) / 1024 / 1024
            for other in self.records.values():
                if other.status == "creating":
                    free_gb -= other.memory_gb
            if free_gb - source.memory_gb < MIN_FREE_RAM_GB:
                raise VMsError(
                    f"Not enough free memory: {max(free_gb, 0):.1f}GB free, the fork needs {source.memory_gb}GB "
                    f"and {MIN_FREE_RAM_GB}GB must stay free"
                )
            # Held until the copy is made, so nobody starts the source meanwhile (fork_from releases it).
            if not source.lock.acquire(blocking=False):
                raise VMsError(f"{source_name} is busy")
            # A renamed VM keeps its Incus name, so this one may be taken.
            incus_name = VM_PREFIX + name
            number = 2
            while any(other.incus_name == incus_name for other in self.records.values()):
                incus_name = f"{VM_PREFIX}{name}-{number}"
                number += 1
            record = VMRecord(
                {
                    "name": name,
                    "incus_name": incus_name,
                    "image": source.image,
                    "image_fingerprint": source.image_fingerprint,
                    "cpus": source.cpus,
                    "memory_gb": source.memory_gb,
                    "disk_gb": source.disk_gb,
                    "internet": source.internet,
                    "env": dict(source.env),
                    "secrets_in_vm": list(source.secrets_in_vm),
                    "autostart": False,
                    "status": "creating",
                    "created_at": datetime.now(UTC).isoformat(),
                    "forked_from": source_name,
                    "holder": None,
                    "queue": [],
                    # Its disk is a copy, so what was set up in the source is set up in it too.
                    "notes": list(source.notes),
                },
                self.changed,
            )
            self.records[name] = record
        record.save()
        threading.Thread(target=self.watch, args=(record,), daemon=True).start()
        threading.Thread(target=record.fork_from, args=(source,), daemon=True).start()
        return record

    def start_in_background(self, name: str) -> None:
        """Start a stopped VM (takes a while); the list shows "starting" until it is up."""
        record = self.get(name)
        if record.lock.locked():
            raise VMsError(f"{name} is busy")
        threading.Thread(target=record.start, daemon=True).start()

    def stop_in_background(self, name: str) -> None:
        """Shut a VM down (up to a minute); the list shows "stopping" until it is off."""
        record = self.get(name)
        if record.lock.locked():
            raise VMsError(f"{name} is busy")
        threading.Thread(target=record.stop, daemon=True).start()

    def restart_in_background(self, name: str) -> None:
        record = self.get(name)
        if record.lock.locked():
            raise VMsError(f"{name} is busy")
        threading.Thread(target=record.restart, daemon=True).start()

    def rename(self, name: str, new_name: str) -> VMRecord:
        """Give a VM another name, running or not. Only the record changes; the Incus VM keeps its name.
        VMs forked from it name the new one as their source. Agents and jobs are not changed here."""
        if not re.fullmatch(NAME_PATTERN, new_name):
            raise VMsError("The name must start with a letter and have only a-z, 0-9 and -, at most 31 characters")
        record = self.get(name)
        if new_name == name:
            return record
        if not record.lock.acquire(blocking=False):
            raise VMsError(f"{name} is busy")
        try:
            # Both locks: no save writes the old file meanwhile, and nobody finds the VM under neither name.
            with record.save_lock:
                with self.lock:
                    if new_name in self.records:
                        raise VMsError(f"There is already a VM named {new_name}")
                    del self.records[name]
                    record.name = new_name
                    self.records[new_name] = record
                # Write, then rename: a crash never leaves half a record.
                temporary = VMS_DIR / f"{new_name}.json.tmp"
                temporary.write_text(json.dumps(record.to_dict(), indent=2))
                temporary.replace(VMS_DIR / f"{new_name}.json")
                (VMS_DIR / f"{name}.json").unlink(missing_ok=True)
        finally:
            record.lock.release()
        for other in self.list():
            if other.forked_from == name:
                other.forked_from = new_name
                other.save()
        self.changed()
        return record

    def delete(self, name: str) -> None:
        """Delete the Incus VM and its record. Agents holding or waiting for it are not told here."""
        record = self.get(name)
        if not record.lock.acquire(blocking=False):
            raise VMsError(f"{name} is busy")
        try:
            try:
                record.vm.delete()
            except Exception as error:
                raise VMsError(str(error))
            with record.save_lock:
                record.deleted = True
                (VMS_DIR / f"{name}.json").unlink(missing_ok=True)
            with self.lock:
                self.records.pop(name, None)
        finally:
            record.lock.release()
        self.changed()

    def summary(self, record: VMRecord) -> dict:
        """The VM for the live feed: the record without env values (names only), plus usage."""
        data = record.to_dict()
        data["env_names"] = list(data["env"])
        del data["env"]
        data["usage"] = record.usage
        data["samples"] = record.samples
        data["locked_by"] = record.locked_by
        data["error"] = record.error
        return data
