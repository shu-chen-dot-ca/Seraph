"""Long commands an agent runs in a VM (a test suite, a big install or build), apart from the call that started them.

A run goes on by itself in the VM (setsid, its output in a file there), so it keeps going while its agent does
other things, steps aside so another agent can use the VM (sandbox/vm_queue.py), or the backend restarts. Only the
VM stopping or restarting, the user's Stop (stop) or RUN_LIMIT_SECONDS end it early.

Its agent either waits for it (the bash and run_tests tools wait up to FOREGROUND_SECONDS, then leave it going in
the background), or starts it in the background at once (background: true). A run nobody waits for anymore is
checked by the app every few seconds (agents.py, watch_runs), and the agent gets its result in a message.

Every run is tagged with its own id (VM.exec's tag), not with its agent's, so losing the VM (the user took it,
gave it to another agent or skipped the agent) never kills it.

The run shows live in a terminal window on the desktop (computer_use.WATCH). Each agent has its own window, so
another agent's run never closes it; the agent's next run does. Its output stays in the VM, in RUNS_DIR/<id>.log,
and check() reads the end of it. Hiding the user's secrets in it is up to the caller, as for bash.

A run is a dict, kept with its VM (VMQueue.add_run) until it ends:

    {"id": "run_a1b2c3", "agent", "kind": "bash" | "tests", "label": the command, as the user sees it, "log",
     "started_at", "background": false while a tool call waits for it, "stopped_by_user": bool,
     and for a test run what run_tests needs to keep its result: "job", "when", "scope", "command", "base",
     "path", "diff_hash"}

    run = start(record, agent_id, "bash", "pip install -e .", "pip install -e .")
    result = check(record, run)    # None while it runs, else {"ended", "exit_code", "output", "seconds"}
"""

import asyncio
import secrets
import shlex
import time
from datetime import UTC, datetime

from sandbox.agent.computer_use import DESKTOP_ENV, WATCH
from sandbox.vms import VMRecord

# Where runs keep their output and exit code, in the desktop user's home.
RUNS_DIR = "~/.cache/sandbox-runs"
# A tool call waits this long for its run, then leaves it going in the background.
FOREGROUND_SECONDS = 600
# How often a waiting tool call looks whether its run ended.
CHECK_SECONDS = 2
# A run is stopped after this long. Long on purpose: a project's official checks are run however long they take.
RUN_LIMIT_SECONDS = 12 * 3600
# check() gives back the last this many bytes of the output, where results and errors are.
OUTPUT_LIMIT = 50_000


def start(record: VMRecord, agent_id: str, kind: str, command: str, label: str, folder: str = "") -> dict:
    """Start command in the VM and return at once with the run. folder: a folder to cd into first (from home).
    Blocking (an incus call)."""
    run_id = "run_" + secrets.token_hex(3)
    log = f"{RUNS_DIR}/{run_id}.log"
    exit_file = f"{RUNS_DIR}/{run_id}.exit"
    # on_desktop starts something on the desktop, as in bash (computer_use.py). Python prints as it goes instead
    # of in chunks, so the window keeps up.
    script = f"on_desktop() {{ ( {DESKTOP_ENV}\"$@\" ) }}; export PYTHONUNBUFFERED=1; mkdir -p {RUNS_DIR}; : > {log}; "
    # A test suite's exit code counts even when it pipes into something (tee, tail).
    if kind == "tests":
        script = "set -o pipefail; " + script
    script += WATCH.format(log=log, pid=f"{RUNS_DIR}/watch-{agent_id}.pid")
    # The newline ends a comment on the command's last line. The exit code is written last: once that file is
    # there, the run is over.
    inner = f"{{ {command}\n}}"
    if folder:
        inner = f"cd {folder} && {inner}"
    script += f"{{ {inner}\n}} > {log} 2>&1; echo $? > {exit_file}"
    # setsid -f: a session of its own that outlives this call; the tag is the last word of its command line.
    result = record.vm.exec(f"setsid -f bash -c {shlex.quote(script)} sandbox-{run_id} < /dev/null > /dev/null 2>&1", 30)
    if result.returncode != 0:
        raise ValueError(f"Could not start it: {result.stderr.strip()}")
    return {
        "id": run_id,
        "agent": agent_id,
        "kind": kind,
        "label": label,
        "log": log,
        "started_at": datetime.now(UTC).isoformat(),
        "background": False,
        "stopped_by_user": False,
    }


def check(record: VMRecord, run: dict) -> dict | None:
    """None while the run goes. Once it ended: {"ended", "exit_code", "output", "seconds"}, where ended is "exit"
    (it finished, with exit_code), "timeout" (stopped after RUN_LIMIT_SECONDS) or "gone" (it ended without
    finishing: the user stopped it, or the VM stopped or restarted). Blocking (an incus call); raises when the
    VM doesn't answer."""
    seconds = round((datetime.now(UTC) - datetime.fromisoformat(run["started_at"])).total_seconds())
    if record.status != "running":
        return {"ended": "gone", "exit_code": None, "output": "", "seconds": seconds}
    pattern = shlex.quote(f" sandbox-{run['id']}$")
    exit_file = run["log"].removesuffix(".log") + ".exit"
    # Still going is asked first: once it isn't, its exit code (if any) is already written.
    script = (
        f"if pgrep -f -- {pattern} > /dev/null; then echo running; "
        f"elif [ -f {exit_file} ]; then echo exit $(cat {exit_file}); tail -c {OUTPUT_LIMIT} {run['log']}; "
        f"else echo gone; tail -c {OUTPUT_LIMIT} {run['log']} 2>/dev/null; fi"
    )
    result = record.vm.exec(script, 30)
    first, _, output = result.stdout.partition("\n")
    if first == "running" and seconds < RUN_LIMIT_SECONDS:
        return None
    if first == "running":
        stop(record, run)
        output = record.vm.exec(f"tail -c {OUTPUT_LIMIT} {run['log']}", 30).stdout
        return {"ended": "timeout", "exit_code": None, "output": output, "seconds": seconds}
    if first.startswith("exit "):
        return {"ended": "exit", "exit_code": int(first.split()[1]), "output": output, "seconds": seconds}
    if first == "gone":
        return {"ended": "gone", "exit_code": None, "output": output, "seconds": seconds}
    raise ValueError(f"Could not check the run: {result.stderr.strip()}")


async def wait(record: VMRecord, run: dict, seconds: float) -> dict | None:
    """Wait up to seconds for the run to end. How it ended, or None when it still goes then, or when it was moved
    to the background meanwhile (the agent's turn ended: the app collects it now)."""
    started = time.monotonic()
    while time.monotonic() - started < seconds:
        await asyncio.sleep(CHECK_SECONDS)
        if run["background"]:
            return None
        try:
            result = await asyncio.to_thread(check, record, run)
        except Exception:
            # The VM doesn't answer right now: look again.
            continue
        if result is not None:
            return result
    return None


def stop(record: VMRecord, run: dict) -> None:
    """End the run and everything it started. Blocking (an incus call)."""
    record.vm.kill_tagged(f"sandbox-{run['id']}")
