"""One Incus VM. Knows nothing about records, queues or agents.

Every call runs the `incus` command line. Commands inside the VM run as the
desktop user with the image's environment (/etc/environment).
The VM's address comes from the host's DHCP leases, never from what the VM
itself reports.

A VM has 1 to its max desktops (the user sets it per VM, at most MAX_DESKTOPS), each with its own user, home folder,
screen, mouse and keyboard, so agents on different desktops work at the same time without getting in each other's
way. Each has a fixed number, 1 to MAX_DESKTOPS, and a VM may have any of them (e.g. 2 and 3). VM(name, desktop) runs commands as that desktop's user,
and they get SANDBOX_DESKTOP (its number):
- Desktop 1 is the image's own: the uid 1000 user, logged in by the display manager on display :0, its VNC server
  (x11vnc) on VNC_PORT and noVNC on NOVNC_PORT, the demo service `demo`. That session always runs (the VM's start
  waits for it); while the VM doesn't have desktop 1, only its demo and browser stop.
- Desktop n (2 and up) is set up at every start (set_up_desktops): the user desktop<n> with its own home, a desktop
  of the same kind (GNOME, KDE) on a TigerVNC screen of its own (display :<10+n>, DESKTOP_SIZE, VNC on 5900+10+n,
  only inside the VM), noVNC on NOVNC_PORT+n-1, and the demo service `demo-<n>` (its start command in
  /opt/demo-<n>/run.sh). Logging it out (or out from its own menu) ends only that desktop; it starts again by itself.
- Every desktop has its own agents' browser (set_up_browser) on BROWSER_PORT+n-1, run as its user, so what the
  browser saves lands in that desktop's home.
Users have sudo, so one agent can still change the system for all: the agents' prompt has the rules for that.

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
# A VM whose agent doesn't answer this long after it was started hung while booting (wait_agent).
HUNG_BOOT_SECONDS = 180
# The longest one `incus stop` may take (stop): the clean shut down's own 60 seconds and some, then the forced one.
STOP_SECONDS = 120
# The most desktops any VM can have (each VM's own max desktops is set up to this), and the screen size of desktops 2
# and up (desktop 1's comes with the image). Desktop n's ports and screens (above) don't run into each other up to here.
MAX_DESKTOPS = 32
DESKTOP_SIZE = "1280x800"
# How soon the kernel ends a process when memory runs out (-1000 never, 1000 first). Everything exec runs (the agents'
# commands, their test suites) gets this, so a full memory ends a test worker, never the desktop (GNOME's own are at
# 100 to 200). An agent the user gave priority gets less on its runs (long_runs.prioritize).
OOM_SCORE_ADJ = 900
# Desktops 2 and up, as root at every start (set_up_desktops), with numbers (the VM's desktops, e.g. "1 3") and size
# set before it. TigerVNC comes from the system's own packages, the first time. A terminal-only image gets only the
# users and demo services.
DESKTOPS_SCRIPT = r"""
set -e
main=$(id -nu 1000)
has_desktop=yes
if [ -f /etc/sandbox-no-desktop ]; then
    has_desktop=no
fi
if [ "$numbers" != 1 ] && [ $has_desktop = yes ] && [ ! -x /usr/libexec/tigervncsession-start ] && [ ! -x /usr/libexec/vncsession-start ]; then
    if command -v apt-get > /dev/null; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get -y -o DPkg::Lock::Timeout=600 install tigervnc-standalone-server > /dev/null || {
            apt-get -o DPkg::Lock::Timeout=600 update > /dev/null
            apt-get -y -o DPkg::Lock::Timeout=600 install tigervnc-standalone-server > /dev/null
        }
    else
        dnf -y install tigervnc-server > /dev/null
    fi
fi
# Ubuntu's and Debian's TigerVNC, or Fedora's.
start=/usr/libexec/tigervncsession-start
pidfile=/run/tigervncsession
if [ ! -x $start ]; then
    start=/usr/libexec/vncsession-start
    pidfile=/run/vncsession
fi
# The same kind of desktop as desktop 1, in its X11 session.
session=""
for name in ubuntu gnome-xorg gnome plasmax11 plasma; do
    if [ -z "$session" ] && [ -f /usr/share/xsessions/$name.desktop ]; then
        session=$name
    fi
done
if [ -z "$session" ] && [ $has_desktop = yes ]; then
    session=$(basename "$(ls /usr/share/xsessions/*.desktop | head -1)" .desktop)
fi

# Desktop 1's session always runs; while the VM doesn't have it, its demo stops.
if ! echo " $numbers " | grep -q " 1 "; then
    systemctl disable --now demo > /dev/null 2>&1 || true
fi
for n in $(seq 2 $max); do
    user=desktop$n
    display=:$((10 + n))
    if ! echo " $numbers " | grep -q " $n "; then
        # Not one of the VM's desktops (now): it stops. Its user and home stay, with everything in them.
        systemctl disable --now sandbox-desktop-$n sandbox-novnc-$n demo-$n > /dev/null 2>&1 || true
        continue
    fi
    if ! id $user > /dev/null 2>&1; then
        useradd --create-home --shell /bin/bash $user
    fi
    # The same groups as desktop 1's user (docker, ...), and sudo like it.
    for group in $(id -Gn $main); do
        if [ $group != $main ]; then
            usermod -aG $group $user
        fi
    done
    echo "$user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/91-$user
    chmod 440 /etc/sudoers.d/91-$user
    home=$(getent passwd $user | cut -d: -f6)

    # Its own demo service, like desktop 1's demo (sandbox/image/base_layer.sh).
    mkdir -p /opt/demo-$n
    if [ ! -f /opt/demo-$n/run.sh ]; then
        printf '#!/usr/bin/env bash\necho "No demo yet: the agent writes the start command here."\nexit 1\n' > /opt/demo-$n/run.sh
    fi
    chmod 755 /opt/demo-$n/run.sh
    chown -R $user: /opt/demo-$n
    cat > /etc/systemd/system/demo-$n.service <<EOF
[Unit]
Description=Desktop $n's demo, started by its agent
After=network-online.target docker.service

[Service]
User=$user
WorkingDirectory=$home
EnvironmentFile=/etc/environment
ExecStart=/opt/demo-$n/run.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

    if [ $has_desktop = no ]; then
        continue
    fi
    # Ubuntu's and Debian's TigerVNC read the first file, Fedora's the second.
    mkdir -p $home/.vnc $home/.config/tigervnc $home/.config/autostart
    printf '$session = "%s";\n$localhost = "yes";\n$SecurityTypes = "None";\n$geometry = "%s";\n' $session $size > $home/.vnc/tigervnc.conf
    printf 'session=%s\nlocalhost\nsecuritytypes=none\ngeometry=%s\n' $session $size > $home/.config/tigervnc/config
    # Desktop 1's VNC server starts with every desktop session (the image's autostart), but not in this one.
    printf '[Desktop Entry]\nType=Application\nName=x11vnc\nHidden=true\n' > $home/.config/autostart/x11vnc.desktop
    echo yes > $home/.config/gnome-initial-setup-done
    chown -R $user: $home/.vnc $home/.config
    grep -q "^$display=" /etc/tigervnc/vncserver.users || echo "$display=$user" >> /etc/tigervnc/vncserver.users
    # Like TigerVNC's own service, but it starts again after a log out (from its menu too).
    cat > /etc/systemd/system/sandbox-desktop-$n.service <<EOF
[Unit]
Description=Desktop $n (TigerVNC)
After=network.target systemd-user-sessions.service

[Service]
Type=forking
ExecStart=$start $display
PIDFile=$pidfile-$display.pid
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    cat > /etc/systemd/system/sandbox-novnc-$n.service <<EOF
[Unit]
Description=noVNC for desktop $n
After=network.target

[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc $((novnc_port + n - 1)) localhost:$((5910 + n))
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --quiet sandbox-desktop-$n sandbox-novnc-$n
    systemctl start --no-block sandbox-desktop-$n sandbox-novnc-$n
done
systemctl daemon-reload
"""
# The agents' browser in the VM (set_up_browser): its folder, and the file it runs (here, and copied in there).
BROWSER_DIR = "/opt/sandbox-browser"
# Desktop n's browser listens on BROWSER_PORT + n - 1, on localhost only.
BROWSER_PORT = 9230
BROWSER_SERVICE = Path(__file__).resolve().parent / "agent" / "browser_service.py"
# Run as root before the browser starts: installs what it needs the first time (a few minutes), quick after that.
# Playwright and its Firefox from their own official places (PyPI, Playwright's downloads), Xvfb (the display
# nobody sees) and on Ubuntu and Debian the libraries Firefox needs from the system's own packages.
BROWSER_INSTALL = f"""#!/usr/bin/env bash
set -euo pipefail
dir={BROWSER_DIR}
export PLAYWRIGHT_BROWSERS_PATH=$dir/browsers
if [ -x "$dir/venv/bin/playwright" ] && ls -d "$dir"/browsers/firefox-* > /dev/null 2>&1 && command -v Xvfb > /dev/null; then
    exit 0
fi
if command -v apt-get > /dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=600 update
    apt-get -y -o DPkg::Lock::Timeout=600 install python3-venv xvfb
fi
if command -v dnf > /dev/null; then
    dnf -y install xorg-x11-server-Xvfb
fi
if [ ! -x "$dir/venv/bin/playwright" ]; then
    python3 -m venv "$dir/venv"
    "$dir/venv/bin/pip" install --quiet playwright
fi
"$dir/venv/bin/playwright" install firefox
# Not on every release Playwright knows; the desktop's own Firefox brought most of them anyway.
if command -v apt-get > /dev/null; then
    "$dir/venv/bin/playwright" install-deps firefox || true
fi
"""
# One per desktop, as its user, so what it saves is theirs: sandbox-browser for desktop 1, sandbox-browser-<n> for
# desktop n, which starts after desktop 1's (so only one installs at a time). The {...} parts are filled in by
# set_up_browser. A failed install (no internet) is tried again every 30 seconds. At most 60% of the VM's memory,
# so it can't starve the rest.
BROWSER_UNIT = """[Unit]
Description=The agents' browser for desktop {desktop} (sandbox/agent/browser_service.py)
After=network-online.target {after}
Wants=network-online.target

[Service]
User={user}
WorkingDirectory=~
Environment=PLAYWRIGHT_BROWSERS_PATH={dir}/browsers
Environment=SANDBOX_BROWSER_PORT={port}
Environment=SANDBOX_BROWSER_DISPLAY={display}
ExecStartPre=+{dir}/install.sh
ExecStart={dir}/venv/bin/python {dir}/browser_service.py
TimeoutStartSec=20min
Restart=always
RestartSec=30
MemoryMax=60%

[Install]
WantedBy=multi-user.target
"""


class VMError(Exception):
    pass


class VM:
    def __init__(self, name: str, desktop: int = 1):
        self.name = name
        # Whose commands exec runs: desktop 1's user (uid 1000) or desktop<n>.
        self.desktop = desktop

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
        # Each incus stop has a time limit of its own: one that hangs must not hold the VM in "stopping" for good, while
        # it runs on and answers commands (vm1 on 2026-11-11, its disk full: every run in it was reported ended,
        # prb_3e5cac). Still running after both, it raises, and its status goes back to running (sandbox/vms.py).
        stopped = False
        if responds:
            # Ask the VM to shut down; force it off if it takes too long.
            try:
                result = subprocess.run(["incus", "stop", self.name, "--timeout", "60"], capture_output=True, stdin=subprocess.DEVNULL, timeout=STOP_SECONDS)
                stopped = result.returncode == 0
            except subprocess.TimeoutExpired:
                stopped = False
        if not stopped:
            try:
                subprocess.run(["incus", "stop", self.name, "--force"], capture_output=True, stdin=subprocess.DEVNULL, timeout=STOP_SECONDS)
            except subprocess.TimeoutExpired:
                pass
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
        """Run a shell command as this desktop's user, in their home, with the image's PATH and SANDBOX_DESKTOP set.

        input is text for the command's stdin (e.g. a file's content); without it stdin is empty.
        tag runs it in a session of its own, with tag as the last word of its command line, so
        kill_tagged(tag) can end it and everything it started, even while this call still waits.
        Output that isn't valid UTF-8 (binary files, a cut character) comes back with U+FFFD in its place.
        """
        script = f"set -a; . /etc/environment; set +a; export SANDBOX_DESKTOP={self.desktop}; {command}"
        if tag is not None:
            # --wait: the command's own exit code, and its end, as without setsid.
            script = f"set -a; . /etc/environment; set +a; export SANDBOX_DESKTOP={self.desktop}; exec setsid --wait bash -c {shlex.quote(command)} {shlex.quote(tag)}"
        # runuser -l: a login shell in the user's home. Desktop 1's user is whoever has uid 1000.
        user = '"$(id -nu 1000)"'
        if self.desktop != 1:
            user = f"desktop{self.desktop}"
        # Set as root, before runuser: everything the command starts gets it too.
        as_user = f"echo {OOM_SCORE_ADJ} > /proc/self/oom_score_adj; exec runuser -l {user} -c {shlex.quote(script)}"
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

    def wait_agent(self, timeout: float = 300) -> bool:
        """Wait until commands work in the VM (its Incus agent answers). Whether it had to be started again.

        Now and then a VM hangs in its firmware at boot, on this host: in shim, before the kernel, at full CPU,
        never getting further. One that doesn't answer within HUNG_BOOT_SECONDS is forced off and on, once,
        and then gets HUNG_BOOT_SECONDS more. Raises VMError when it still doesn't answer.
        """
        started = time.monotonic()
        deadline = started + timeout
        restarted = False
        while not self.responds():
            if not restarted and time.monotonic() - started > HUNG_BOOT_SECONDS:
                subprocess.run(["incus", "restart", "--force", self.name], capture_output=True, stdin=subprocess.DEVNULL)
                restarted = True
                deadline = max(deadline, time.monotonic() + HUNG_BOOT_SECONDS)
            if time.monotonic() > deadline:
                raise VMError(f"{self.name}: the VM agent did not come up (also not after a forced restart)")
            time.sleep(2)
        return restarted

    def wait_ready(self, timeout: float = 300) -> None:
        """Wait until commands work (wait_agent: a VM that hangs at boot is started again, once), the VM has an
        address, noVNC answers and the desktop is up.

        The desktop is up when its VNC server (x11vnc) listens: it starts only once
        the desktop user is logged in, a few seconds after noVNC's web page works.
        A VM without a desktop (terminal only) is ready once its terminals (ttyd) answer.
        """
        self.wait_agent(timeout)
        # From here on the VM boots normally: the desktop gets its own time.
        deadline = time.monotonic() + timeout

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
          and 2 GiB of swap. Going over kills a process in that group only: an agent's
          command first (OOM_SCORE_ADJ), the biggest of them.
        - Ubuntu's systemd-oomd doesn't watch the desktops (user@.service): under memory
          pressure it killed parts of GNOME, or a desktop's whole session, never the test
          suites that filled the memory (they run outside user@.service).
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
mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\\nManagedOOMMemoryPressure=auto\\n' > /etc/systemd/system/user@.service.d/90-sandbox-no-oomd.conf
systemctl daemon-reload
"""
        result = self.exec_root(script, timeout=120)
        if result.returncode != 0:
            raise VMError(f"Could not set the memory limits of {self.name}: {result.stderr.strip()}")

    def use_host_timezone(self) -> None:
        """Give the VM this machine's time zone. Safe to run again; it stays set after reboots.

        The VM goes out to the internet through this machine's network, so sites see this machine's address. A
        browser whose clock says another zone (images start on UTC) looks like a bot to them. Programs already
        running in the VM (an open browser) see the new zone once they start again.
        """
        # /etc/localtime links to /usr/share/zoneinfo/<zone>; without such a link there is nothing to copy.
        target = os.path.realpath("/etc/localtime")
        if "/zoneinfo/" not in target:
            return
        zone = shlex.quote(target.split("/zoneinfo/")[1])
        # timedatectl also tells the desktop's clock; without it, the link alone does it. An image without time zone
        # data keeps its own.
        script = f"""
if [ -f /usr/share/zoneinfo/{zone} ]; then
    timedatectl set-timezone {zone} 2> /dev/null || ln -sf /usr/share/zoneinfo/{zone} /etc/localtime
fi
"""
        result = self.exec_root(script, timeout=30)
        if result.returncode != 0:
            raise VMError(f"Could not set the time zone of {self.name}: {result.stderr.strip()}")

    def set_firefox_graphics_name(self) -> None:
        """Make Firefox tell sites a common graphics card instead of "llvmpipe". Safe to run again.

        The VM has no graphics card, so Firefox draws WebGL in software (llvmpipe), and sites can ask WebGL which card
        it uses. Bot checks (Tesla's, for one) block a browser that says llvmpipe, which real computers almost never
        do. Tried on vm1: with these names Tesla's pages load, without them they are blocked. They are Firefox's
        default settings (a file in its install folder), so about:config can still change them; Firefox reads them
        when it starts. Mozilla's package is in /usr/lib/firefox, Fedora's in /usr/lib64/firefox, Debian's ESR in
        /usr/lib/firefox-esr. An image without Firefox (terminal only) has none of them.
        """
        script = """
for dir in /usr/lib/firefox /usr/lib64/firefox /usr/lib/firefox-esr; do
    if [ -d "$dir" ]; then
        mkdir -p "$dir/defaults/pref"
        cat > "$dir/defaults/pref/sandbox-graphics-name.js" << 'EOF'
// Written by the sandbox app at every VM start (sandbox/vm.py, set_firefox_graphics_name).
pref("webgl.vendor-string-override", "Intel");
pref("webgl.renderer-string-override", "Mesa Intel(R) UHD Graphics 620 (KBL GT2)");
EOF
    fi
done
"""
        result = self.exec_root(script, timeout=30)
        if result.returncode != 0:
            raise VMError(f"Could not set Firefox's graphics card name in {self.name}: {result.stderr.strip()}")

    def set_up_browser(self, numbers: list[int], restart: bool = True) -> None:
        """Put the agents' browser in the VM (sandbox/agent/browser_service.py) and start one for each of its desktops
        (numbers, e.g. [1, 3]). Safe to run again; a desktop the VM no longer has loses its browser.

        Each runs as a systemd service: sandbox-browser for desktop 1, sandbox-browser-<n> for desktop n. The first
        time in a VM the start installs what they need (BROWSER_INSTALL), which takes a few minutes and doesn't hold
        up the VM's start: meanwhile the browser tools say it is still starting. Started again here (not only at
        boot), so a VM always runs this file's newest version. restart=False leaves the browsers already going alone
        and only starts the missing ones: a desktop added or removed while agents work on the others.
        """
        result = self.exec_root(f"mkdir -p {BROWSER_DIR}", timeout=30)
        if result.returncode != 0:
            raise VMError(f"Could not make {BROWSER_DIR} in {self.name}: {result.stderr.strip()}")
        self.write_file(f"{BROWSER_DIR}/browser_service.py", BROWSER_SERVICE.read_text())
        self.write_file(f"{BROWSER_DIR}/install.sh", BROWSER_INSTALL, "0755")
        units = []
        for desktop in numbers:
            unit = "sandbox-browser"
            user = "1000"
            after = ""
            if desktop != 1:
                unit = f"sandbox-browser-{desktop}"
                user = f"desktop{desktop}"
                after = "sandbox-browser.service"
            text = BROWSER_UNIT.format(
                desktop=desktop,
                after=after,
                user=user,
                dir=BROWSER_DIR,
                port=BROWSER_PORT + desktop - 1,
                display=f":{98 + desktop}",
            )
            self.write_file(f"/etc/systemd/system/{unit}.service", text)
            units.append(unit)
        gone = []
        for desktop in range(1, MAX_DESKTOPS + 1):
            if desktop in numbers:
                continue
            if desktop == 1:
                gone.append("sandbox-browser")
            else:
                gone.append(f"sandbox-browser-{desktop}")
        gone = " ".join(gone)
        units = " ".join(units)
        # start does nothing to a browser that already runs.
        action = "restart"
        if not restart:
            action = "start"
        # Not while one is still installing (it started at boot): a restart then would kill apt halfway.
        script = f"""
systemctl disable --now {gone} > /dev/null 2>&1 || true
systemctl daemon-reload
for unit in {units}; do
    systemctl enable --quiet $unit
    if [ "$(systemctl is-active $unit)" != activating ]; then
        systemctl {action} --no-block $unit
    fi
done
"""
        result = self.exec_root(script, timeout=60)
        if result.returncode != 0:
            raise VMError(f"Could not start the browser in {self.name}: {result.stderr.strip()}")

    def set_up_desktops(self, numbers: list[int]) -> None:
        """Make the VM's desktops (numbers, e.g. [1, 3]) and start them, and stop the ones it doesn't have
        (DESKTOPS_SCRIPT). Safe to run again. The first time it installs TigerVNC (under a minute); it doesn't wait for
        the desktops to come up."""
        listed = " ".join([str(number) for number in numbers])
        script = f'numbers="{listed}"\nmax={MAX_DESKTOPS}\nsize={DESKTOP_SIZE}\nnovnc_port={NOVNC_PORT}\n' + DESKTOPS_SCRIPT
        result = self.exec_root(script, timeout=900)
        if result.returncode != 0:
            raise VMError(f"Could not set up the desktops of {self.name}: {result.stderr.strip()[-500:]}")

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
