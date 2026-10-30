"""Jobs: the smallest unit of work. One agent has many jobs; a job has exactly one agent.

The user makes a job by assigning an issue to an agent, or a repo to set up (Set up on the Repos page);
an agent can make jobs for itself. The app makes follow_up jobs (Agents.follow_up): on a PR or issue of the user's
that an agent follows (the GitHub tab, agent mode Drafts), someone else wrote or the PR's checks failed. "thread" is
that PR or issue; the agent suggests a reply or a new version of the PR as a draft, or marks the job done when
nothing needs an answer.
Each job is one JSON file, DATA_DIR/jobs/<id>.json:

    {"id": "job_a1b2c3", "kind": "fix_issue" | "set_up_repo" | "task" | "follow_up" | ..., "title", "agent": "<agent id>",
     "issue": "owner/name#n" | null, "thread": "owner/name#n" (follow_up) | null, "repo": "owner/name" | null, "vm": "vm1" | null,
     "status": "queued" | "working" | "waiting_on_user" | "done" | "cancelled",
     "instructions": "extra text from the user", "notes": "the agent's progress notes",
     "drafts": ["draft_..."], "evidence": [Evidence, ...], "created_by": "user" | "<agent id>",
     "created_at", "updated_at"}

"kind" is open-ended: a kind not in STEPS gets the "task" steps, so new kinds need no change.
Jobs are never deleted: when an agent is deleted, its open jobs become "cancelled".

Progress, which the agent sets with job_progress so the user can follow along without knowing the code:

    "steps": ["understand", ...]   the fixed steps of this kind of job (STEPS), copied in when it is made
    "step": "test" | null          the step it is on; it may go back (from test to fix when tests fail)
    "step_at"                      when it got to that step
    "started_at"                   when the job first became "working"
    "about"                        what the job is about, in everyday words
    "headline"                     where it stands right now, in everyday words
    "detail"                       the same, technical (files, tests), for a closer look

Waiting on the user, done and cancelled are not steps: the job's status says them.

The project's tests, run by the agent with run_tests: first on the unchanged code (they must pass
before the agent changes anything), then on the finished change (they must pass again, with the
same command, before a PR can be drafted). The scope is focused, the basic checks (the tests that cover
the change: the default), or full, the project's official checks (what its rules ask to run before a PR;
when those would take over an hour the agent asks the user first). A job on a repo another job already
got the official checks passing for, on the same VM, takes over that before run instead of setting up again:

    "tests": {"before": Run | null, "after": Run | null}
    Run: {"command", "scope": "full" | "focused" (missing on old runs: full), "base", "exit_code",
          "passed", "diff_hash" (sha256 of the diff it ran on, "" for before), "evidence": "ev_..."
          (its output), "seconds", "at"}

Evidence is what the agent shows the user so they can decide on its drafts: screenshots, images
from the VM (a plot, a render) and command runs (a failing test, then the same test passing).
Each item has a topic and a stage, so the Inbox can put "before" and "after" of one topic side
by side:

    {"id": "ev_a1b2c3", "kind": "screenshot" | "image" | "command", "topic": "help output",
     "stage": "before" | "after" | "other", "context": "how to read this comparison (plain words)",
     "caption": "what this side shows",
     "file": "ev_a1b2c3.jpg" (images) | null, "command": "pytest tests/test_help.py" | null,
     "exit_code": 0 | null, "output_file": "ev_a1b2c3.txt" (commands) | null,
     "output_tail": "the last lines of the output", "output_size": bytes, "created_at"}

Images and command output are files in EVIDENCE_DIR, so the live feed only carries the short
tail. A new item with the topic and stage of an existing one replaces it (a retake after a
change); the old files stay, because a draft made earlier still shows them. Every draft keeps a
copy of its job's evidence as it was when the draft was made.

The backend keeps one Jobs object that the API and every agent share, so each method takes
the lock. version goes up by one on every change; the live feed compares it to see what to send.
"""

import copy
import json
import os
import secrets
import threading
from datetime import UTC, datetime
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# override: the backend reloads itself on code changes, and .env changes should apply then too.
load_dotenv(PROJECT_ROOT / ".env", override=True)

DATA_DIR = PROJECT_ROOT / os.environ["DATA_DIR"]
EVIDENCE_DIR = DATA_DIR / "evidence"
STATUSES = ["queued", "working", "waiting_on_user", "done", "cancelled"]
# The fields update() may change. The others are set once, by create().
UPDATABLE = ["status", "notes", "vm", "drafts", "title", "instructions", "step", "about", "headline", "detail", "tests"]
# The steps each kind of job goes through, in order. Kinds not listed use "task".
STEPS = {
    "fix_issue": ["understand", "set_up", "reproduce", "fix", "test", "draft"],
    # Set up a repo in the VM: an app left running on the desktop, or a library cloned and opened in VS Code
    # (show), then a short introduction to it (introduce).
    "set_up_repo": ["understand", "set_up", "show", "introduce"],
    "task": ["understand", "work", "check", "report"],
    # Answer what happened on a PR or issue the agent follows: read it (understand), make the change or write the reply
    # (work), the tests when the PR's code changed (test), then the draft.
    "follow_up": ["understand", "work", "test", "draft"],
}


class Jobs:
    def __init__(self):
        self.folder = DATA_DIR / "jobs"
        self.lock = threading.Lock()
        self.version = 0
        self.jobs: dict[str, dict] = {}
        # "*.json" leaves out a "*.json.tmp" a crash may have left behind.
        for path in sorted(self.folder.glob("*.json")):
            job = json.loads(path.read_text())
            # Jobs from before evidence existed have none.
            job.setdefault("evidence", [])
            # Jobs from before progress existed.
            job.setdefault("steps", STEPS.get(job["kind"], STEPS["task"]))
            job.setdefault("step", None)
            job.setdefault("step_at", None)
            job.setdefault("started_at", None)
            job.setdefault("about", "")
            job.setdefault("headline", "")
            job.setdefault("detail", "")
            # Jobs from before test runs were kept.
            job.setdefault("tests", {"before": None, "after": None})
            # And from before follow-ups.
            job.setdefault("thread", None)
            self.jobs[job["id"]] = job

    def save(self, job: dict) -> None:
        """Write one job to disk. Called with the lock held, after every change."""
        self.version += 1
        self.folder.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a record.
        temporary = self.folder / f"{job['id']}.json.tmp"
        temporary.write_text(json.dumps(job, indent=2))
        temporary.replace(self.folder / f"{job['id']}.json")

    def list(self) -> list[dict]:
        """All jobs, newest first."""
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda job: job["created_at"], reverse=True)
            return copy.deepcopy(jobs)

    def get(self, job_id: str) -> dict:
        with self.lock:
            if job_id not in self.jobs:
                raise KeyError(f"No job {job_id}")
            return copy.deepcopy(self.jobs[job_id])

    def for_agent(self, agent_id: str) -> list[dict]:
        """One agent's jobs, oldest first: the order it should work on them."""
        with self.lock:
            jobs = [job for job in self.jobs.values() if job["agent"] == agent_id]
            jobs = sorted(jobs, key=lambda job: job["created_at"])
            return copy.deepcopy(jobs)

    def create(self, kind: str, title: str, agent: str, created_by: str, issue: str | None = None,
               repo: str | None = None, vm: str | None = None, instructions: str = "", thread: str | None = None) -> dict:
        # An issue id is "owner/name#n", so it already says the repo. So does a thread's.
        if issue and not repo:
            repo = issue.split("#")[0]
        if thread and not repo:
            repo = thread.split("#")[0]

        now = datetime.now(UTC).isoformat()
        with self.lock:
            job_id = "job_" + secrets.token_hex(3)
            while job_id in self.jobs:
                job_id = "job_" + secrets.token_hex(3)
            job = {
                "id": job_id,
                "kind": kind,
                "title": title,
                "agent": agent,
                "issue": issue,
                "thread": thread,
                "repo": repo,
                "vm": vm,
                "status": "queued",
                "instructions": instructions,
                "notes": "",
                "drafts": [],
                "evidence": [],
                "created_by": created_by,
                "created_at": now,
                "updated_at": now,
                "steps": STEPS.get(kind, STEPS["task"]),
                "step": None,
                "step_at": None,
                "started_at": None,
                "about": "",
                "headline": "",
                "detail": "",
                "tests": {"before": None, "after": None},
            }
            self.jobs[job_id] = job
            self.save(job)
            return copy.deepcopy(job)

    def update(self, job_id: str, **fields) -> dict:
        """Change some of a job's fields (see UPDATABLE). Returns the job as it is now."""
        for name in fields:
            if name not in UPDATABLE:
                raise ValueError(f"A job's {name} can't be changed")
        if "status" in fields and fields["status"] not in STATUSES:
            raise ValueError(f"Unknown job status {fields['status']!r}, use one of: {', '.join(STATUSES)}")

        now = datetime.now(UTC).isoformat()
        with self.lock:
            if job_id not in self.jobs:
                raise KeyError(f"No job {job_id}")
            job = self.jobs[job_id]
            if "step" in fields and fields["step"] not in job["steps"]:
                raise ValueError(f"Unknown step {fields['step']!r} for this job, use one of: {', '.join(job['steps'])}")
            if "step" in fields and fields["step"] != job["step"]:
                job["step_at"] = now
            if fields.get("status") == "working" and job["started_at"] is None:
                job["started_at"] = now
            # A copy, so the caller's list (drafts) is not shared with the stored job.
            job.update(copy.deepcopy(fields))
            job["updated_at"] = now
            self.save(job)
            return copy.deepcopy(job)

    def rename_vm(self, name: str, new_name: str) -> None:
        """A VM got another name: its jobs (done ones too) say the new one. updated_at stays: nothing happened to the jobs."""
        with self.lock:
            for job in self.jobs.values():
                if job["vm"] == name:
                    job["vm"] = new_name
                    self.save(job)

    def add_evidence(self, job_id: str, item: dict) -> bool:
        """Add one evidence item to a job. Returns True when it replaced one with the same topic and stage.

        Under the lock, so two items the agent adds at the same time both stay.
        """
        with self.lock:
            if job_id not in self.jobs:
                raise KeyError(f"No job {job_id}")
            job = self.jobs[job_id]
            topic = item["topic"].strip().lower()
            # A retake takes the old one's place, so the Inbox keeps its order.
            evidence = []
            replaced = False
            for other in job["evidence"]:
                if other["topic"].strip().lower() == topic and other["stage"] == item["stage"]:
                    if not replaced:
                        evidence.append(copy.deepcopy(item))
                    replaced = True
                    continue
                evidence.append(other)
            if not replaced:
                evidence.append(copy.deepcopy(item))
            job["evidence"] = evidence
            job["updated_at"] = datetime.now(UTC).isoformat()
            self.save(job)
            return replaced

    def remove_evidence(self, job_id: str, evidence_ids: list[str]) -> list[str]:
        """Take evidence items off a job (their files stay, for older drafts). Returns the ids removed."""
        with self.lock:
            if job_id not in self.jobs:
                raise KeyError(f"No job {job_id}")
            job = self.jobs[job_id]
            removed = [item["id"] for item in job["evidence"] if item["id"] in evidence_ids]
            if not removed:
                return []
            job["evidence"] = [item for item in job["evidence"] if item["id"] not in evidence_ids]
            job["updated_at"] = datetime.now(UTC).isoformat()
            self.save(job)
            return removed

    def delete_for_agent(self, agent_id: str) -> None:
        """The agent is being deleted or archived: its open jobs become "cancelled". The jobs stay."""
        now = datetime.now(UTC).isoformat()
        with self.lock:
            for job in self.jobs.values():
                if job["agent"] != agent_id or job["status"] in ["done", "cancelled"]:
                    continue
                job["status"] = "cancelled"
                job["updated_at"] = now
                self.save(job)
