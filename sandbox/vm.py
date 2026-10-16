"""One sandbox VM, as the manager and the setup agent's tools use it.

Knows the base image's layout (sandbox/image/provision.sh): commands run as the
user `dev`, the repo is cloned to /home/dev/project, the demo runs as the `demo`
systemd service, and the web editor and terminal listen on fixed ports.
Everything goes through Incus; HTTP checks go from this machine to the VM's
address, with the Host header the user's browser will send.

Each VM's network card has a fixed address that Incus assigns and enforces: the
VM can't use another address, and sandboxes can't reach each other. That
address is the only one this machine ever connects to; what the VM itself
reports is never trusted (a VM could claim this machine's address).
"""

import asyncio
import ipaddress
import json
import random
import shlex
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass

import httpx

from sandbox.incus import ExecResult, Incus, IncusError

DEV_USER = "dev"
HOME_DIR = "/home/dev"
PROJECT_DIR = "/home/dev/project"
DEMO_SCRIPT = "/home/dev/.sandbox/demo.sh"
DEMO_SERVICE = "demo"
EDITOR_PORT = 13337  # code-server
TERMINAL_PORT = 13338  # ttyd
RESERVED_PORTS = {EDITOR_PORT, TERMINAL_PORT}

CHECK_PAGE_SCRIPT = "/opt/sandbox/check-page.mjs"
BROWSERS_PATH = "/opt/sandbox/browsers"

MAX_FILE_BYTES = 1_000_000
NIC = "eth0"  # The network card in the sandbox profile (sandbox/setup_host.sh).


def nic_settings(address: str) -> dict[str, str]:
    """A sandbox's network card: a fixed address it can't change or spoof, isolated from other sandboxes."""
    return {"ipv4.address": address, "security.ipv4_filtering": "true", "security.port_isolation": "true"}


async def free_address(incus: Incus, network: str, taken: Iterable[str] = ()) -> str:
    """An address on the sandbox network that no VM uses or has reserved, and that isn't in `taken`."""
    subnet = ipaddress.ip_interface(await incus.network_address(network)).network
    used = {lease["address"] for lease in await incus.network_leases(network)} | set(taken)
    free = [str(host) for host in subnet.hosts() if str(host) not in used]
    if not free:
        raise SandboxVMError(f"The sandbox network {network} has no free addresses. Delete some sandboxes.")
    return random.choice(free)


class SandboxVMError(Exception):
    """Something in the VM didn't work out, e.g. it never finished booting."""


@dataclass
class HttpCheck:
    """One HTTP request from this machine to the app, as the user's browser would send it."""

    status: int | None  # None when nothing answered.
    error: str | None = None  # Why nothing answered.
    content_type: str = ""
    location: str = ""  # Where a redirect points.
    body_start: str = ""


@dataclass
class AppStart:
    answered: bool  # The port answered HTTP before the wait was over.
    seconds: float
    http: HttpCheck
    service_state: str  # e.g. "active", "failed", "activating"
    restarts: int  # How often the service crashed and was restarted.
    logs: str


class SandboxVM:
    def __init__(self, incus: Incus, name: str, public_host: Callable[[int], str]):
        """`public_host(port)` is the Host header the user's browser sends for that port,
        e.g. "3000-sb-1a2b3c4d.localhost:8000" (see sandbox/preview.py)."""
        self.name = name
        self._incus = incus
        self._public_host = public_host
        self._address: str | None = None

    # ------------------------------------------------------------------
    # Boot and clone (used by the manager)
    # ------------------------------------------------------------------

    async def wait_until_ready(self, timeout: float = 300) -> None:
        """Wait until the VM agent answers and first-boot setup (network, disk size, ...) is done."""
        if not await self.address():
            raise SandboxVMError("The VM has no fixed address on the sandbox network, so it can't be reached safely.")
        deadline = time.monotonic() + timeout
        while True:
            try:
                result = await self._incus.exec(self.name, ["true"], timeout=10)
                if result.exit_code == 0:
                    break
            except IncusError:
                pass
            if time.monotonic() > deadline:
                raise SandboxVMError(f"The VM didn't finish booting within {timeout:.0f} seconds.")
            await asyncio.sleep(2)

        # Grows the disk, sets the hostname, ... on the first boot. 2 = done with warnings.
        result = await self._incus.exec(self.name, ["cloud-init", "status", "--wait"], timeout=300)
        if result.exit_code not in (0, 2):
            raise SandboxVMError(f"First-boot setup failed: {result.output.strip()}")

    async def address(self) -> str | None:
        """The VM's fixed address (see nic_settings), from Incus's config. None if it has none."""
        if self._address is None:
            instance = await self._incus.instance(self.name)
            nic = ((instance or {}).get("expanded_devices") or {}).get(NIC) or {}
            if nic.get("ipv4.address") and nic.get("security.ipv4_filtering") == "true":
                self._address = nic["ipv4.address"]
        return self._address

    async def clone(self, repo_url: str) -> str:
        """Clone the repo into the project folder. Returns "<branch> at <commit> <subject>"."""
        # Partial clone: the full history, but file contents only for the checked-out commit.
        command = f"git clone --filter=blob:none {shlex.quote(repo_url)} {PROJECT_DIR}"
        result = await self.run(command, cwd=HOME_DIR, timeout=900)
        if result.exit_code != 0:
            raise SandboxVMError(f"git clone failed:\n{result.output.strip()}")
        head = await self.run("git branch --show-current && git log -1 --format='%h %s'", timeout=30)
        branch, _, commit = head.output.strip().partition("\n")
        return f"{branch} at {commit}"

    # ------------------------------------------------------------------
    # Commands and files, as the user dev
    # ------------------------------------------------------------------

    async def run(
        self,
        command: str,
        *,
        cwd: str = PROJECT_DIR,
        timeout: float = 600,
        on_output: Callable[[str], None] | None = None,
        max_output: int = 200_000,
    ) -> ExecResult:
        """Run a bash command as dev in a login shell, with no input.

        After `timeout` seconds the command is killed inside the VM (exit code 124 or 137).
        """
        # runuser, not incus exec --user: it also sets dev's groups (docker, ...).
        argv = [
            "timeout",
            "--kill-after=10",
            str(int(timeout)),
            "runuser",
            "-u",
            DEV_USER,
            "--",
            "bash",
            "-lc",
            command,
        ]
        return await self._incus.exec(
            self.name,
            argv,
            cwd=cwd,
            env=_dev_env(),
            timeout=timeout + 30,
            on_output=on_output,
            max_output=max_output,
        )

    async def read_text(self, path: str) -> str:
        """A text file's content. Raises SandboxVMError if it's missing, unreadable, binary or too big."""
        path = absolute(path)
        result = await self._as_dev(
            [
                "sh",
                "-c",
                f'test -f "$1" && test -r "$1" && wc -c < "$1" && head -c {MAX_FILE_BYTES + 1} -- "$1"',
                "sh",
                path,
            ],
            max_output=MAX_FILE_BYTES + 100,
        )
        if result.exit_code != 0:
            raise SandboxVMError(result.output.strip() or f"{path} doesn't exist or isn't a readable file.")
        size_line, _, content = result.output.partition("\n")
        if int(size_line.strip() or 0) > MAX_FILE_BYTES:
            raise SandboxVMError(f"{path} is bigger than {MAX_FILE_BYTES:,} bytes. Use run_command (head, grep, ...).")
        if "\x00" in content:
            raise SandboxVMError(f"{path} is a binary file.")
        return content

    async def write_text(self, path: str, content: str, executable: bool = False) -> None:
        """Create or overwrite a file as dev, creating its folder if needed."""
        path = absolute(path)
        script = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"'
        if executable:
            script += ' && chmod +x -- "$1"'
        result = await self._as_dev(["sh", "-c", script, "sh", path], stdin=content.encode())
        if result.exit_code != 0:
            raise SandboxVMError(result.output.strip() or f"Couldn't write {path}.")

    async def _as_dev(self, argv: list[str], **kwargs) -> ExecResult:
        return await self._incus.exec(
            self.name, ["runuser", "-u", DEV_USER, "--", *argv], cwd=PROJECT_DIR, env=_dev_env(), timeout=60, **kwargs
        )

    async def _as_root(self, command: str, timeout: float = 60) -> ExecResult:
        return await self._incus.exec(self.name, ["bash", "-c", command], timeout=timeout)

    # ------------------------------------------------------------------
    # The demo app
    # ------------------------------------------------------------------

    async def start_app(
        self, command: str, port: int, path: str = "/", cwd: str = PROJECT_DIR, wait: float = 180
    ) -> AppStart:
        """Write the demo's start script, (re)start the demo service and wait until the port answers HTTP."""
        script = (
            "#!/bin/bash -l\n"
            "# Started by the demo service (sudo systemctl restart demo, journalctl -u demo -f).\n"
            "# Written by the setup agent.\n"
            f"cd {shlex.quote(absolute(cwd))}\n"
            f"{command}\n"
        )
        await self.write_text(DEMO_SCRIPT, script, executable=True)
        # The time and restart count from before, to tell this run's logs and crashes from earlier ones.
        restarted = await self._as_root(
            f"date +%s && systemctl show {DEMO_SERVICE} -p NRestarts --value"
            f" && systemctl enable --quiet {DEMO_SERVICE} && systemctl restart {DEMO_SERVICE}"
        )
        if restarted.exit_code != 0:
            raise SandboxVMError(f"Couldn't start the demo service:\n{restarted.output.strip()}")
        since, restarts_before = restarted.output.split()[:2]

        started = time.monotonic()
        http = HttpCheck(status=None, error="not checked yet")
        while time.monotonic() - started < wait:
            http = await self.http_get(port, path)
            if http.status is not None:
                break
            state, restarts = await self._service_state()
            if state == "failed" or restarts > int(restarts_before):
                break  # It crashed: the logs say why.
            await asyncio.sleep(2)

        state, restarts = await self._service_state()
        return AppStart(
            answered=http.status is not None,
            seconds=time.monotonic() - started,
            http=http,
            service_state=state,
            restarts=restarts - int(restarts_before),
            logs=await self.app_logs(since=since),
        )

    async def app_logs(self, lines: int = 80, since: str | None = None) -> str:
        since_arg = f"--since @{since}" if since else ""
        result = await self._as_root(f"journalctl -u {DEMO_SERVICE} {since_arg} -n {lines} --no-pager -o cat")
        return result.output.strip()

    async def _service_state(self) -> tuple[str, int]:
        result = await self._as_root(f"systemctl show {DEMO_SERVICE} -p ActiveState -p NRestarts")
        values = dict(line.split("=", 1) for line in result.output.splitlines() if "=" in line)
        return values.get("ActiveState", "unknown"), int(values.get("NRestarts", "0") or 0)

    async def http_get(self, port: int, path: str = "/") -> HttpCheck:
        """GET the page from this machine, with the Host header of the user's preview address.

        Reads only the start of the body, and gives up after 15 seconds: a page that streams
        forever (or a huge one) can't hang the agent or fill this machine's memory.
        """
        address = await self.address()
        if not address:
            return HttpCheck(status=None, error="the VM has no address")
        try:
            async with (
                asyncio.timeout(15),
                httpx.AsyncClient(timeout=10, trust_env=False) as client,
                client.stream(
                    "GET", f"http://{address}:{port}{path}", headers={"Host": self._public_host(port)}
                ) as response,
            ):
                body = await _read_start(response, limit=2_000, seconds=3)
        except httpx.ConnectError:
            return HttpCheck(status=None, error="nothing is listening on the port yet")
        except (httpx.TimeoutException, TimeoutError):
            return HttpCheck(status=None, error="no answer within 15 seconds")
        except httpx.HTTPError as error:
            return HttpCheck(status=None, error=str(error) or type(error).__name__)
        return HttpCheck(
            status=response.status_code,
            content_type=response.headers.get("content-type", ""),
            location=response.headers.get("location", ""),
            body_start=body.decode(response.encoding or "utf-8", errors="replace")[:500],
        )

    async def look_at_page(self, port: int, path: str = "/") -> dict:
        """Load the page in headless Chromium inside the VM. See sandbox/image/check-page.mjs."""
        command = f"PLAYWRIGHT_BROWSERS_PATH={BROWSERS_PATH} node {CHECK_PAGE_SCRIPT} {port} {shlex.quote(path)}"
        result = await self.run(command, cwd=HOME_DIR, timeout=120, max_output=5_000_000)
        # The report is one line of JSON; warnings may come around it.
        for line in reversed(result.output.splitlines()):
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except ValueError:
                    break
        raise SandboxVMError(f"The browser check failed:\n{result.output.strip()[-2000:]}")


async def _read_start(response: httpx.Response, limit: int, seconds: float) -> bytes:
    """Up to `limit` bytes of the body: what arrives within `seconds`."""
    body = b""
    try:
        async with asyncio.timeout(seconds):
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) >= limit:
                    break
    except TimeoutError:
        pass
    return body[:limit]


def absolute(path: str) -> str:
    """Paths the agent gives are relative to the project folder."""
    if path.startswith("~/"):
        return HOME_DIR + path[1:]
    return path if path.startswith("/") else f"{PROJECT_DIR}/{path}"


def _dev_env() -> dict[str, str]:
    return {"HOME": HOME_DIR, "USER": DEV_USER, "LOGNAME": DEV_USER, "SHELL": "/bin/bash"}
