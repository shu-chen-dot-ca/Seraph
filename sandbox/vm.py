"""One Incus VM. Knows nothing about sessions or agents.

Every call runs the `incus` command line. Commands inside the VM run as the
desktop user (uid 1000) with the image's environment (/etc/environment).
The VM's address comes from the host's DHCP leases, never from what the VM
itself reports.
"""

import json
import os
import shlex
import subprocess
import time
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

NETWORK = os.environ["SANDBOX_NETWORK"]
NOVNC_PORT = int(os.environ["SANDBOX_VM_NOVNC_PORT"])


class VMError(Exception):
    pass


class VM:
    def __init__(self, name: str):
        self.name = name

    def status(self) -> str | None:
        """"Running", "Stopped", ... or None if the VM doesn't exist."""
        result = subprocess.run(
            ["incus", "query", f"/1.0/instances/{self.name}"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)["status"]

    def launch(self, image: str, profile: str, cpus: str, memory_gb: int, disk: str) -> None:
        result = subprocess.run(
            [
                "incus", "launch", image, self.name, "--vm",
                "--profile", profile,
                "--config", f"limits.cpu={cpus}",
                "--config", f"limits.memory={memory_gb}GiB",
                "--device", f"root,size={disk}",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise VMError(f"Could not launch {self.name}: {result.stderr.strip()}")

    def start(self) -> None:
        if self.status() == "Running":
            return
        result = subprocess.run(["incus", "start", self.name], capture_output=True, text=True)
        if result.returncode != 0:
            raise VMError(f"Could not start {self.name}: {result.stderr.strip()}")

    def stop(self) -> None:
        if self.status() != "Running":
            return
        # Ask the VM to shut down; force it off if it takes too long.
        result = subprocess.run(["incus", "stop", self.name, "--timeout", "60"], capture_output=True)
        if result.returncode != 0:
            subprocess.run(["incus", "stop", self.name, "--force"], capture_output=True)
        if self.status() == "Running":
            raise VMError(f"Could not stop {self.name}")

    def delete(self) -> None:
        subprocess.run(["incus", "delete", "--force", self.name], capture_output=True)
        if self.status() is not None:
            raise VMError(f"Could not delete {self.name}")

    def address(self) -> str | None:
        """The VM's IPv4 address from the host's DHCP leases, matched by its MAC."""
        result = subprocess.run(
            ["incus", "config", "get", self.name, "volatile.eth0.hwaddr"],
            capture_output=True,
            text=True,
        )
        mac = result.stdout.strip()
        if not mac:
            return None
        result = subprocess.run(
            ["incus", "network", "list-leases", NETWORK, "--format", "json"],
            capture_output=True,
            text=True,
            check=True,
        )
        for lease in json.loads(result.stdout):
            if lease["hwaddr"] == mac and ":" not in lease["address"]:
                return lease["address"]
        return None

    def exec(self, command: str, timeout: float = 600) -> subprocess.CompletedProcess:
        """Run a shell command as the desktop user, in their home, with the image's PATH."""
        script = f"set -a; . /etc/environment; set +a; {command}"
        # runuser -l: a login shell in the user's home. The user is whoever has uid 1000.
        as_user = f'exec runuser -l "$(id -nu 1000)" -c {shlex.quote(script)}'
        return subprocess.run(
            ["incus", "exec", self.name, "--", "bash", "-c", as_user],
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def wait_ready(self, timeout: float = 300) -> None:
        """Wait until commands work, the VM has an address and noVNC answers."""
        deadline = time.monotonic() + timeout

        while True:
            result = subprocess.run(["incus", "exec", self.name, "--", "true"], capture_output=True)
            if result.returncode == 0:
                break
            if time.monotonic() > deadline:
                raise VMError(f"{self.name}: the VM agent did not come up")
            time.sleep(2)

        while True:
            address = self.address()
            if address:
                try:
                    urllib.request.urlopen(f"http://{address}:{NOVNC_PORT}/", timeout=3)
                    return
                except OSError:
                    pass
            if time.monotonic() > deadline:
                raise VMError(f"{self.name}: noVNC did not answer on port {NOVNC_PORT}")
            time.sleep(2)

    def clone(self, repo_url: str, folder: str) -> None:
        """Clone a public repo into ~/<folder> of the desktop user."""
        result = self.exec(f"git clone {shlex.quote(repo_url)} {shlex.quote(folder)}")
        if result.returncode != 0:
            raise VMError(f"Could not clone {repo_url}: {result.stderr.strip()}")
