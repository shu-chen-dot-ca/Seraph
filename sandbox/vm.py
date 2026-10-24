"""One Incus VM. Knows nothing about records, queues or agents.

Every call runs the `incus` command line. Commands inside the VM run as the
desktop user (uid 1000) with the image's environment (/etc/environment).
The VM's address comes from the host's DHCP leases, never from what the VM
itself reports.

Every incus call gets stdin=DEVNULL: `incus exec` reads stdin, and when the
backend runs in the background of a terminal (run.sh), reading the terminal
makes the system stop the whole backend (SIGTTIN).
"""

import json
import os
import shlex
import subprocess
import time
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

NETWORK = os.environ["SANDBOX_NETWORK"]
NOVNC_PORT = int(os.environ["SANDBOX_VM_NOVNC_PORT"])
VNC_PORT = int(os.environ["SANDBOX_VM_VNC_PORT"])
TERMINAL_PORT = int(os.environ["SANDBOX_VM_TERMINAL_PORT"])
# In an image without a desktop (terminal only): no noVNC or VNC server, its terminals (ttyd) are the way in.
NO_DESKTOP_FILE = "/etc/sandbox-no-desktop"


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
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)["status"]

    def state(self) -> dict | None:
        """Live state from Incus: status, CPU time used, memory in use, ... None if the VM doesn't exist."""
        result = subprocess.run(
            ["incus", "query", f"/1.0/instances/{self.name}/state"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)

    def launch(self, image: str, profile: str, cpus: int, memory_gb: int, disk: str) -> None:
        result = subprocess.run(
            [
                "incus", "launch", image, self.name, "--vm",
                "--profile", profile,
                "--config", f"limits.cpu={cpus}",
                "--config", f"limits.memory={memory_gb}GiB",
                "--device", f"root,size={disk}",
            ],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            raise VMError(f"Could not launch {self.name}: {result.stderr.strip()}")

    def start(self) -> None:
        if self.status() == "Running":
            return
        result = subprocess.run(["incus", "start", self.name], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise VMError(f"Could not start {self.name}: {result.stderr.strip()}")

    def stop(self) -> None:
        if self.status() != "Running":
            return
        # A VM that crashed or hung can't shut itself down: force it off right away
        # instead of waiting a minute for it.
        try:
            responds = subprocess.run(["incus", "exec", self.name, "--", "true"], capture_output=True, stdin=subprocess.DEVNULL, timeout=10).returncode == 0
        except subprocess.TimeoutExpired:
            responds = False
        if not responds:
            subprocess.run(["incus", "stop", self.name, "--force"], capture_output=True, stdin=subprocess.DEVNULL)
        else:
            # Ask the VM to shut down; force it off if it takes too long.
            result = subprocess.run(["incus", "stop", self.name, "--timeout", "60"], capture_output=True, stdin=subprocess.DEVNULL)
            if result.returncode != 0:
                subprocess.run(["incus", "stop", self.name, "--force"], capture_output=True, stdin=subprocess.DEVNULL)
        if self.status() == "Running":
            raise VMError(f"Could not stop {self.name}")

    def delete(self) -> None:
        subprocess.run(["incus", "delete", "--force", self.name], capture_output=True, stdin=subprocess.DEVNULL)
        if self.status() is not None:
            raise VMError(f"Could not delete {self.name}")

    def address(self) -> str | None:
        """The VM's IPv4 address from the host's DHCP leases, matched by its MAC."""
        result = subprocess.run(
            ["incus", "config", "get", self.name, "volatile.eth0.hwaddr"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        mac = result.stdout.strip()
        if not mac:
            return None
        result = subprocess.run(
            ["incus", "network", "list-leases", NETWORK, "--format", "json"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
            check=True,
        )
        for lease in json.loads(result.stdout):
            if lease["hwaddr"] == mac and ":" not in lease["address"]:
                return lease["address"]
        return None

    def exec(self, command: str, timeout: float = 600, input: str | None = None, tag: str | None = None) -> subprocess.CompletedProcess:
        """Run a shell command as the desktop user, in their home, with the image's PATH.

        input is text for the command's stdin (e.g. a file's content); without it stdin is empty.
        tag runs it in a session of its own, with tag as the last word of its command line, so
        kill_tagged(tag) can end it and everything it started, even while this call still waits.
        Output that isn't valid UTF-8 (binary files, a cut character) comes back with U+FFFD in its place.
        """
        script = f"set -a; . /etc/environment; set +a; {command}"
        if tag is not None:
            # --wait: the command's own exit code, and its end, as without setsid.
            script = f"set -a; . /etc/environment; set +a; exec setsid --wait bash -c {shlex.quote(command)} {shlex.quote(tag)}"
        # runuser -l: a login shell in the user's home. The user is whoever has uid 1000.
        as_user = f'exec runuser -l "$(id -nu 1000)" -c {shlex.quote(script)}'
        if input is None:
            return subprocess.run(
                ["incus", "exec", self.name, "--", "bash", "-c", as_user],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                text=True,
                errors="replace",
                timeout=timeout,
            )
        return subprocess.run(
            ["incus", "exec", self.name, "--", "bash", "-c", as_user],
            capture_output=True,
            input=input,
            text=True,
            errors="replace",
            timeout=timeout,
        )

    def kill_tagged(self, tag: str) -> None:
        """Kill everything started by exec(..., tag=tag): each such command's whole session, as root.

        For when whoever ran them lost the VM: what they started must not go on in it.
        """
        # The session leader is the `bash -c <command> <tag>` exec started, so its pid is the session id.
        pattern = shlex.quote(f" {tag}$")
        command = f'for sid in $(pgrep -f -- {pattern}); do pkill -KILL -s "$sid"; done; true'
        self.exec_root(command, timeout=30)

    def exec_root(self, command: str, timeout: float = 120) -> subprocess.CompletedProcess:
        """Run a shell command as root (for system things like the login screen)."""
        return subprocess.run(
            ["incus", "exec", self.name, "--", "bash", "-c", command],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
            errors="replace",
            timeout=timeout,
        )

    def copy(self, new_name: str) -> None:
        """Copy this (stopped) VM into a new one: its disk and its settings. The copy gets its own network card address."""
        result = subprocess.run(["incus", "copy", self.name, new_name, "--instance-only"], capture_output=True, stdin=subprocess.DEVNULL, text=True)
        if result.returncode != 0:
            raise VMError(f"Could not copy {self.name}: {result.stderr.strip()}")

    def base_image(self) -> str:
        """The fingerprint of the image the VM was made from, or "" if Incus doesn't know it."""
        result = subprocess.run(
            ["incus", "config", "get", self.name, "volatile.base_image"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        return result.stdout.strip()

    def has_desktop(self) -> bool:
        """False for a VM from a terminal-only image (it has NO_DESKTOP_FILE). Asks the VM, so it must answer commands."""
        result = subprocess.run(["incus", "exec", self.name, "--", "test", "-f", NO_DESKTOP_FILE], capture_output=True, stdin=subprocess.DEVNULL)
        return result.returncode != 0

    def wait_ready(self, timeout: float = 300) -> None:
        """Wait until commands work, the VM has an address, noVNC answers and the desktop is up.

        The desktop is up when its VNC server (x11vnc) listens: it starts only once
        the desktop user is logged in, a few seconds after noVNC's web page works.
        A VM without a desktop (terminal only) is ready once its terminals (ttyd) answer.
        """
        deadline = time.monotonic() + timeout

        while True:
            result = subprocess.run(["incus", "exec", self.name, "--", "true"], capture_output=True, stdin=subprocess.DEVNULL)
            if result.returncode == 0:
                break
            if time.monotonic() > deadline:
                raise VMError(f"{self.name}: the VM agent did not come up")
            time.sleep(2)

        if not self.has_desktop():
            while True:
                address = self.address()
                if address:
                    try:
                        urllib.request.urlopen(f"http://{address}:{TERMINAL_PORT}/", timeout=3)
                        return
                    except OSError:
                        pass
                if time.monotonic() > deadline:
                    raise VMError(f"{self.name}: the terminals (ttyd) did not answer on port {TERMINAL_PORT}")
                time.sleep(2)

        while True:
            address = self.address()
            if address:
                try:
                    urllib.request.urlopen(f"http://{address}:{NOVNC_PORT}/", timeout=3)
                    break
                except OSError:
                    pass
            if time.monotonic() > deadline:
                raise VMError(f"{self.name}: noVNC did not answer on port {NOVNC_PORT}")
            time.sleep(2)

        while True:
            result = subprocess.run(
                ["incus", "exec", self.name, "--", "bash", "-c", f"ss -ltn | grep -q ':{VNC_PORT} '"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
            )
            if result.returncode == 0:
                break
            if time.monotonic() > deadline:
                raise VMError(f"{self.name}: the desktop did not start (no VNC server on port {VNC_PORT})")
            time.sleep(2)

        # GNOME's shell comes up all black after boot and only draws once restarted.
        # Restart it now that the desktop is up; open windows stay open.
        self.exec("pkill -HUP -x gnome-shell; sleep 5", timeout=60)

    def write_file(self, path: str, content: str, mode: str = "0644") -> None:
        """Write a file inside the VM as root (the VM must be running)."""
        result = subprocess.run(
            ["incus", "file", "push", "-", f"{self.name}{path}", "--mode", mode, "--uid", "0", "--gid", "0"],
            input=content,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise VMError(f"Could not write {path} in {self.name}: {result.stderr.strip()}")

    def set_config(self, key: str, value: str) -> None:
        """Set an Incus setting of the VM, e.g. limits.cpu or boot.autostart."""
        result = subprocess.run(
            ["incus", "config", "set", self.name, f"{key}={value}"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            raise VMError(f"Could not set {key} on {self.name}: {result.stderr.strip()}")

    def set_internet(self, enabled: bool, offline_acl: str) -> None:
        """Let the VM reach the internet, or not. Works while it runs, and stays set.

        Off: the VM's network card gets the offline ACL, which rejects everything the
        VM starts itself. Answers to connections from this machine (desktop, terminal)
        still work, and so do DHCP and DNS to the bridge. On: the card goes back to
        the network's own rules (internet yes, this machine and the LAN no).
        """
        if enabled:
            for key in ("security.acls", "security.acls.default.ingress.action", "security.acls.default.egress.action"):
                # Fails when the key isn't set, which is fine.
                subprocess.run(
                    ["incus", "config", "device", "unset", self.name, "eth0", key],
                    capture_output=True,
                    stdin=subprocess.DEVNULL,
                )
            return

        exists = subprocess.run(
            ["incus", "network", "acl", "show", offline_acl],
            capture_output=True,
            stdin=subprocess.DEVNULL,
        ).returncode == 0
        if not exists:
            subprocess.run(
                ["incus", "network", "acl", "create", offline_acl, "--description", "Sandbox VMs with the internet turned off"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                check=True,
            )
            subprocess.run(
                ["incus", "network", "acl", "rule", "add", offline_acl, "egress", "action=reject", "destination=0.0.0.0/0,::/0"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                check=True,
            )

        settings = [
            f"security.acls={offline_acl}",
            "security.acls.default.ingress.action=allow",
            "security.acls.default.egress.action=reject",
        ]
        # The eth0 card comes from the profile; the first time it must be copied onto the VM.
        result = subprocess.run(
            ["incus", "config", "device", "override", self.name, "eth0", *settings],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode != 0:
            result = subprocess.run(
                ["incus", "config", "device", "set", self.name, "eth0", *settings],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                text=True,
            )
        if result.returncode != 0:
            raise VMError(f"Could not turn off the internet of {self.name}: {result.stderr.strip()}")

    def guard_memory(self) -> None:
        """Keep a full memory from freezing the VM. Safe to run again; it stays set after reboots.

        Without this, one process that eats all memory makes the kernel struggle until
        even systemd (PID 1) crashes, and the whole VM freezes. With it:
        - A 4 GiB swap file (when the disk has room) takes spikes, so they slow down instead of failing.
        - user.slice (the desktop, its terminals, the agent's commands) and system.slice
          (the browser terminals, Docker containers) may each use at most 80% of memory
          and 2 GiB of swap. Going over kills the biggest process in that group only.
        - systemd itself, the Incus agent (how this machine reaches the VM) and the
          journal keep some memory that nothing else can take.
        """
        script = """
set -e
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
    if [ ! -f /swapfile ] && [ "$(df --output=avail -B1G / | tail -1)" -gt 8 ]; then
        fallocate -l 4G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile > /dev/null
    fi
    if [ -f /swapfile ]; then
        swapon /swapfile
        grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
fi
systemctl set-property user.slice MemoryMax=80% MemorySwapMax=2G
systemctl set-property system.slice MemoryMax=80% MemorySwapMax=2G
systemctl set-property init.scope MemoryMin=128M
systemctl set-property incus-agent.service MemoryMin=128M
systemctl set-property systemd-journald.service MemoryMin=64M
"""
        result = self.exec_root(script, timeout=120)
        if result.returncode != 0:
            raise VMError(f"Could not set the memory limits of {self.name}: {result.stderr.strip()}")

    def guard_shadow_stack(self) -> None:
        """Keep shadow stacks from crashing the VM. Safe to run again; it stays set after reboots.

        On this host, when a program in the VM turns on a user shadow stack (a CPU security feature),
        the VM's CPU keeps it on for the programs that run after it, and they all crash at once:
        systemd (PID 1) too, so the VM freezes while Incus still says Running. fwupd does this when it
        starts (fwupd-refresh.timer runs it about twice a day). So:
        - The guest kernel gets clearcpuid=user_shstk, so no program can turn shadow stacks on.
          It applies from the next boot. Fedora sets kernel arguments with grubby, Ubuntu and Debian with a
          grub.d file and update-grub. Nothing to do when the kernel already runs with it.
        - fwupd is masked, which covers the boot until then. A VM has no firmware to update anyway.
        """
        script = """
set -e
systemctl mask --now fwupd.service fwupd-refresh.service fwupd-refresh.timer > /dev/null 2>&1
if ! grep -q clearcpuid=user_shstk /proc/cmdline; then
    if command -v grubby > /dev/null; then
        grubby --update-kernel=ALL --args=clearcpuid=user_shstk > /dev/null
    else
        file=/etc/default/grub.d/99-sandbox-no-shadow-stack.cfg
        if [ ! -f "$file" ]; then
            mkdir -p /etc/default/grub.d
            echo 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT clearcpuid=user_shstk"' > "$file"
            update-grub > /dev/null 2>&1
        fi
    fi
fi
"""
        result = self.exec_root(script, timeout=120)
        if result.returncode != 0:
            raise VMError(f"Could not turn off shadow stacks in {self.name}: {result.stderr.strip()}")

    def console_log(self) -> str:
        """What the VM's kernel and systemd printed on its console. Readable even when the VM is frozen."""
        try:
            result = subprocess.run(["incus", "console", self.name, "--show-log"], capture_output=True, stdin=subprocess.DEVNULL, text=True, timeout=20)
        except subprocess.TimeoutExpired:
            return ""
        return result.stdout

    def responds(self) -> bool:
        """Whether commands still run in the VM (a frozen VM shows as Running but doesn't answer)."""
        try:
            return subprocess.run(["incus", "exec", self.name, "--", "true"], capture_output=True, stdin=subprocess.DEVNULL, timeout=10).returncode == 0
        except subprocess.TimeoutExpired:
            return False
