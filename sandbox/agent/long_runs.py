"""Long commands an agent runs in a VM (a test suite, a big install or build), apart from the call that started them.

A run goes on by itself in the VM (setsid, its output in a file there), so it keeps going while its agent does
other things or sleeps, loses its desktop (sandbox/vm_queue.py), or the backend restarts. Only the VM stopping or
restarting, the user's Stop (stop) or RUN_LIMIT_SECONDS end it early, or trouble inside the VM (its disk full, the
memory guard killing it): check() tells its agent which, as far as the VM shows it. A stop of the VM that is still
going on (status stopping) ends nothing: the VM may run on (sandbox/vm.py).

Its agent either waits for it (the bash and run_tests tools wait up to FOREGROUND_SECONDS, then leave it going in
the background), or starts it in the background at once (background: true). A run nobody waits for anymore is
checked by the app every few seconds (agents.py, watch_runs), and the agent gets its result in a message.

Every run is tagged with its own id (VM.exec's tag), not with its agent's, so losing the VM (the user took it or
gave it to another agent, or the app took it back from a full VM) never kills it. It runs as the user of its agent's
desktop (VM.exec), and its output stays in that user's home, so it is checked as that user too.

Runs share the VM's CPU and memory. When memory runs out, a run's processes are ended before the desktop's (VM.exec's
OOM_SCORE_ADJ). An agent the user gave priority (agents.py) gets more of the CPU, and its runs are ended last
(prioritize).

The run shows live in a terminal window on the desktop (computer_use.WATCH). Each agent has its own window, so
another agent's run never closes it; the agent's next run does. Its output stays in the VM, in RUNS_DIR/<id>.log,
and check() reads the end of it. Hiding the user's secrets in it is up to the caller, as for bash.

A run is a dict, kept with its VM (VMQueue.add_run) until it ends:

    {"id": "run_a1b2c3", "agent", "desktop": the desktop it runs on, "kind": "bash" | "tests", "label": the command,
     as the user sees it, "log", "started_at", "background": false while a tool call waits for it, "stopped_by_user": bool,
     and for a test run what run_tests needs to keep its result: "job", "when", "scope", "command", "base",
     "path", "diff_hash"}

    run = start(record, agent_id, 2, "bash", "pip install -e .", "pip install -e .")
    result = check(record, run)    # None while it runs, else {"ended", "exit_code", "output", "seconds"}
"""

import asyncio
import secrets
import shlex
import time
from datetime import UTC, datetime

from sandbox.agent.computer_use import DESKTOP_ENV, WATCH
from sandbox.vm import OOM_SCORE_ADJ
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
# A run that ended without its exit code while its home had less than this free (GB) ran out of room, as far as
# check() can tell (ENOSPC, SQLITE_FULL on vm1, 2026-11-11).
DISK_FULL_GB = 2
# The share of the CPU (systemd's CPUWeight, default 100) of a desktop and a run, and of those of an agent the user gave
# priority (prioritize): ten times as much. Its runs are also ended last when memory runs out, but still before the
# desktop (VM.exec's OOM_SCORE_ADJ for the others, GNOME's own at 100 to 200).
CPU_WEIGHT = 100
PRIORITY_CPU_WEIGHT = 1000
PRIORITY_OOM_SCORE_ADJ = 500
# Math libraries (OpenMP, OpenBLAS, MKL: numpy, torch) start a thread per CPU in every process, so a test suite with 8
# workers ran 80 threads on vm1's 16 CPUs. In a run they use one each; test workers already run side by side.
MATH_THREADS = "OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1"


def start(record: VMRecord, agent_id: str, desktop: int, kind: str, command: str, label: str, folder: str = "") -> dict:
    """Start command in the VM, on the agent's desktop, and return at once with the run. folder: a folder to cd into
    first (from home). Blocking (an incus call)."""
    run_id = "run_" + secrets.token_hex(3)
    log = f"{RUNS_DIR}/{run_id}.log"
    exit_file = f"{RUNS_DIR}/{run_id}.exit"
    # on_desktop starts something on the desktop, as in bash (computer_use.py). Python prints as it goes instead
    # of in chunks, so the window keeps up. Math libraries use one thread each (MATH_THREADS), unless the command says
    # otherwise.
    script = f"on_desktop() {{ ( {DESKTOP_ENV}\"$@\" ) }}; export PYTHONUNBUFFERED=1 {MATH_THREADS}; mkdir -p {RUNS_DIR}; : > {log}; "
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
    result = record.desktop_vm(desktop).exec(f"setsid -f bash -c {shlex.quote(script)} sandbox-{run_id} < /dev/null > /dev/null 2>&1", 30)
    if result.returncode != 0:
        raise ValueError(f"Could not start it: {result.stderr.strip()}")
    return {
        "id": run_id,
        "agent": agent_id,
        "desktop": desktop,
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
    finishing: the user or its agent stopped it, the VM stopped or restarted, the disk filled up, or something else
    ended its processes); a gone one also has "why", that cause as far as the VM shows it. Blocking (an incus call);
    raises when the VM doesn't answer."""
    seconds = round((datetime.now(UTC) - datetime.fromisoformat(run["started_at"])).total_seconds())
    # Only a VM that is really off ended it. The record's status alone never does: a stop or start in the middle may
    # still be going on, or hang (vm1 sat in "stopping" for a quarter of an hour on 2026-11-11 while it ran on, and every
    # run in it was reported ended: prb_7b8fd5), so Incus says whether the VM runs.
    if record.status != "running" and record.vm.status() != "Running":
        return {"ended": "gone", "exit_code": None, "output": "", "seconds": seconds, "why": "the VM stopped or restarted"}
    pattern = shlex.quote(f" sandbox-{run['id']}$")
    exit_file = run["log"].removesuffix(".log") + ".exit"
    # Still going is asked first: once it isn't, its exit code (if any) is already written. An empty exit file (a full
    # disk let it make the file but not write the code) counts as none. With none: the seconds since the VM booted, the
    # KB free in the home, and whether its log is still there, to tell why it ended.
    script = (
        f"if pgrep -f -- {pattern} > /dev/null; then echo running; "
        f"elif [ -s {exit_file} ]; then echo exit $(cat {exit_file}); tail -c {OUTPUT_LIMIT} {run['log']}; "
        f"else echo gone $(cut -d . -f 1 /proc/uptime) $(df -Pk ~ | awk 'NR == 2 {{print $4}}') "
        f"$([ -f {run['log']} ] && echo kept || echo deleted); tail -c {OUTPUT_LIMIT} {run['log']} 2>/dev/null; fi"
    )
    # Runs from before desktops have none: they were all on desktop 1.
    vm = record.desktop_vm(run.get("desktop", 1))
    result = vm.exec(script, 30)
    first, _, output = result.stdout.partition("\n")
    if first == "running" and seconds < RUN_LIMIT_SECONDS:
        return None
    if first == "running":
        stop(record, run)
        output = vm.exec(f"tail -c {OUTPUT_LIMIT} {run['log']}", 30).stdout
        return {"ended": "timeout", "exit_code": None, "output": output, "seconds": seconds}
    if first.startswith("exit "):
        return {"ended": "exit", "exit_code": int(first.split()[1]), "output": output, "seconds": seconds}
    if first.startswith("gone"):
        # Why it ended without its exit code: the VM booted after it started, its folder of runs was deleted (a clean-up
        # of ~/.cache), the disk is full (whatever it ran failed for lack of room, or it couldn't write its result), or
        # else something ended its processes.
        words = first.split()
        why = "something ended its processes (the memory guard, or a kill), while the VM kept running"
        if len(words) == 4 and words[1].isdigit() and int(words[1]) < seconds:
            why = "the VM restarted"
        elif len(words) == 4 and words[3] == "deleted":
            why = f"its log and result were deleted ({RUNS_DIR} is the app's: never clean it up)"
        elif len(words) == 4 and words[2].isdigit() and int(words[2]) < DISK_FULL_GB * 1024 * 1024:
            why = f"the disk is full ({int(words[2]) / 1024 / 1024:.1f} GB free), so it ran out of room or couldn't write its result"
        return {"ended": "gone", "exit_code": None, "output": output, "seconds": seconds, "why": why}
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


def prioritize(record: VMRecord, prioritized: set[str]) -> None:
    """Give the agents the user gave priority (prioritized, agent ids) the VM first: their runs and the desktops they
    hold or run on get PRIORITY_CPU_WEIGHT, the rest CPU_WEIGHT, and their runs are ended after everyone else's when
    memory runs out (PRIORITY_OOM_SCORE_ADJ). Sets every run and desktop each time, so it also takes priority back.
    Blocking (an incus call).

    The CPU is shared per desktop first (each desktop's user has its own slice), then within it per command (each
    started by VM.exec is a session scope of its own), so both get the weight. Until the VM restarts.
    """
    boosted = []
    script = ""
    for run in record.runs:
        weight = CPU_WEIGHT
        adj = OOM_SCORE_ADJ
        if run["agent"] in prioritized:
            weight = PRIORITY_CPU_WEIGHT
            adj = PRIORITY_OOM_SCORE_ADJ
            boosted.append(run.get("desktop", 1))
        # The run's session leader is the `bash -c <command> <tag>` start() began (as in VM.kill_tagged).
        pattern = shlex.quote(f" sandbox-{run['id']}$")
        script += (
            f"for sid in $(pgrep -f -- {pattern}); do "
            f"for pid in $(pgrep -s $sid); do echo {adj} > /proc/$pid/oom_score_adj; done; "
            "scope=$(grep -o '[^/]*[.]scope$' /proc/$sid/cgroup); "
            f'[ -z "$scope" ] || systemctl set-property --runtime "$scope" CPUWeight={weight}; '
            "done 2> /dev/null; "
        )
    for number, line in record.desktops.items():
        if line["holder"] in prioritized:
            boosted.append(number)
    for number in record.desktops:
        weight = CPU_WEIGHT
        if number in boosted:
            weight = PRIORITY_CPU_WEIGHT
        # Desktop 1's user is uid 1000.
        uid = f"$(id -u desktop{number})"
        if number == 1:
            uid = "1000"
        script += f"systemctl set-property --runtime user-{uid}.slice CPUWeight={weight} 2> /dev/null; "
    result = record.vm.exec_root(script + "true", timeout=60)
    if result.returncode != 0:
        raise ValueError(f"Could not set the priority in {record.name}: {result.stderr.strip()}")
