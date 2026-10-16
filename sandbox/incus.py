"""Incus, the VM manager, through its `incus` command line. Nothing sandbox-specific.

Each call runs `incus ...` as a subprocess, so the backend needs the same access
as your shell: membership of the incus-admin group (sandbox/setup_host.sh).
"""

import asyncio
import codecs
import grp
import json
import os
import pwd
from collections.abc import Callable
from dataclasses import dataclass

# Members may use Incus fully (sandbox/setup_host.sh adds you).
ADMIN_GROUP = "incus-admin"


class IncusError(Exception):
    """An incus command failed. The message is Incus's own error text."""


class IncusUnavailableError(IncusError):
    """The incus command is missing or can't reach the Incus daemon."""


@dataclass
class ExecResult:
    exit_code: int
    output: str  # stdout and stderr together; the middle is cut when it's long.
    timed_out: bool = False  # Stopped by the host-side timeout.


class Incus:
    def __init__(self, binary: str = "incus"):
        self._binary = binary

    async def run(self, *args: str, stdin: bytes | None = None, timeout: float = 120) -> str:
        """Run `incus <args>` and return its stdout. Raises IncusError with Incus's message on failure."""
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                *args,
                stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as error:
            raise IncusUnavailableError("The incus command isn't installed. Run sandbox/setup_host.sh.") from error

        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(stdin), timeout)
        except TimeoutError as error:
            process.kill()
            await process.wait()
            raise IncusError(f"incus {args[0]} took longer than {timeout:.0f} seconds") from error
        finally:
            if process.returncode is None:
                process.kill()

        if process.returncode != 0:
            raise _error(stderr.decode(errors="replace").strip() or f"incus {args[0]} failed")
        return stdout.decode(errors="replace")

    # ------------------------------------------------------------------
    # Instances
    # ------------------------------------------------------------------

    async def launch_vm(
        self,
        image: str,
        name: str,
        *,
        profile: str,
        config: dict[str, str],
        devices: dict[str, dict[str, str]],
    ) -> None:
        """Create a VM from an image and start it. Returns once it's started, not booted.

        `devices` sets keys on the profile's devices for this VM only, e.g. {"root": {"size": "40GiB"}}.
        """
        args = ["launch", image, name, "--vm", "--profile", profile]
        for key, value in config.items():
            args += ["--config", f"{key}={value}"]
        for device, keys in devices.items():
            for key, value in keys.items():
                args += ["--device", f"{device},{key}={value}"]
        # Unpacking the image for a new disk can take a while.
        await self.run(*args, timeout=900)

    async def start(self, name: str) -> None:
        await self.run("start", name, timeout=300)

    async def stop(self, name: str) -> None:
        """Shut the VM down cleanly, or pull the plug if it takes longer than 30 seconds.
        Stopping a VM that is already stopped is fine."""
        try:
            await self.run("stop", name, "--timeout", "30", timeout=60)
        except IncusError as error:
            if _is_already_stopped(error):
                return
            try:
                await self.run("stop", name, "--force", timeout=60)
            except IncusError as forced_error:
                if not _is_already_stopped(forced_error):
                    raise

    async def delete(self, name: str) -> None:
        """Delete the VM, running or not. Deleting one that doesn't exist is fine."""
        try:
            await self.run("delete", name, "--force", timeout=300)
        except IncusError as error:
            if not _is_not_found(error):
                raise

    async def instance(self, name: str) -> dict | None:
        """The instance (status, expanded_devices, ...), or None if it doesn't exist."""
        try:
            return json.loads(await self.run("query", f"/1.0/instances/{name}"))
        except IncusError as error:
            if _is_not_found(error):
                return None
            raise

    async def statuses(self) -> dict[str, str]:
        """Every instance's status ("Running", "Stopped", ...) by name."""
        instances = json.loads(await self.run("query", "/1.0/instances?recursion=1"))
        return {instance["name"]: instance["status"] for instance in instances}

    async def network_address(self, network: str) -> str:
        """The network's own IPv4 address with prefix, e.g. "10.70.217.1/24"."""
        info = json.loads(await self.run("query", f"/1.0/networks/{network}"))
        return info["config"]["ipv4.address"]

    async def network_leases(self, network: str) -> list[dict]:
        """The network's addresses in use: its gateway, static allocations and DHCP leases."""
        return json.loads(await self.run("query", f"/1.0/networks/{network}/leases"))

    async def image_exists(self, alias: str) -> bool:
        try:
            await self.run("query", f"/1.0/images/aliases/{alias}")
            return True
        except IncusError as error:
            if _is_not_found(error):
                return False
            raise

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------

    async def exec(
        self,
        name: str,
        command: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        stdin: bytes | None = None,
        timeout: float = 600,
        max_output: int = 200_000,
        on_output: Callable[[str], None] | None = None,
    ) -> ExecResult:
        """Run a command in the VM as root and wait for it.

        `on_output` gets the output as it arrives. The result keeps at most
        `max_output` characters: the start and the end, where errors usually are.
        A command still running after `timeout` seconds is killed (timed_out=True).
        """
        args = [self._binary, "exec", name, "--force-noninteractive"]
        if cwd:
            args += ["--cwd", cwd]
        for key, value in (env or {}).items():
            args += ["--env", f"{key}={value}"]
        if stdin is None:
            args.append("--disable-stdin")
        args += ["--", *command]

        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError as error:
            raise IncusUnavailableError("The incus command isn't installed. Run sandbox/setup_host.sh.") from error

        output = ClippedText(max_output)
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

        async def feed_stdin() -> None:
            assert process.stdin is not None
            try:
                process.stdin.write(stdin or b"")
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                process.stdin.close()

        async def read_output() -> None:
            assert process.stdout is not None
            while chunk := await process.stdout.read(65536):
                text = decoder.decode(chunk)
                if text:
                    output.add(text)
                    if on_output:
                        on_output(text)
            output.add(decoder.decode(b"", final=True))

        tasks = [asyncio.ensure_future(read_output())]
        if stdin is not None:
            tasks.append(asyncio.ensure_future(feed_stdin()))

        timed_out = False
        try:
            await asyncio.wait_for(asyncio.gather(*tasks), timeout)
            await process.wait()
        except TimeoutError:
            timed_out = True
        finally:
            # Also on cancellation (the agent was stopped): don't leave the incus client running.
            if process.returncode is None:
                process.kill()
                await process.wait()
            for task in tasks:
                task.cancel()

        exit_code = process.returncode if process.returncode is not None else -1
        return ExecResult(exit_code=exit_code, output=output.text(), timed_out=timed_out)


class ClippedText:
    """Text that keeps its start and end once it grows past `limit` characters."""

    def __init__(self, limit: int):
        self._head_limit = limit // 4
        self._tail_limit = limit - self._head_limit
        self._head = ""
        self._tail = ""
        self._dropped = 0

    def add(self, text: str) -> None:
        if len(self._head) < self._head_limit:
            room = self._head_limit - len(self._head)
            self._head += text[:room]
            text = text[room:]
        self._tail += text
        if len(self._tail) > self._tail_limit:
            extra = len(self._tail) - self._tail_limit
            self._dropped += extra
            self._tail = self._tail[extra:]

    def text(self) -> str:
        if not self._dropped:
            return self._head + self._tail
        return f"{self._head}\n[... {self._dropped:,} characters cut ...]\n{self._tail}"


def _is_not_found(error: IncusError) -> bool:
    return "not found" in str(error).lower()


def _is_already_stopped(error: IncusError) -> bool:
    return "already stopped" in str(error).lower()


def _error(stderr: str) -> IncusError:
    # Incus prints "Error: ..." last, sometimes after the command's usage.
    errors = [line for line in stderr.splitlines() if line.startswith("Error: ")]
    message = errors[-1].removeprefix("Error: ") if errors else stderr
    lowered = message.lower()
    if "needed permissions" in lowered or ("unix.socket" in lowered and "permission denied" in lowered):
        return IncusUnavailableError(
            f"The backend isn't allowed to use Incus. sandbox/setup_host.sh added your user to the {ADMIN_GROUP} "
            "group, which only takes effect in a new login: log out and back in, then start the backend again. "
            f'Until then, start it with: sg {ADMIN_GROUP} -c "uv run serve"'
        )
    if "unix.socket" in lowered and ("no such file" in lowered or "connection refused" in lowered):
        return IncusUnavailableError(f"Incus isn't running ({message}). Run: sudo sandbox/setup_host.sh")
    return IncusError(message)


def group_to_join() -> str | None:
    """ADMIN_GROUP if this user is in it but this process isn't yet (added after logging in), else None."""
    try:
        group = grp.getgrnam(ADMIN_GROUP)
    except KeyError:
        return None  # Incus isn't set up on this machine.
    if group.gr_gid in os.getgroups():
        return None
    return ADMIN_GROUP if pwd.getpwuid(os.getuid()).pw_name in group.gr_mem else None
