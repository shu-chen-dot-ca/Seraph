"""How an image is made from its image.yaml: the same mechanical steps every time, from official sources only.

An image is defined by one file, image.yaml (see images.py), for example:

    system: ubuntu-24.04        # one of SYSTEMS
    desktop: gnome              # gnome, kde or none (terminal only); not every system has every desktop
    defaults: true              # the defaults go under it (left out: true); false leaves them out
    packages: [git, ripgrep]    # the system's own packages (apt on Ubuntu and Debian, dnf on Fedora)
    python:                     # Python, uv and the shared venv SANDBOX_VM_PY_VENV
      packages: [pydantic]
    node:                       # Node.js from nodejs.org, its major version (SANDBOX_VM_NODE_MAJOR when nobody says)
      version: 24
      packages: [pnpm, yarn]    # global npm packages
    docker:                     # Docker with Compose, from Docker's own repository
      images: [postgres:17]     # pulled into the image
    steps:                      # anything the lists can't say: bash run as root, in order
      - name: VS Code
        run: |
          ...

The defaults (DEFAULTS_FILE, edited in the Defaults tab; it starts as DEFAULTS_TEMPLATE) have the same keys without
system, desktop and defaults, and packages may be split into apt: and dnf: lists. combine() puts them under an image:
lists get the defaults' items first, then the image's; default steps run first, and an image step with a default
step's name takes its place. Everything the app needs (the desktop, Firefox, VNC, noVNC, ttyd, the desktop user,
the demo service) is in neither: sandbox/image/base_layer.sh puts that in every image first.

A build runs in three stages, in the image's builder VM (BUILDER_PREFIX + its name), which stays, stopped, between
builds and keeps a snapshot after each of the first two stages:

    1. base      a fresh VM from the official image (SYSTEMS' sources), then base_layer.sh     snapshot a-<key>
    2. middle    packages, the runtimes (Python, Node.js, Docker), then each step              snapshot b-<key>
    3. lists     Docker images, npm packages, Python packages

then a reboot and check (everything the app needs comes up by itself), clean up, and `incus publish`, replacing the
image of that name. A key is a hash of everything its stage and the ones before it run, so a build starts from the
latest snapshot that still matches: a changed list only runs stage 3, a changed package or step stages 2 and 3, a
changed system or desktop everything. The builder VM only has the snapshots of the image's current build.
What a build was made from is kept in BUILT_DIR: <fingerprint>.yaml (its image.yaml) and <fingerprint>.defaults.yaml
(the defaults, when it had them), so a VM's image_fingerprint says exactly what it was made from, also after its
image is rebuilt or the defaults change.

Builds run as their own process (so a backend restart doesn't stop them), as a task of images.py:

    python -m sandbox.image_build <image name> <image folder>

It prints each step for the task's log, and stops the builder VM at the end, also when it fails or is stopped.
"""

import hashlib
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import yaml
from dotenv import load_dotenv

from sandbox.agent.computer_use import Computer
from sandbox.vm import NO_DESKTOP_FILE, VM, VMError

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

BASE_LAYER = PROJECT_ROOT / "sandbox" / "image" / "base_layer.sh"
BUILT_DIR = PROJECT_ROOT / os.environ["DATA_DIR"] / "images" / "built"
DEFAULTS_FILE = PROJECT_ROOT / os.environ["DATA_DIR"] / "images" / "defaults.yaml"
# What the defaults are until the user changes them.
DEFAULTS_TEMPLATE = PROJECT_ROOT / "sandbox" / "image" / "defaults.yaml"
# The builder VM of image <name> is BUILDER_PREFIX + name. Not named like the app's VMs (SANDBOX_VM_PREFIX), so the
# VM list never picks it up.
BUILDER_PREFIX = "image-build-"

# What image.yaml may say. A system's sources are the official images (Incus's image server) each desktop starts
# from: Ubuntu has a desktop image with GNOME. A desktop missing from sources has no X11 session on that system
# (GNOME 49 and later dropped it), and the agents need X11.
DESKTOPS = {"gnome": "GNOME", "kde": "KDE Plasma", "none": "None (terminal only)"}
SYSTEMS = [
    {"id": "ubuntu-24.04", "label": "Ubuntu 24.04 LTS", "family": "apt", "sources": {"gnome": "ubuntu/noble/desktop", "kde": "ubuntu/noble", "none": "ubuntu/noble"}},
    {"id": "ubuntu-26.04", "label": "Ubuntu 26.04 LTS", "family": "apt", "sources": {"kde": "ubuntu/26.04", "none": "ubuntu/26.04"}},
    {"id": "ubuntu-22.04", "label": "Ubuntu 22.04 LTS", "family": "apt", "sources": {"gnome": "ubuntu/jammy/desktop", "kde": "ubuntu/jammy", "none": "ubuntu/jammy"}},
    {"id": "fedora-44", "label": "Fedora 44", "family": "dnf", "sources": {"kde": "fedora/44", "none": "fedora/44"}},
    {"id": "fedora-43", "label": "Fedora 43", "family": "dnf", "sources": {"kde": "fedora/43", "none": "fedora/43"}},
    {"id": "debian-13", "label": "Debian 13", "family": "apt", "sources": {"gnome": "debian/13", "kde": "debian/13", "none": "debian/13"}},
    {"id": "debian-12", "label": "Debian 12", "family": "apt", "sources": {"gnome": "debian/12", "kde": "debian/12", "none": "debian/12"}},
]
KEYS = ["system", "desktop", "defaults", "packages", "python", "node", "docker", "steps"]
# The defaults have the same keys, without the ones only an image has.
DEFAULTS_KEYS = ["packages", "python", "node", "docker", "steps"]
NODE_MAJOR = int(os.environ["SANDBOX_VM_NODE_MAJOR"])
# The builder VM.
PROFILE = os.environ["SANDBOX_PROFILE"]
BUILD_CPUS = os.environ["SANDBOX_BUILD_CPUS"]
BUILD_MEMORY = os.environ["SANDBOX_BUILD_MEMORY"]
BUILD_DISK = os.environ["SANDBOX_BUILD_DISK"]
# What every stage's scripts get in their environment, so they use the app's ports and paths instead of writing them out.
SCRIPT_SETTINGS = [
    "SANDBOX_VM_FALLBACK_USER",
    "SANDBOX_VM_VNC_PORT",
    "SANDBOX_VM_NOVNC_PORT",
    "SANDBOX_VM_TERMINAL_PORT",
    "SANDBOX_VM_DEMO_DIR",
    "SANDBOX_VM_PY_VENV",
    "SANDBOX_VM_PLAYWRIGHT_DIR",
    "SANDBOX_VM_RUST_DIR",
]
VNC_PORT = os.environ["SANDBOX_VM_VNC_PORT"]
NOVNC_PORT = os.environ["SANDBOX_VM_NOVNC_PORT"]
TERMINAL_PORT = os.environ["SANDBOX_VM_TERMINAL_PORT"]
DEMO_DIR = os.environ["SANDBOX_VM_DEMO_DIR"]
PY_VENV = os.environ["SANDBOX_VM_PY_VENV"]
# Each script (the base layer, a step, a list) may run this long. Builds are meant to take minutes, not hours.
SCRIPT_TIMEOUT = 1800
# Every script starts with this: stop at the first error, and show each command in the log.
SCRIPT_HEADER = "set -euxo pipefail\nexport DEBIAN_FRONTEND=noninteractive\n"

# What the app needs in every image, tested inside the VM as root. Each line says OK or FAIL.
CHECK_SCRIPT = f"""
desktop_tools="xdotool scrot x11vnc websockify"
if [ -f {NO_DESKTOP_FILE} ]; then
    echo "OK terminal only ({NO_DESKTOP_FILE}): no desktop checks"
    desktop_tools=""
fi
user=$(id -nu 1000 2>/dev/null)
if [ -n "$user" ]; then echo "OK desktop user $user (uid 1000)"; else echo "FAIL no user with uid 1000"; fi
if [ -n "$user" ] && runuser -u "$user" -- sudo -n true 2>/dev/null; then echo "OK passwordless sudo"; else echo "FAIL the desktop user has no passwordless sudo"; fi
if [ -f /etc/environment ]; then echo "OK /etc/environment"; else echo "FAIL no /etc/environment"; fi
for tool in $desktop_tools ttyd tmux python3 iptables curl git ss; do
    if command -v "$tool" > /dev/null; then echo "OK $tool"; else echo "FAIL $tool is missing"; fi
done
if [ -x /usr/local/bin/sandbox-terminal ]; then echo "OK /usr/local/bin/sandbox-terminal"; else echo "FAIL no /usr/local/bin/sandbox-terminal"; fi
if [ -x {DEMO_DIR}/run.sh ] && systemctl cat demo.service > /dev/null 2>&1; then echo "OK demo service"; else echo "FAIL no {DEMO_DIR}/run.sh or no demo.service"; fi
if [ -n "$desktop_tools" ]; then
    if ss -ltn | grep -q ':{VNC_PORT} '; then echo "OK VNC server on port {VNC_PORT}"; else echo "FAIL nothing listens on port {VNC_PORT} (x11vnc in the desktop session)"; fi
fi
if [ "$(systemctl is-enabled fwupd.service 2>/dev/null)" = masked ] || ! systemctl cat fwupd.service > /dev/null 2>&1; then echo "OK fwupd off"; else echo "FAIL fwupd is not masked"; fi
disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE / | sed 's/\\[.*//')" 2>/dev/null | head -1)
if [ -n "$disk" ]; then
    if [ "$(df -B1 --output=size / | tail -1)" -gt $(( $(lsblk -bndo SIZE "/dev/$disk") * 8 / 10 )) ]; then
        echo "OK the root filesystem fills the disk"
    else
        echo "FAIL the root filesystem doesn't fill the disk (VMs get bigger disks than the image: grow it at boot)"
    fi
fi
if grep -q clearcpuid=user_shstk /proc/cmdline; then
    echo "OK clearcpuid=user_shstk"
elif grep -rqs clearcpuid=user_shstk /etc/default/grub /etc/default/grub.d /boot/loader/entries /etc/kernel/cmdline; then
    echo "OK clearcpuid=user_shstk is set for the next boot"
else
    echo "FAIL the kernel argument clearcpuid=user_shstk is not set"
fi
"""

# Run as root right before publishing: nothing of the build that a VM made from the image doesn't need.
# Each VM gets its own machine-id on first boot, so copies don't look like the same machine on the network (DHCP).
CLEANUP_SCRIPT = """
if command -v apt-get > /dev/null; then apt-get clean; fi
if command -v dnf > /dev/null; then dnf clean all > /dev/null; fi
rm -rf /tmp/* /var/tmp/* /root/build-step.sh /root/.cache
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
fstrim -av > /dev/null 2>&1 || true
"""


class DefinitionError(ValueError):
    pass


class LiteralDumper(yaml.SafeDumper):
    """Writes text with line breaks (a step's run) as a | block, the way a person writes it."""


LiteralDumper.add_representer(str, lambda dumper, value: dumper.represent_scalar("tag:yaml.org,2002:str", value, style="|" if "\n" in value else None))


def read_defaults() -> str:
    """The defaults as they are now: DEFAULTS_FILE, or DEFAULTS_TEMPLATE until the user changed them."""
    if DEFAULTS_FILE.exists():
        return DEFAULTS_FILE.read_text()
    return DEFAULTS_TEMPLATE.read_text()


def parse_definition(text: str, defaults: bool = False) -> dict:
    """Check image.yaml (or, with defaults=True, the defaults: the same without system, desktop and defaults) and give
    it back complete:

        {"system", "desktop" (None for the defaults), "defaults" (whether the defaults go under it),
         "packages": {"apt": [...], "dnf": [...]}, "python": {"in", "packages"},
         "node": {"in", "version" (None when it doesn't say), "packages"}, "docker": {"in", "images"},
         "steps": [{"name", "run"}]}

    "in": the key is there, even with nothing under it ("python:" still means Python is in).
    Raises DefinitionError saying what is wrong."""
    file = "The defaults" if defaults else "image.yaml"
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise DefinitionError(f"{file} isn't valid YAML: {error}")
    # Empty defaults: no defaults.
    if defaults and data is None:
        data = {}
    if not isinstance(data, dict):
        raise DefinitionError(f"{file} must be a mapping of keys: {', '.join(DEFAULTS_KEYS if defaults else KEYS)}")
    keys = DEFAULTS_KEYS if defaults else KEYS
    unknown = [str(key) for key in data if key not in keys]
    if unknown:
        raise DefinitionError(f"{file} can't have {', '.join(unknown)}; it may only have {', '.join(keys)}")
    systems = [system for system in SYSTEMS if system["id"] == data.get("system")]
    if not defaults and not systems:
        raise DefinitionError(f"system must be one of {', '.join(system['id'] for system in SYSTEMS)}")
    if not defaults and data.get("desktop") not in DESKTOPS:
        raise DefinitionError(f"desktop must be one of {', '.join(DESKTOPS)}")
    if not defaults and data["desktop"] not in systems[0]["sources"]:
        offered = ", ".join(systems[0]["sources"])
        raise DefinitionError(f"{systems[0]['label']}'s {DESKTOPS[data['desktop']]} has no X11 session, which the agents need. It offers: {offered}")
    use_defaults = data.get("defaults", True)
    if not isinstance(use_defaults, bool):
        raise DefinitionError("defaults must be true or false: whether the defaults (the Defaults tab) go under this image")

    python = data["python"] if data.get("python") is not None else {}
    node = data["node"] if data.get("node") is not None else {}
    docker = data["docker"] if data.get("docker") is not None else {}
    if not isinstance(python, dict) or [key for key in python if key != "packages"]:
        raise DefinitionError("python may only have packages: a list")
    if not isinstance(node, dict) or [key for key in node if key not in ["version", "packages"]]:
        raise DefinitionError("node may only have version: (a major version, like 24) and packages: a list")
    if not isinstance(docker, dict) or [key for key in docker if key != "images"]:
        raise DefinitionError("docker may only have images: a list")
    packages = data.get("packages") or []
    if isinstance(packages, dict) and [key for key in packages if key not in ["apt", "dnf"]]:
        raise DefinitionError("packages is one list, or split into apt: and dnf: lists")
    apt = (packages.get("apt") or []) if isinstance(packages, dict) else packages
    dnf = (packages.get("dnf") or []) if isinstance(packages, dict) else packages
    lists = {
        "packages": apt,
        "packages for dnf": dnf,
        "python packages": python.get("packages") or [],
        "node packages": node.get("packages") or [],
        "docker images": docker.get("images") or [],
    }
    for label, items in lists.items():
        if not isinstance(items, list) or not all(isinstance(item, str) and item.strip() and len(item.split()) == 1 for item in items):
            raise DefinitionError(f"{label} must be a list of names, each without spaces")
    version = node.get("version")
    if version is not None and (not isinstance(version, int) or isinstance(version, bool) or version < 1):
        raise DefinitionError("node's version must be a major version number, like 24")

    steps = data.get("steps") or []
    if not isinstance(steps, list):
        raise DefinitionError("steps must be a list of {name, run}")
    for step in steps:
        if not isinstance(step, dict) or set(step) != {"name", "run"}:
            raise DefinitionError("each step must have exactly name: and run: (bash, as root)")
        if not isinstance(step["name"], str) or not step["name"].strip() or not isinstance(step["run"], str) or not step["run"].strip():
            raise DefinitionError("each step's name and run must be text")
    names = [step["name"].strip() for step in steps]
    if len(set(names)) != len(names):
        raise DefinitionError("each step needs a name of its own")

    return {
        "system": None if defaults else systems[0]["id"],
        "desktop": None if defaults else data["desktop"],
        "defaults": use_defaults and not defaults,
        "packages": {"apt": apt, "dnf": dnf},
        "python": {"in": "python" in data, "packages": lists["python packages"]},
        "node": {"in": "node" in data, "version": version, "packages": lists["node packages"]},
        "docker": {"in": "docker" in data, "images": lists["docker images"]},
        "steps": [{"name": step["name"].strip(), "run": step["run"]} for step in steps],
    }


def combine(definition: dict, defaults: dict) -> dict:
    """The image as a build makes it: the defaults (parsed) under its image.yaml (parsed), or image.yaml alone when it
    says defaults: false. Lists have the defaults' items first, then the image's; default steps run first, and an
    image step with a default step's name takes its place. Packages are the system's own (apt or dnf). Like
    parse_definition's, with "packages" one list and node's version always a number."""
    if not definition["defaults"]:
        defaults = parse_definition("", defaults=True)
    family = [system for system in SYSTEMS if system["id"] == definition["system"]][0]["family"]
    steps = list(defaults["steps"])
    names = [step["name"] for step in steps]
    for step in definition["steps"]:
        if step["name"] in names:
            steps[names.index(step["name"])] = step
        else:
            steps.append(step)
    return {
        "system": definition["system"],
        "desktop": definition["desktop"],
        "packages": list(dict.fromkeys(defaults["packages"][family] + definition["packages"][family])),
        "python": {
            "in": defaults["python"]["in"] or definition["python"]["in"],
            "packages": list(dict.fromkeys(defaults["python"]["packages"] + definition["python"]["packages"])),
        },
        "node": {
            "in": defaults["node"]["in"] or definition["node"]["in"],
            "version": definition["node"]["version"] or defaults["node"]["version"] or NODE_MAJOR,
            "packages": list(dict.fromkeys(defaults["node"]["packages"] + definition["node"]["packages"])),
        },
        "docker": {
            "in": defaults["docker"]["in"] or definition["docker"]["in"],
            "images": list(dict.fromkeys(defaults["docker"]["images"] + definition["docker"]["images"])),
        },
        "steps": steps,
    }


def combined_yaml(combined: dict) -> str:
    """The combined image (combine()) written like an image.yaml, to show what a build makes."""
    data = {"system": combined["system"], "desktop": combined["desktop"], "packages": combined["packages"]}
    if combined["python"]["in"]:
        data["python"] = {"packages": combined["python"]["packages"]}
    if combined["node"]["in"]:
        data["node"] = {"version": combined["node"]["version"], "packages": combined["node"]["packages"]}
    if combined["docker"]["in"]:
        data["docker"] = {"images": combined["docker"]["images"]}
    data["steps"] = combined["steps"]
    return yaml.dump(data, Dumper=LiteralDumper, sort_keys=False, allow_unicode=True)


def stages(combined: dict) -> list[list[tuple[str, str]]]:
    """The three stages' scripts of a combined image (combine()), each (title, bash run as root): base, middle, lists."""
    system = [system for system in SYSTEMS if system["id"] == combined["system"]][0]
    base = [("Base layer: the desktop, Firefox and what the app needs", BASE_LAYER.read_text())]

    middle = []
    if combined["packages"] and system["family"] == "apt":
        packages = " ".join(shlex.quote(package) for package in combined["packages"])
        middle.append(("Packages", f"apt-get -y -o DPkg::Lock::Timeout=900 update\napt-get -y -o DPkg::Lock::Timeout=900 install {packages}\n"))
    if combined["packages"] and system["family"] == "dnf":
        packages = " ".join(shlex.quote(package) for package in combined["packages"])
        middle.append(("Packages", f"dnf -y install {packages}\n"))
    if combined["python"]["in"]:
        middle.append((
            "Python: uv and the shared venv",
            "# uv from its official installer; the venv everyone may write to, first on PATH (/etc/environment).\n"
            "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh\n"
            f"uv venv {shlex.quote(PY_VENV)} --python /usr/bin/python3 --seed\n"
            f"chmod -R a+rwX {shlex.quote(PY_VENV)}\n",
        ))
    if combined["node"]["in"]:
        major = combined["node"]["version"]
        middle.append((
            f"Node.js {major}",
            "# The latest release of this major version, from nodejs.org, checksum verified.\n"
            f"node_base=https://nodejs.org/dist/latest-v{major}.x\n"
            'node_file=$(curl -fsSL "$node_base/SHASUMS256.txt" | awk \'/linux-x64\\.tar\\.xz$/ {print $2}\')\n'
            'curl -fsSL "$node_base/$node_file" -o "/tmp/$node_file"\n'
            '(cd /tmp && curl -fsSL "$node_base/SHASUMS256.txt" | grep " $node_file$" | sha256sum -c -)\n'
            'tar -xJf "/tmp/$node_file" -C /usr/local --strip-components=1 --no-same-owner\n'
            'rm "/tmp/$node_file"\n',
        ))
    if combined["docker"]["in"]:
        middle.append((
            "Docker with Compose",
            "# Docker's own repository, through its official install script; the desktop user may use it without sudo.\n"
            "curl -fsSL https://get.docker.com | sh\n"
            "systemctl enable --now docker\n"
            'usermod -aG docker "$(id -nu 1000)"\n',
        ))
    for step in combined["steps"]:
        middle.append((f"Step: {step['name']}", step["run"]))

    lists = []
    if combined["docker"]["in"] and combined["docker"]["images"]:
        pulls = "".join(f"docker pull {shlex.quote(image)}\n" for image in combined["docker"]["images"])
        lists.append(("Docker images", f"systemctl start docker\n{pulls}"))
    if combined["node"]["in"] and combined["node"]["packages"]:
        packages = " ".join(shlex.quote(package) for package in combined["node"]["packages"])
        lists.append(("npm packages", f"npm install -g --no-audit --no-fund {packages}\n"))
    if combined["python"]["in"] and combined["python"]["packages"]:
        packages = " ".join(shlex.quote(package) for package in combined["python"]["packages"])
        lists.append((
            "Python packages",
            f"uv pip install --python {shlex.quote(PY_VENV + '/bin/python')} {packages}\nchmod -R a+rwX {shlex.quote(PY_VENV)}\n",
        ))
    return [base, middle, lists]


def launch(vm: VM, source: str) -> str:
    """A fresh VM from the official image source (a VM of that name goes first), with the shadow stack guard.
    Returns the system's name. Raises VMError."""
    vm.delete()
    command = [
        "incus", "launch", f"images:{source}", vm.name, "--vm", "--profile", PROFILE,
        "--config", f"limits.cpu={BUILD_CPUS}", "--config", f"limits.memory={BUILD_MEMORY}", "--device", f"root,size={BUILD_DISK}",
    ]
    result = subprocess.run(command, capture_output=True, stdin=subprocess.DEVNULL, text=True)
    if result.returncode != 0:
        raise VMError(f"Could not start a VM from images:{source}: {result.stderr.strip()}")
    responds = False
    for _ in range(150):
        responds = vm.responds()
        if responds:
            break
        time.sleep(2)
    if not responds:
        raise VMError(f"The VM from images:{source} didn't answer commands within 5 minutes")
    vm.guard_shadow_stack()
    release = vm.exec_root('. /etc/os-release && echo "$PRETTY_NAME"', 30)
    return release.stdout.strip()


def run_script(vm: VM, script: str, family: str, desktop: str) -> int:
    """Run one stage's script as root in the VM, with SCRIPT_SETTINGS (and the system's family and desktop) in its
    environment. Its output goes to this process's output (the task's log). Its exit code. Raises TimeoutExpired."""
    vm.write_file("/root/build-step.sh", SCRIPT_HEADER + script, "0755")
    settings = [f"{key}={shlex.quote(os.environ[key])}" for key in SCRIPT_SETTINGS]
    settings += [f"SANDBOX_FAMILY={family}", f"SANDBOX_DESKTOP={desktop}", f"SANDBOX_NO_DESKTOP_FILE={NO_DESKTOP_FILE}"]
    command = ["incus", "exec", vm.name, "--", "bash", "-c", f"cd /root && env {' '.join(settings)} bash /root/build-step.sh"]
    result = subprocess.run(command, stdout=sys.stdout, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=SCRIPT_TIMEOUT)
    return result.returncode


def check(vm: VM) -> tuple[bool, str]:
    """Test what the app needs in a running VM: CHECK_SCRIPT inside it, then noVNC, the terminals and the screen
    from here. Whether it all works, and a line per test."""
    result = vm.exec_root(CHECK_SCRIPT, 60)
    lines = result.stdout.strip().splitlines()
    desktop = vm.has_desktop()
    address = vm.address()
    if address is None:
        lines.append("FAIL the VM has no network address")
    if address is not None and desktop:
        try:
            urllib.request.urlopen(f"http://{address}:{NOVNC_PORT}/vnc.html", timeout=5)
            lines.append(f"OK noVNC answers on port {NOVNC_PORT}")
        except OSError as error:
            lines.append(f"FAIL noVNC doesn't answer on port {NOVNC_PORT} ({error})")
    if address is not None:
        try:
            urllib.request.urlopen(f"http://{address}:{TERMINAL_PORT}/", timeout=5)
            lines.append(f"OK the terminals (ttyd) answer on port {TERMINAL_PORT}")
        except OSError as error:
            lines.append(f"FAIL ttyd doesn't answer on port {TERMINAL_PORT} ({error})")
    # The same way the main agents reach the screen: the desktop user, X11's display from x11vnc.
    if desktop:
        try:
            width, height = Computer(vm).screen_size()
            lines.append(f"OK the agents can reach the screen ({width}x{height}, X11)")
        except Exception as error:
            lines.append(f"FAIL the agents can't reach the screen: {error}")
    works = not any(line.startswith("FAIL") for line in lines)
    return works, "\n".join(lines)


def reboot_and_check(vm: VM) -> str | None:
    """Reboot the builder VM and check that everything the app needs comes up by itself. What fails, or None."""
    try:
        vm.stop()
        vm.start()
        vm.wait_ready(300)
    except VMError as error:
        return f"After a reboot: {error}"
    works, report = check(vm)
    if not works:
        return f"After a reboot, not everything works:\n{report}"
    kernel = vm.exec_root("grep -q clearcpuid=user_shstk /proc/cmdline", 30)
    if kernel.returncode != 0:
        return "After a reboot the kernel still runs without clearcpuid=user_shstk."
    return None


def publish(vm: VM, name: str) -> str:
    """Clean up the builder VM, stop it and publish it as the image name, replacing one of that name. The VM stays
    (its snapshots are the next build's start). Returns the new image's fingerprint."""
    vm.exec_root(CLEANUP_SCRIPT, 600)
    vm.stop()
    # Uncompressed: bigger on disk, but new VMs unpack it faster.
    result = subprocess.run(
        ["incus", "publish", vm.name, "--alias", name, "--reuse", "--compression", "none"],
        capture_output=True,
        stdin=subprocess.DEVNULL,
        text=True,
    )
    if result.returncode != 0:
        raise VMError(f"Could not publish {vm.name} as {name}: {result.stderr.strip()}")
    result = subprocess.run(["incus", "query", f"/1.0/images/aliases/{name}"], capture_output=True, stdin=subprocess.DEVNULL, text=True, check=True)
    return json.loads(result.stdout)["target"]


def main() -> None:
    """Build the image from its image.yaml, step by step, for the task's log. The last line says how it ended."""
    name, folder = sys.argv[1], Path(sys.argv[2])
    sys.stdout.reconfigure(line_buffering=True)
    vm = VM(BUILDER_PREFIX + name)
    # Stopping the task sends SIGTERM: end like a failure, so the builder VM is still stopped (finally).
    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(1))
    text = (folder / "image.yaml").read_text()
    defaults_text = read_defaults()
    try:
        definition = parse_definition(text)
        combined = combine(definition, parse_definition(defaults_text, defaults=True))
    except DefinitionError as error:
        print(error)
        sys.exit(1)
    system = [system for system in SYSTEMS if system["id"] == definition["system"]][0]
    source = system["sources"][definition["desktop"]]
    scripts = stages(combined)
    settings = [os.environ[key] for key in SCRIPT_SETTINGS]
    key_a = hashlib.sha256(json.dumps([source, definition["desktop"], settings, scripts[0]]).encode()).hexdigest()[:16]
    key_b = hashlib.sha256(json.dumps([key_a, scripts[1]]).encode()).hexdigest()[:16]
    snapshot_names = [f"a-{key_a}", f"b-{key_b}", None]

    # The builder VM's snapshots, from earlier builds (none when it isn't there).
    result = subprocess.run(["incus", "query", f"/1.0/instances/{vm.name}/snapshots"], capture_output=True, stdin=subprocess.DEVNULL, text=True)
    snapshots = [url.split("/")[-1] for url in json.loads(result.stdout)] if result.returncode == 0 else []
    first = 0
    if snapshot_names[0] in snapshots:
        first = 1
    if snapshot_names[1] in snapshots:
        first = 2
    try:
        if first == 0:
            print(f"==> Starting a fresh VM from images:{source} (nothing to reuse from the last build)")
            print(launch(vm, source))
        if first > 0:
            print(f"==> Starting from the last build's snapshot after stage {first} of 3; only what changed runs again")
            vm.stop()
            subprocess.run(["incus", "snapshot", "restore", vm.name, snapshot_names[first - 1]], capture_output=True, stdin=subprocess.DEVNULL, text=True, check=True)
        # The middle snapshot is made again whenever stage 2 runs: the old one is out of date.
        for snapshot in snapshots:
            if first < 2 and snapshot.startswith("b-"):
                subprocess.run(["incus", "snapshot", "delete", vm.name, snapshot], capture_output=True, stdin=subprocess.DEVNULL, text=True, check=True)

        for index in range(first, 3):
            vm.start()
            for _ in range(150):
                if vm.responds():
                    break
                time.sleep(2)
            for title, script in scripts[index]:
                print(f"==> {title}")
                if run_script(vm, script, system["family"], definition["desktop"]) != 0:
                    print(f"{title} failed (above).")
                    sys.exit(1)
            if snapshot_names[index] is None:
                continue
            print(f"==> Keeping a snapshot of stage {index + 1}, so the next build can start from here")
            vm.stop()
            subprocess.run(["incus", "snapshot", "create", vm.name, snapshot_names[index]], capture_output=True, stdin=subprocess.DEVNULL, text=True, check=True)

        print("==> Rebooting and checking what the app needs")
        problem = reboot_and_check(vm)
        if problem is not None:
            print(problem)
            print("Not everything the app needs works (above).")
            sys.exit(1)
        print(f"==> Publishing it as {name}")
        fingerprint = publish(vm, name)
        BUILT_DIR.mkdir(parents=True, exist_ok=True)
        (BUILT_DIR / f"{fingerprint}.yaml").write_text(text)
        if definition["defaults"]:
            (BUILT_DIR / f"{fingerprint}.defaults.yaml").write_text(defaults_text)
    except subprocess.CalledProcessError as error:
        print(f"{error}\n{error.stderr}")
        sys.exit(1)
    except (VMError, subprocess.TimeoutExpired) as error:
        print(error)
        sys.exit(1)
    finally:
        try:
            vm.stop()
        except VMError:
            pass


if __name__ == "__main__":
    main()
