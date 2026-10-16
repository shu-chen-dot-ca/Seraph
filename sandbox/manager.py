"""Sandbox lifecycle: create the VM, clone the repo and let the setup agent set it
up; then follow-up messages, stop/start and delete.

Keeps each sandbox's record and activity log (sandbox/store.py) and streams
changes to whoever follows them (the UI, through backend/app.py). Long work runs
as one background task per sandbox: creating, starting, or an agent run. This is
the only module that ties Incus, the VM and the agent together; it knows nothing
about HTTP.
"""

import asyncio
import bisect
import logging
import re
import secrets
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime

from sandbox.config import SandboxSettings
from sandbox.incus import Incus, IncusError, IncusUnavailableError
from sandbox.models import EventKind, Sandbox, SandboxEvent
from sandbox.preview import preview_host, preview_url
from sandbox.setup_agent import AgentRun, SetupAgent, setup_prompt
from sandbox.setup_tools import SetupState
from sandbox.store import SandboxStore
from sandbox.vm import (
    EDITOR_PORT,
    NIC,
    PROJECT_DIR,
    TERMINAL_PORT,
    SandboxVM,
    SandboxVMError,
    free_address,
    nic_settings,
)

logger = logging.getLogger(__name__)

REPO_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$")
# Streamed command output per tool call; more is cut (the agent's result keeps the end).
MAX_STREAMED_OUTPUT = 200_000
OUTPUT_FLUSH_SECONDS = 0.3
# How often the VMs' real state is checked, e.g. for a `sudo poweroff` inside one.
WATCH_SECONDS = 10


class SandboxError(Exception):
    """Something the user asked for can't be done. The message says why."""


class SandboxNotFoundError(SandboxError):
    pass


class SandboxBusyError(SandboxError):
    """The sandbox is in the middle of something else."""


class SandboxUnavailableError(SandboxError):
    """Sandboxes can't work on this machine yet (Incus or the base image is missing)."""


class SandboxManager:
    def __init__(self, settings: SandboxSettings, incus: Incus, agent: SetupAgent, server_port: int):
        self._settings = settings
        self._incus = incus
        self._agent = agent
        self._server_port = server_port  # For the preview addresses.
        self._store = SandboxStore(settings.state_dir)
        self._sandboxes: dict[str, Sandbox] = {}
        self._feeds: dict[str, _Feed] = {}
        self._vms: dict[str, SandboxVM] = {}
        self._tasks: dict[str, asyncio.Task] = {}  # The work running for each sandbox.
        self._launches: dict[str, asyncio.Task] = {}  # VMs being created; see delete().
        self._reserved: set[str] = set()  # Addresses of VMs being created.
        self._output: dict[str, _OutputBuffer] = {}
        self._watcher: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Startup and shutdown
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Load the sandboxes from disk and match them with their VMs."""
        for sandbox in self._store.load_all():
            self._sandboxes[sandbox.id] = sandbox
            self._feeds[sandbox.id] = _Feed(self._store.load_events(sandbox.id))
            # Work that was running when the backend stopped is gone.
            if sandbox.status == "creating":
                detail = (
                    "Creating was interrupted: the backend restarted. Delete this sandbox and set the repo up again."
                )
                self._update(sandbox.id, status="failed", outcome="failed", detail=detail)
            elif sandbox.status == "setting_up":
                detail = "Interrupted: the backend restarted. Send a message to let the agent continue."
                self._update(sandbox.id, status="failed", outcome="failed", detail=detail)
            elif sandbox.status == "starting":
                self._update(sandbox.id, status=sandbox.outcome or "failed", detail="")
            if sandbox.agent_running:
                self._update(sandbox.id, agent_running=False)
                self._emit(sandbox.id, "error", "The agent was interrupted: the backend restarted.")
        try:
            statuses = await self._incus.statuses()
            for sandbox_id in list(self._sandboxes):
                self._reconcile(sandbox_id, statuses.get(sandbox_id))
        except IncusError as error:
            logger.warning("Can't check the sandbox VMs: %s", error)
        self._watcher = asyncio.create_task(self._watch_vms())

    async def close(self) -> None:
        """Stop all running work (agent runs end as interrupted); the VMs keep running."""
        tasks = list(self._tasks.values()) + ([self._watcher] if self._watcher else [])
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _watch_vms(self) -> None:
        """Notice VMs that stopped, started or disappeared without us (e.g. `sudo poweroff` inside)."""
        while True:
            await asyncio.sleep(WATCH_SECONDS)
            versions = {sandbox_id: feed.version for sandbox_id, feed in self._feeds.items()}
            try:
                statuses = await self._incus.statuses()
            except IncusError as error:
                logger.debug("Can't check the sandbox VMs: %s", error)
                continue
            for sandbox_id, version in versions.items():
                feed = self._feeds.get(sandbox_id)
                # Skip sandboxes with work running or changed meanwhile: `statuses` may be older.
                if feed and feed.version == version and sandbox_id not in self._tasks:
                    self._reconcile(sandbox_id, statuses.get(sandbox_id))

    def _reconcile(self, sandbox_id: str, vm_status: str | None) -> None:
        """Make an idle sandbox's status match its VM's ("Running", "Stopped", ..., None if gone)."""
        sandbox = self._sandboxes[sandbox_id]
        if vm_status is None:
            if sandbox.status != "failed" or "VM is gone" not in sandbox.detail:
                self._update(sandbox_id, status="failed", detail="The VM is gone. Delete this sandbox.")
        elif vm_status != "Running" and sandbox.status in ("ready", "failed"):
            self._update(sandbox_id, status="stopped")  # Keeps the detail: why it failed, if it did.
            self._emit(sandbox_id, "status", "The VM stopped")
        elif vm_status == "Running" and sandbox.status == "stopped":
            self._update(sandbox_id, status=sandbox.outcome or "failed", detail="")
            self._emit(sandbox_id, "status", "The VM started")

    # ------------------------------------------------------------------
    # Reading
    # ------------------------------------------------------------------

    def list(self) -> list[Sandbox]:
        """Newest first."""
        return sorted(self._sandboxes.values(), key=lambda sandbox: sandbox.created_at, reverse=True)

    def get(self, sandbox_id: str) -> Sandbox:
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None:
            raise SandboxNotFoundError(f"There's no sandbox {sandbox_id}.")
        return sandbox

    async def follow(self, sandbox_id: str, after: int = 0) -> AsyncIterator[Sandbox | SandboxEvent]:
        """The sandbox as it is now, its log entries after `after` (a seq), then every change as it
        happens. Ends when the sandbox is deleted."""
        feed = self._feeds.get(sandbox_id)
        if feed is None:
            raise SandboxNotFoundError(f"There's no sandbox {sandbox_id}.")
        index = bisect.bisect_right([event.seq for event in feed.events], after)
        sent_version = -1
        while True:
            changed = feed.changed()  # Taken before reading, so no change is missed.
            if feed.deleted:
                return
            if feed.version != sent_version:
                sent_version = feed.version
                yield self._sandboxes[sandbox_id]
            while index < len(feed.events):
                yield feed.events[index]
                index += 1
            await changed.wait()

    async def vm_address(self, sandbox_id: str) -> str | None:
        """The VM's fixed address for the preview proxy, or None if there's no such sandbox or it's stopped."""
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None or sandbox.status in ("stopped", "stopping"):
            return None
        try:
            return await self._vm(sandbox_id).address()
        except IncusError:
            return None

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    async def create(self, repo: str) -> Sandbox:
        """Start setting up `repo` ("owner/name") in a new sandbox. Returns right away."""
        repo = repo.strip()
        if not REPO_PATTERN.match(repo) or repo.endswith((".", ".git")):
            raise SandboxError(f"{repo!r} isn't a GitHub repository name like owner/name.")
        try:
            image_ready = await self._incus.image_exists(self._settings.image)
        except IncusUnavailableError as error:
            raise SandboxUnavailableError(str(error)) from error
        if not image_ready:
            raise SandboxUnavailableError(
                f"The base image '{self._settings.image}' doesn't exist yet. Build it with sandbox/image/build.sh."
            )
        # From here on nothing awaits, so two quick "Set up" clicks can't both pass the limit.
        self._check_can_run_another()

        sandbox_id = f"sb-{secrets.token_hex(4)}"
        sandbox = Sandbox(
            id=sandbox_id,
            repo=repo,
            created_at=datetime.now(UTC),
            status="creating",
            detail="Creating the VM",
        )
        self._sandboxes[sandbox_id] = self._with_urls(sandbox)
        self._feeds[sandbox_id] = _Feed([])
        self._store.save(self._sandboxes[sandbox_id])
        self._emit(sandbox_id, "status", f"Setting up {repo} in a new sandbox")
        self._start_task(sandbox_id, self._create_and_set_up(sandbox_id))
        return self._sandboxes[sandbox_id]

    async def send_message(self, sandbox_id: str, text: str) -> Sandbox:
        """Give the agent a follow-up request. It runs in the background."""
        sandbox = self.get(sandbox_id)
        text = text.strip()
        if not text:
            raise SandboxError("The message is empty.")
        self._check_idle(sandbox_id)
        if sandbox.status in ("stopped", "stopping", "starting"):
            raise SandboxBusyError("The sandbox isn't running. Start it first.")

        prompt = text
        if sandbox.session_id is None:
            # The first setup never got to the agent (e.g. it couldn't start): begin with the setup request.
            if sandbox.checkout is None:
                raise SandboxError("This sandbox didn't finish creating. Delete it and set the repo up again.")
            prompt = f"{self._setup_prompt(sandbox)}\n\n{text}"

        self._emit(sandbox_id, "user", text)
        self._update(sandbox_id, agent_running=True)
        self._start_task(sandbox_id, self._run_agent(sandbox_id, prompt))
        return self._sandboxes[sandbox_id]

    async def stop_agent(self, sandbox_id: str) -> Sandbox:
        self.get(sandbox_id)
        task = self._tasks.get(sandbox_id)
        if task and self._sandboxes[sandbox_id].agent_running:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return self._sandboxes[sandbox_id]

    async def stop(self, sandbox_id: str) -> Sandbox:
        """Shut the VM down (stopping the agent first). Its disk is kept. Returns once it's down."""
        sandbox = self.get(sandbox_id)
        if sandbox.status in ("creating", "starting", "stopping"):
            raise SandboxBusyError("The sandbox is starting or stopping. Wait a moment, or delete it.")
        if sandbox.status == "stopped":
            return sandbox
        await self.stop_agent(sandbox_id)
        self._check_idle(sandbox_id)
        # As the sandbox's work, so no message or start gets in while the VM shuts down.
        self._update(sandbox_id, status="stopping", detail="Stopping the VM")
        await asyncio.shield(self._start_task(sandbox_id, self._shut_down(sandbox_id)))
        return self._sandboxes[sandbox_id]

    async def start_vm(self, sandbox_id: str) -> Sandbox:
        """Boot a stopped sandbox again. Returns right away; the demo service starts with the VM."""
        sandbox = self.get(sandbox_id)
        if sandbox.status != "stopped":
            raise SandboxBusyError("The sandbox isn't stopped.")
        self._check_can_run_another()
        self._update(sandbox_id, status="starting", detail="Starting the VM")
        self._start_task(sandbox_id, self._boot(sandbox_id))
        return self._sandboxes[sandbox_id]

    async def delete(self, sandbox_id: str) -> None:
        """Delete the VM with its disk, and the sandbox's record and log."""
        self.get(sandbox_id)
        task = self._tasks.get(sandbox_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        launch = self._launches.get(sandbox_id)
        if launch:
            # Incus finishes creating the VM even if we stop waiting, so wait, then delete it.
            await asyncio.gather(launch, return_exceptions=True)
        await self._incus.delete(sandbox_id)
        self._store.delete(sandbox_id)
        del self._sandboxes[sandbox_id]
        self._vms.pop(sandbox_id, None)
        self._output.pop(sandbox_id, None)
        feed = self._feeds.pop(sandbox_id)
        feed.deleted = True
        feed.notify()

    # ------------------------------------------------------------------
    # Background work
    # ------------------------------------------------------------------

    async def _create_and_set_up(self, sandbox_id: str) -> None:
        sandbox = self._sandboxes[sandbox_id]
        vm = self._vm(sandbox_id)
        try:
            settings = self._settings
            address = await free_address(self._incus, settings.network, taken=self._reserved)
            self._reserved.add(address)
            launch = asyncio.ensure_future(
                self._incus.launch_vm(
                    settings.image,
                    sandbox_id,
                    profile=settings.profile,
                    config={"limits.cpu": str(settings.cpus), "limits.memory": settings.memory},
                    devices={"root": {"size": settings.disk}, NIC: nic_settings(address)},
                )
            )
            self._launches[sandbox_id] = launch

            def launched(_: asyncio.Future) -> None:
                self._launches.pop(sandbox_id, None)
                self._reserved.discard(address)

            launch.add_done_callback(launched)
            await asyncio.shield(launch)  # Stopping this work doesn't stop Incus creating the VM.
            self._step(sandbox_id, "Booting the VM")
            await vm.wait_until_ready()
            self._step(sandbox_id, f"Cloning {sandbox.repo}")
            checkout = await vm.clone(_repo_url(sandbox.repo))
            self._update(sandbox_id, checkout=checkout)
            self._emit(sandbox_id, "status", f"Cloned {checkout}")
        except asyncio.CancelledError:
            self._update(sandbox_id, status="failed", outcome="failed", detail="Stopped while creating.")
            raise
        except (IncusError, SandboxVMError) as error:
            self._update(sandbox_id, status="failed", outcome="failed", detail=str(error))
            self._emit(sandbox_id, "error", f"Creating the sandbox failed: {error}")
            return

        self._update(sandbox_id, status="setting_up", detail="The agent is setting it up")
        await self._run_agent(sandbox_id, self._setup_prompt(self._sandboxes[sandbox_id]))

    async def _run_agent(self, sandbox_id: str, prompt: str) -> None:
        """One agent run. During the first setup, its result decides the sandbox's outcome."""
        sandbox = self._sandboxes[sandbox_id]
        first_setup = sandbox.status == "setting_up"
        state = SetupState(app_port=sandbox.app_port, app_path=sandbox.app_path)
        state.on_change = lambda: self._apply_setup_state(sandbox_id, state)
        run = AgentRun(session_id=sandbox.session_id)
        self._update(sandbox_id, agent_running=True)
        try:
            await self._agent.run(prompt, self._vm(sandbox_id), state, run, self._emitter(sandbox_id))
        except asyncio.CancelledError:
            run.error = "The agent was stopped."
            raise
        except Exception as error:  # The SDK or the CLI failed (not logged in, ...).
            logger.exception("Agent run for %s failed", sandbox_id)
            run.error = f"The agent couldn't run: {error}"
        finally:
            self._flush_output(sandbox_id)
            if run.error:
                self._emit(sandbox_id, "error", run.error)
            changes: dict = {"agent_running": False, "session_id": run.session_id}
            if first_setup and self._sandboxes[sandbox_id].status == "setting_up":
                # The agent ended without finish_setup.
                changes |= {
                    "status": "failed",
                    "outcome": "failed",
                    "detail": run.error or "The agent ended without a result.",
                }
            elif first_setup:
                changes["detail"] = ""
            self._update(sandbox_id, **changes)

    async def _shut_down(self, sandbox_id: str) -> None:
        sandbox = self._sandboxes[sandbox_id]
        try:
            await self._incus.stop(sandbox_id)
        except IncusError as error:
            self._update(sandbox_id, status=sandbox.outcome or "failed", detail=f"Stopping failed: {error}")
            raise
        self._update(sandbox_id, status="stopped", detail="")
        self._emit(sandbox_id, "status", "Stopped the VM")

    async def _boot(self, sandbox_id: str) -> None:
        sandbox = self._sandboxes[sandbox_id]
        try:
            await self._incus.start(sandbox_id)
            await self._vm(sandbox_id).wait_until_ready()
        except (IncusError, SandboxVMError) as error:
            self._update(sandbox_id, status="stopped", detail=f"Starting failed: {error}")
            self._emit(sandbox_id, "error", f"Starting the VM failed: {error}")
            return
        self._update(sandbox_id, status=sandbox.outcome or "failed", detail="")
        self._emit(sandbox_id, "status", "Started the VM")

    def _apply_setup_state(self, sandbox_id: str, state: SetupState) -> None:
        """start_app or finish_setup changed something: show it right away."""
        changes: dict = {"app_port": state.app_port, "app_path": state.app_path}
        if state.result:
            outcome = "ready" if state.result.success else "failed"
            changes |= {"summary": state.result.summary, "outcome": outcome, "status": outcome, "detail": ""}
        self._update(sandbox_id, **changes)

    def _start_task(self, sandbox_id: str, work) -> asyncio.Task:
        task = asyncio.create_task(work)
        self._tasks[sandbox_id] = task

        def done(finished: asyncio.Task) -> None:
            if self._tasks.get(sandbox_id) is finished:
                del self._tasks[sandbox_id]
            if not finished.cancelled() and finished.exception():
                logger.error("Sandbox %s work failed", sandbox_id, exc_info=finished.exception())

        task.add_done_callback(done)
        return task

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _check_idle(self, sandbox_id: str) -> None:
        task = self._tasks.get(sandbox_id)
        if task and not task.done():
            sandbox = self._sandboxes[sandbox_id]
            what = "The agent is working" if sandbox.agent_running else "The sandbox is busy"
            raise SandboxBusyError(f"{what}. Wait for it, or stop it first.")

    def _check_can_run_another(self) -> None:
        running = [sandbox for sandbox in self._sandboxes.values() if sandbox.status != "stopped"]
        if len(running) >= self._settings.max_running:
            raise SandboxBusyError(
                f"{len(running)} sandboxes are running, the most allowed (SANDBOX_MAX_RUNNING). "
                "Stop or delete one first."
            )

    def _vm(self, sandbox_id: str) -> SandboxVM:
        if sandbox_id not in self._vms:
            self._vms[sandbox_id] = SandboxVM(
                self._incus,
                sandbox_id,
                public_host=lambda port: preview_host(sandbox_id, port, self._server_port),
            )
        return self._vms[sandbox_id]

    def _setup_prompt(self, sandbox: Sandbox) -> str:
        return setup_prompt(
            sandbox.repo,
            _repo_url(sandbox.repo),
            sandbox.checkout or "",
            preview_url(sandbox.id, 3000, self._server_port),
        )

    def _with_urls(self, sandbox: Sandbox) -> Sandbox:
        port = self._server_port
        return sandbox.model_copy(
            update={
                "preview_url": preview_url(sandbox.id, sandbox.app_port, port, sandbox.app_path)
                if sandbox.app_port
                else None,
                "editor_url": preview_url(sandbox.id, EDITOR_PORT, port, f"/?folder={PROJECT_DIR}"),
                "terminal_url": preview_url(sandbox.id, TERMINAL_PORT, port),
            }
        )

    def _update(self, sandbox_id: str, **changes) -> None:
        sandbox = self._sandboxes.get(sandbox_id)
        if sandbox is None:
            return  # Deleted meanwhile.
        sandbox = self._with_urls(sandbox.model_copy(update=changes))
        self._sandboxes[sandbox_id] = sandbox
        self._store.save(sandbox)
        feed = self._feeds[sandbox_id]
        feed.version += 1
        feed.notify()

    def _step(self, sandbox_id: str, text: str) -> None:
        """A step of creating or starting: shown as the sandbox's detail and in the log."""
        self._update(sandbox_id, detail=text)
        self._emit(sandbox_id, "status", text)

    def _emitter(self, sandbox_id: str) -> Callable[..., None]:
        def emit(
            kind: EventKind, text: str, tool: str | None = None, is_error: bool = False, call_id: str | None = None
        ) -> None:
            if kind == "tool_output":
                self._buffer_output(sandbox_id, tool, text)
            else:
                self._emit(sandbox_id, kind, text, tool=tool, is_error=is_error, call_id=call_id)

        return emit

    def _emit(
        self,
        sandbox_id: str,
        kind: EventKind,
        text: str,
        tool: str | None = None,
        is_error: bool = False,
        call_id: str | None = None,
    ) -> None:
        if sandbox_id not in self._feeds:
            return
        self._flush_output(sandbox_id)
        if kind in ("tool_call", "tool_result"):
            self._output.pop(sandbox_id, None)  # Each call's output starts afresh.
        self._append(sandbox_id, kind=kind, text=text, tool=tool, is_error=is_error, call_id=call_id)

    def _append(self, sandbox_id: str, **fields) -> None:
        # Every entry is saved, so seqs keep growing across backend restarts: pages that are open
        # skip what they have by seq.
        feed = self._feeds[sandbox_id]
        event = SandboxEvent(seq=feed.next_seq(), time=datetime.now(UTC), **fields)
        feed.events.append(event)
        self._store.append_event(sandbox_id, event)
        feed.notify()

    def _buffer_output(self, sandbox_id: str, tool: str | None, text: str) -> None:
        if not text:
            return
        buffer = self._output.setdefault(sandbox_id, _OutputBuffer(tool))
        if buffer.add(text) and buffer.flush_handle is None:
            buffer.flush_handle = asyncio.get_running_loop().call_later(
                OUTPUT_FLUSH_SECONDS, self._flush_output, sandbox_id
            )

    def _flush_output(self, sandbox_id: str) -> None:
        buffer = self._output.get(sandbox_id)
        if buffer is None:
            return
        if buffer.flush_handle:
            buffer.flush_handle.cancel()
            buffer.flush_handle = None
        if buffer.pending and sandbox_id in self._feeds:
            text, buffer.pending = buffer.pending, ""
            self._append(sandbox_id, kind="tool_output", text=text, tool=buffer.tool)


class _Feed:
    """A sandbox's log plus a way to wait for its next change."""

    def __init__(self, events: list[SandboxEvent]):
        self.events = events
        self.version = 0  # Bumped when the Sandbox record changes.
        self.deleted = False
        self._changed = asyncio.Event()

    def next_seq(self) -> int:
        return self.events[-1].seq + 1 if self.events else 1

    def changed(self) -> asyncio.Event:
        """Set at the next change."""
        return self._changed

    def notify(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()


class _OutputBuffer:
    """Output of the running tool call, sent to the log in batches."""

    def __init__(self, tool: str | None):
        self.tool = tool
        self.pending = ""
        self.total = 0
        self.flush_handle: asyncio.TimerHandle | None = None

    def add(self, text: str) -> bool:
        """Returns whether the text was kept (the first MAX_STREAMED_OUTPUT characters are)."""
        if self.total >= MAX_STREAMED_OUTPUT:
            return False
        text = text[: MAX_STREAMED_OUTPUT - self.total]
        self.total += len(text)
        self.pending += text
        if self.total >= MAX_STREAMED_OUTPUT:
            self.pending += "\n[... more output; the result shows the end ...]\n"
        return True


def _repo_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"
