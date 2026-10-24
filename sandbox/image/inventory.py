"""List what a VM has: system, languages, tools, packages, ready-made Docker images, caches and models.

Runs inside a VM, as root, with only Python's standard library, and prints JSON. inspect.sh runs it in a
throwaway VM made from an image, so the list describes the image as it was made:

    incus exec <vm> -- python3 - <image name> <fingerprint> <image made at> < inventory.py

Every probe is allowed to fail (a tool that isn't there just isn't listed). Commands for the desktop
user's own things (VS Code, caches) run as that user. Everything gets the image's PATH from /etc/environment.
"""

import json
import os
import pwd
import re
import shlex
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

# Languages and tools: (name shown, command). The first version-looking word of the first line is the version.
# VS Code won't run as root, so it is asked as the desktop user (USER_PROBES).
LANGUAGES = [
    ("Python", "python3 --version"),
    ("Python venv /opt/py", "/opt/py/bin/python --version"),
    ("Node.js", "node --version"),
    ("npm", "npm --version"),
    ("pnpm", "pnpm --version"),
    ("Yarn", "yarn --version"),
    ("Rust", "rustc --version"),
    ("Cargo", "cargo --version"),
    ("Go", "go version"),
    ("Java", "java -version 2>&1"),
    ("GCC", "gcc --version"),
    ("Clang", "clang --version"),
    ("Ruby", "ruby --version"),
    ("PHP", "php --version"),
    (".NET", "dotnet --version"),
    ("Deno", "deno --version"),
    ("Bun", "bun --version"),
]
TOOLS = [
    ("git", "git --version"),
    ("Git LFS", "git lfs version"),
    ("GitHub CLI", "gh --version"),
    ("Docker", "docker --version"),
    ("Docker Compose", "docker compose version"),
    ("uv", "uv --version"),
    ("pipx", "pipx --version"),
    ("fnm", "fnm --version"),
    ("Firefox", "flatpak info org.mozilla.firefox 2>/dev/null | grep -i '^ *version:' || firefox --version"),
    ("Chromium", "chromium --version || chromium-browser --version"),
    ("Google Chrome", "google-chrome --version"),
    ("Playwright", "cd /opt/playwright && npx --no-install playwright --version"),
    ("tmux", "tmux -V"),
    ("make", "make --version"),
    ("CMake", "cmake --version"),
    ("SQLite", "sqlite3 --version"),
    ("PostgreSQL client", "psql --version"),
    ("Redis client", "redis-cli --version"),
    ("FFmpeg", "ffmpeg -version"),
    ("ImageMagick", "convert -version"),
    ("Graphviz", "dot -V 2>&1"),
    ("jq", "jq --version"),
    ("ripgrep", "rg --version"),
    ("curl", "curl --version"),
    ("Blender", "blender --version"),
]
USER_PROBES = [("VS Code", "code --version")]
# Folders in the desktop user's home whose size says what is ready offline.
CACHES = [
    ("pip cache", ".cache/pip"),
    ("uv cache", ".cache/uv"),
    ("npm cache", ".npm"),
    ("Cargo registry", ".cargo/registry"),
    ("Hugging Face", ".cache/huggingface"),
    ("Chroma", ".cache/chroma"),
    ("tiktoken", ".cache/tiktoken"),
    ("NLTK data", "nltk_data"),
    ("Playwright browsers", ".cache/ms-playwright"),
]
TIMEOUT = 60


# The image's environment (/etc/environment), which has the PATH of every tool it installed.
ENV = dict(os.environ)
for line in Path("/etc/environment").read_text().splitlines():
    if "=" in line and not line.strip().startswith("#"):
        ENV[line.split("=", 1)[0].strip()] = line.split("=", 1)[1].strip().strip('"')
USER = pwd.getpwuid(1000)
HOME = Path(USER.pw_dir)


def run(command: str, as_user: bool = False) -> str:
    """What the command printed (stdout, else stderr), or "" when it failed or isn't there."""
    if as_user:
        command = f"runuser -u {shlex.quote(USER.pw_name)} -- env HOME={shlex.quote(str(HOME))} bash -c {shlex.quote(command)}"
    try:
        result = subprocess.run(["bash", "-c", command], capture_output=True, text=True, errors="replace", env=ENV, timeout=TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip() or result.stderr.strip()


def main() -> None:
    image = {"name": sys.argv[1] if len(sys.argv) > 1 else "", "fingerprint": sys.argv[2] if len(sys.argv) > 2 else "", "created_at": sys.argv[3] if len(sys.argv) > 3 else ""}

    os_release = {}
    for line in Path("/etc/os-release").read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            os_release[key] = value.strip('"')
    desktop = "GNOME"
    for gdm in [Path("/etc/gdm3/custom.conf"), Path("/etc/gdm/custom.conf")]:
        if gdm.exists() and re.search(r"^\s*WaylandEnable\s*=\s*false", gdm.read_text(), re.MULTILINE):
            desktop = "GNOME on X11"
    # Other desktops (images the agent made): the X sessions installed.
    sessions = [path.stem for path in Path("/usr/share/xsessions").glob("*.desktop")]
    for name, session in [("XFCE", "xfce"), ("KDE Plasma", "plasma"), ("MATE", "mate"), ("Cinnamon", "cinnamon"), ("LXQt", "lxqt")]:
        if any(session in each for each in sessions):
            desktop = name
    # A terminal-only image (sandbox/vm.py's NO_DESKTOP_FILE).
    if Path("/etc/sandbox-no-desktop").exists():
        desktop = "None (terminal only)"
    disk = os.statvfs("/")
    system = {
        "os": os_release.get("PRETTY_NAME", ""),
        "kernel": run("uname -r"),
        "arch": run("uname -m"),
        "desktop": desktop,
        "user": USER.pw_name,
        "disk_used_gb": round((disk.f_blocks - disk.f_bfree) * disk.f_frsize / 1024**3, 1),
    }

    languages = []
    tools = []
    probes = [(languages, name, command, False) for name, command in LANGUAGES]
    probes += [(tools, name, command, False) for name, command in TOOLS]
    probes += [(tools, name, command, True) for name, command in USER_PROBES]
    for found, name, command, as_user in probes:
        output = run(command, as_user)
        if not output:
            continue
        first = output.splitlines()[0].strip()
        match = re.search(r"\d+(\.\d+)+", first)
        found.append({"name": name, "version": match.group(0) if match else "", "raw": first[:200]})

    packages = []
    manual = set(run("apt-mark showmanual").split())
    for line in run("dpkg-query -W -f='${binary:Package}\\t${Version}\\t${db:Status-Status}\\n'").splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or parts[2] != "installed":
            continue
        name = parts[0].split(":")[0]
        packages.append({"kind": "apt", "name": name, "version": parts[1], "manual": name in manual})
    # Fedora's packages (rpm), on images without apt (so no apt packages so far).
    if not packages:
        for line in run("rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n'").splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[0] != "gpg-pubkey":
                packages.append({"kind": "rpm", "name": parts[0], "version": parts[1]})

    pip_output = run("/opt/py/bin/python -m pip list --format json") or run("uv pip list --python /opt/py/bin/python --format json")
    if pip_output:
        for item in json.loads(pip_output):
            packages.append({"kind": "pip", "name": item["name"], "version": item["version"]})

    npm_output = run("npm ls -g --depth 0 --json")
    if npm_output:
        for name, item in json.loads(npm_output).get("dependencies", {}).items():
            packages.append({"kind": "npm", "name": name, "version": item.get("version", "")})

    for line in run("cargo install --list").splitlines():
        match = re.match(r"^(\S+) v(\S+):", line)
        if match:
            packages.append({"kind": "cargo", "name": match.group(1), "version": match.group(2)})

    for line in run("snap list").splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2:
            packages.append({"kind": "snap", "name": parts[0], "version": parts[1]})

    for line in run("flatpak list --app --columns=application,version").splitlines():
        parts = line.split("\t")
        if parts and parts[0]:
            packages.append({"kind": "flatpak", "name": parts[0], "version": parts[1] if len(parts) > 1 else ""})

    for line in run("code --list-extensions --show-versions", as_user=True).splitlines():
        if "@" in line:
            name, version = line.rsplit("@", 1)
            packages.append({"kind": "vscode", "name": name, "version": version})

    # Docker may still be starting in a VM that just booted.
    for _ in range(30):
        if run("docker info --format '{{.ServerVersion}}'"):
            break
        time.sleep(2)
    for line in run("docker images --format '{{.Repository}}:{{.Tag}}\\t{{.Size}}'").splitlines():
        parts = line.split("\t")
        if parts[0] and not parts[0].startswith("<none>"):
            packages.append({"kind": "docker", "name": parts[0], "version": parts[1] if len(parts) > 1 else ""})

    browsers = Path("/opt/playwright/browsers")
    if browsers.exists():
        for folder in sorted(browsers.iterdir()):
            if folder.is_dir() and not folder.name.startswith("."):
                packages.append({"kind": "playwright", "name": folder.name, "version": ""})

    models = []
    hub = HOME / ".cache/huggingface/hub"
    if hub.exists():
        for folder in sorted(hub.glob("models--*")):
            models.append(folder.name.removeprefix("models--").replace("--", "/"))
    for folder in sorted((HOME / "nltk_data").glob("*/*")):
        models.append(f"nltk {folder.stem}")
    for item in json.loads(pip_output or "[]"):
        if item["name"].startswith("en-core-web") or item["name"].startswith("en_core_web"):
            models.append(f"spaCy {item['name']}")

    caches = []
    for name, relative in CACHES:
        path = HOME / relative
        if not path.exists():
            continue
        size = 0
        for root, _, files in os.walk(path):
            for file in files:
                try:
                    size += (Path(root) / file).lstat().st_size
                except OSError:
                    pass
        caches.append({"name": name, "path": f"~/{relative}", "size_gb": round(size / 1024**3, 2)})

    inventory = {
        "version": 1,
        "image": image,
        "inspected_at": datetime.now(UTC).isoformat(),
        "system": system,
        "languages": languages,
        "tools": tools,
        "packages": packages,
        "models": models,
        "caches": caches,
    }
    print(json.dumps(inventory))


main()
