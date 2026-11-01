"""A project's agents' own tools (github_searcher/projects.py): its chat agent's, its workers' and its reviewer's.

The chat agent (the repository's agent: its record's "repo"):
- project_status: the project as its Development page shows it: on or off, Drafts or Auto, the user's goals, what each
  worker is on, the issues it denied, its open PRs and, for the app's own repo, its errors.
- crash_report: what becomes of the app's errors the app gave it (crashes.py): a new issue for them, a comment on the
  issue they belong to, or skipped (with why). Only for the app's own repo (projects.SELF_REPO). It acts as the user
  without asking: the user wants errors to become issues by themselves.
Its draft_issue (repo_tools.py) creates the issue at once in Auto mode.

A worker (record "project", role "worker"):
- sync_code: the newest code of the project in its own folder in the VM (~/<its name>), with GitHub's branches as
  origin/*. The VM has no GitHub access, so a private repo can't be fetched there: the app clones it here with the
  user's sign-in and copies it in as a git bundle, and the token never enters the VM.
- deny_issue: closes the job's issue as not planned, as the user, with the agent's reason as a comment, and ends the job.

The reviewer (role "reviewer"):
- sync_code, as above;
- review_read: a PR draft it was given to review, as the user would see it (title, text, overview, commits, diff, the
  test runs, the evidence with its pictures as pictures), and, while it holds the VM, the diff in ~/review-<draft id>.diff;
- review_done: pass (the draft goes to the user's Inbox) or changes (back to its author, with the notes).

Each tool returns its result as text; a bad call returns is_error. describe() gives the chat's line for each call.

    tools = ProjectTools(agents, record).list()
"""

import asyncio
import base64
import json
import secrets
import shlex
import subprocess
import tempfile

import httpx
from claude_agent_sdk import tool

from github_searcher.github_account import GIT_ENV
from github_searcher.jobs import EVIDENCE_DIR
from github_searcher.projects import DATA_DIR, DENY_KINDS, SELF_REPO
from github_searcher.agent.work_tools import EMOJI, NO_EMOJI
from sandbox.file_transfer import to_vm
from sandbox.vms import VMsError

# review_read shows this much of a draft's diff; the rest is in the VM's file.
REVIEW_DIFF_CHARS = 150_000
# The evidence's picture types, by file ending (inbox_api.py serves the same).
PICTURE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}


class ProjectTools:
    def __init__(self, agents, record: dict):
        # The Agents manager: projects, crashes, the inbox, jobs, the VMs and your_repositories (the user's sign-in).
        self.agents = agents
        # The agent's record (the same dict): "repo" for the chat agent, "project" and "role" for the others.
        self.record = record
        self.agent_id = record["id"]

    @property
    def repo(self) -> str | None:
        """The repo these act on, read from the record each time: it is set on a new agent's record after it is made."""
        return self.record.get("repo") or self.record.get("project")

    def list(self) -> list:
        repo = self.repo
        names = {"type": "array", "items": {"type": "string"}}
        sync_code = tool(
            "sync_code",
            f"Put the newest code of {repo} in your own folder in the VM, ~/{self.record['name']} (only while you hold the VM): "
            "made the first time, and every time after, origin/* is brought up to date with GitHub's branches (origin/main "
            "is the newest main). The VM can't reach the repo itself, so this is the only way to get it or update it. Your "
            "own branches and changes in the folder stay as they are.",
            {},
        )(self.sync_code)
        if self.record.get("repo") is not None:
            return [
                tool(
                    "project_status",
                    f"See {repo}'s development as the user sees it on its Development page: whether it is on, Drafts or Auto "
                    "mode, the user's goals, each worker and what it is on, the issues being worked on, denied (with why) or "
                    "done, the open pull requests with their checks, and for the app's own repo its errors.",
                    {},
                )(self.project_status),
                tool(
                    "crash_report",
                    "Deal with the app's errors the app gave you (their ids, err_...), as the user, on GitHub: action new_issue "
                    "makes one issue for them (title, body: what goes wrong for the user, when, the error and where in the code "
                    "it comes from, and what done looks like); add_to_issue comments on the open issue they belong to (issue: "
                    "its number; body: that it happened again, how often, and anything new); skip leaves them (why: one line, "
                    "e.g. a network blip, or caused by the user's own setup). Several errors with one cause go in one call. "
                    "No emoji.",
                    {
                        "type": "object",
                        "properties": {
                            "ids": names,
                            "action": {"type": "string", "enum": ["new_issue", "add_to_issue", "skip"]},
                            "title": {"type": "string"},
                            "body": {"type": "string"},
                            "issue": {"type": "integer"},
                            "why": {"type": "string"},
                        },
                        "required": ["ids", "action"],
                    },
                )(self.crash_report),
            ]
        if self.record.get("role") == "worker":
            return [
                sync_code,
                tool(
                    "deny_issue",
                    "Deny the issue of one of your jobs: it is closed on GitHub as not planned, as the user, with your reason "
                    "as a comment, and the job ends. Only after you checked it (and for a bug, tried to reproduce it on the "
                    f"newest code). kind: {', '.join(DENY_KINDS)}. why: the reason for the people who read the issue, 1 to 3 "
                    "sentences, specific (the issue or PR it repeats or conflicts with, by number; what you ran that didn't "
                    "show the problem). If the user reopens it, a worker takes it again.",
                    {
                        "type": "object",
                        "properties": {"job_id": {"type": "string"}, "kind": {"type": "string", "enum": list(DENY_KINDS)}, "why": {"type": "string"}},
                        "required": ["job_id", "kind", "why"],
                    },
                )(self.deny_issue),
            ]
        if self.record.get("role") == "reviewer":
            return [
                sync_code,
                tool(
                    "review_read",
                    "Read a PR draft you were given to review (draft_...): its title and text as they would go to GitHub, the "
                    "overview for the user, its commits, the diff, the test runs and the evidence, with the pictures. While you "
                    "hold the VM, the whole diff is also put in ~/review-<draft id>.diff, to apply on the commit it starts "
                    "from (base_sha) in your folder.",
                    {"draft_id": str},
                )(self.review_read),
                tool(
                    "review_done",
                    "Your verdict on a PR draft you reviewed. pass: it goes to the user's Inbox, with your notes. changes: it "
                    "goes back to its author with your notes, and never reaches the user. notes: for pass, what you checked "
                    "in a few lines; for changes, exactly what must change and why, each point on its own line. No emoji.",
                    {
                        "type": "object",
                        "properties": {"draft_id": {"type": "string"}, "verdict": {"type": "string", "enum": ["pass", "changes"]}, "notes": {"type": "string"}},
                        "required": ["draft_id", "verdict", "notes"],
                    },
                )(self.review_done),
            ]
        return []

    def describe(self, name: str, args: dict) -> str | None:
        """The chat's line for a call of these tools, or None for another tool."""
        if name == "project_status":
            return "Looked at the project's development"
        if name == "crash_report" and args.get("action") == "new_issue":
            return f"New issue for errors: {args.get('title')}"
        if name == "crash_report" and args.get("action") == "add_to_issue":
            return f"Adding errors to #{args.get('issue')}"
        if name == "crash_report":
            return "Skipping errors: " + ", ".join(args.get("ids") or [])
        if name == "sync_code":
            return "Getting the newest code into the VM"
        if name == "deny_issue":
            return f"Denying the issue of {args.get('job_id')}: {args.get('kind')}"
        if name == "review_read":
            return f"Reading {args.get('draft_id')} to review it"
        if name == "review_done":
            return f"Review of {args.get('draft_id')}: {args.get('verdict')}"
        return None

    async def project_status(self, args: dict) -> dict:
        project = self.agents.projects.get(self.repo)
        if project is None:
            return {"content": [{"type": "text", "text": f"{self.repo} isn't developed by agents: the user hasn't started it on its Development page."}], "is_error": True}
        workers = []
        for agent_id in project["workers"]:
            agent = self.agents.agents.get(agent_id)
            if agent is None:
                continue
            jobs = []
            for job in self.agents.jobs.for_agent(agent_id):
                if job["status"] in ["queued", "working", "waiting_on_user"]:
                    jobs.append({"id": job["id"], "title": job["title"], "status": job["status"], "step": job["step"], "headline": job["headline"]})
            workers.append({"name": agent.name, "jobs": jobs})
        status = {
            "on": project["on"],
            "mode": project["mode"],
            "goals": project["goals"],
            "workers": workers,
            "issues": list(project["issues"].values()),
            "prs": [pr for pr in project["prs"].values() if pr["state"] == "open"],
        }
        if self.repo.lower() == SELF_REPO.lower():
            status["errors"] = []
            for item in self.agents.crashes.list()[:30]:
                status["errors"].append({key: item[key] for key in ["id", "source", "message", "count", "last_at", "version", "state", "issue", "note"]})
        return {"content": [{"type": "text", "text": json.dumps(status)}]}

    async def crash_report(self, args: dict) -> dict:
        if self.repo.lower() != SELF_REPO.lower():
            return {"content": [{"type": "text", "text": f"Errors are only for the app's own repo, {SELF_REPO or 'unknown here'}."}], "is_error": True}
        ids = args.get("ids") or []
        known = [item["id"] for item in self.agents.crashes.list() if item["state"] in ["sent", "new"]]
        unknown = [each for each in ids if each not in known]
        if not ids or unknown:
            return {"content": [{"type": "text", "text": f"Give the ids of errors the app gave you; not waiting for you: {', '.join(unknown) or 'none given'}."}], "is_error": True}
        action = args.get("action")
        title = (args.get("title") or "").strip()
        body = (args.get("body") or "").strip()
        found = EMOJI.findall(title + body + (args.get("why") or ""))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}

        if action == "skip":
            why = (args.get("why") or "").strip()
            if not why:
                return {"content": [{"type": "text", "text": "Say in why, in one line, why they aren't worth an issue."}], "is_error": True}
            await asyncio.to_thread(self.agents.crashes.mark, ids, "skipped", None, why)
            return {"content": [{"type": "text", "text": f"Skipped {len(ids)}. If one happens again, you get it again."}]}

        if action == "add_to_issue":
            number = args.get("issue")
            if not number or not body:
                return {"content": [{"type": "text", "text": "Give the issue's number and the comment's body."}], "is_error": True}
            try:
                url = await asyncio.to_thread(self.agents.projects.comment, self.repo, number, body)
            except (ValueError, httpx.HTTPError) as error:
                return {"content": [{"type": "text", "text": f"Could not comment on #{number}: {error}"}], "is_error": True}
            await asyncio.to_thread(self.agents.crashes.mark, ids, "filed", number, f"added to #{number}")
            return {"content": [{"type": "text", "text": f"Commented on #{number}: {url}"}]}

        if action != "new_issue":
            return {"content": [{"type": "text", "text": "action must be new_issue, add_to_issue or skip."}], "is_error": True}
        if not title or not body:
            return {"content": [{"type": "text", "text": "A new issue needs a title and a body."}], "is_error": True}
        try:
            result = await asyncio.to_thread(self.agents.your_repositories.act, self.repo, "new_issue", None, "issue", {"title": title, "body": body})
        except (ValueError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not open the issue: {error}"}], "is_error": True}
        number = int(result["url"].rstrip("/").split("/")[-1])
        await asyncio.to_thread(self.agents.crashes.mark, ids, "filed", number, f"#{number}")
        return {"content": [{"type": "text", "text": f"Opened #{number}: {result['url']}. A worker takes it like any other issue."}]}

    async def sync_code(self, args: dict) -> dict:
        vm_name = self.record["target_vm"]
        if vm_name is None:
            return {"content": [{"type": "text", "text": "You have no target VM."}], "is_error": True}
        try:
            vm_record = self.agents.vms.get(vm_name)
        except VMsError as error:
            return {"content": [{"type": "text", "text": str(error)}], "is_error": True}
        desktop = vm_record.holding(self.agent_id)
        if desktop is None:
            return {"content": [{"type": "text", "text": "You don't hold a VM. Call queue_for_vm and wait for the message that it is yours."}], "is_error": True}
        vm = vm_record.desktop_vm(desktop)
        folder = self.record["name"]
        try:
            newest = await asyncio.to_thread(self.copy_code, vm, folder)
        except Exception as error:
            return {"content": [{"type": "text", "text": f"Could not put the code in the VM: {error}"}], "is_error": True}
        text = (
            f"~/{folder} has {self.repo} with origin/* as on GitHub now; origin/HEAD (the default branch) is at {newest}. "
            "Start new work from it (git switch -c <branch> origin/HEAD); your own branches are as you left them."
        )
        return {"content": [{"type": "text", "text": text}]}

    def copy_code(self, vm, folder: str) -> str:
        """Clone the repo here with the user's sign-in, copy it into the VM as a bundle and fetch from that into folder
        (cloned from it the first time). Returns the default branch's newest commit, in one line. In a thread."""
        result = vm.exec("cd && pwd", 30)
        home = result.stdout.strip()
        if result.returncode != 0 or not home.startswith("/"):
            raise ValueError(f"the VM didn't say where your home is: {result.stderr.strip()}")
        bundle = f"code-{secrets.token_hex(3)}.bundle"
        # On this computer's disk, not in /tmp (memory).
        with tempfile.TemporaryDirectory(dir=DATA_DIR) as temporary:
            self.agents.your_repositories.clone(self.repo, f"{temporary}/code")
            made = subprocess.run(["git", "-C", f"{temporary}/code", "bundle", "create", f"{temporary}/{bundle}", "--all"], capture_output=True, text=True, env=GIT_ENV, timeout=600)
            if made.returncode != 0:
                raise ValueError(f"git bundle failed: {made.stderr.strip()[-500:]}")
            to_vm(vm, f"{temporary}/{bundle}", home)
        quoted = shlex.quote(folder)
        script = (
            f"set -e; cd; if [ ! -d {quoted} ]; then git clone -q {bundle} {quoted}; "
            f"git -C {quoted} remote set-url origin https://github.com/{self.repo}.git; fi; "
            f"git -C {quoted} fetch -q --prune {bundle} '+refs/remotes/origin/*:refs/remotes/origin/*'; rm -f {bundle}; "
            f"git -C {quoted} log -1 --format='%h %s (%cr)' origin/HEAD"
        )
        result = vm.exec(script, 600)
        if result.returncode != 0:
            vm.exec(f"rm -f {bundle}", 30)
            raise ValueError(result.stderr.strip()[-500:])
        return result.stdout.strip()

    async def deny_issue(self, args: dict) -> dict:
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        if job["status"] in ["done", "cancelled"]:
            return {"content": [{"type": "text", "text": f"{job['id']} is {job['status']} already."}], "is_error": True}
        if job["issue"] is None or job["repo"] is None or job["repo"].lower() != self.repo.lower():
            return {"content": [{"type": "text", "text": f"{job['id']} isn't about an issue of {self.repo}."}], "is_error": True}
        kind = args.get("kind")
        why = (args.get("why") or "").strip()
        if kind not in DENY_KINDS:
            return {"content": [{"type": "text", "text": f"kind must be one of: {', '.join(DENY_KINDS)}."}], "is_error": True}
        if not why:
            return {"content": [{"type": "text", "text": "Say why, for the people who read the issue."}], "is_error": True}
        found = EMOJI.findall(why)
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        number = int(job["issue"].split("#")[1])
        comment = f"Closed as not planned by the project's agent: {DENY_KINDS[kind]}.\n\n{why}"
        try:
            await asyncio.to_thread(self.agents.projects.close_issue, self.repo, number, comment)
        except (ValueError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not close #{number}: {error}"}], "is_error": True}
        self.agents.projects.set_issue(self.repo, number, {"state": "denied", "kind": kind, "why": why})
        self.agents.jobs.update(job["id"], status="cancelled", notes=f"Denied ({kind}): {why}")
        text = f"#{number} is closed as not planned, with your reason, and {job['id']} is over. If the user reopens it, a worker takes it again."
        vm_name, place = self.agents.queue.place(self.agent_id)
        left = [other for other in self.agents.jobs.for_agent(self.agent_id) if other["status"] in ["queued", "working"] and other["vm"] == vm_name]
        if place == 0 and not left:
            text += f" You have no open jobs left for {vm_name}: call release_vm now."
        return {"content": [{"type": "text", "text": text}]}

    async def review_read(self, args: dict) -> dict:
        try:
            draft = self.agents.inbox.get(args["draft_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No draft {args['draft_id']}."}], "is_error": True}
        if draft["review"] is None or draft["review"]["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{draft['id']} wasn't given to you to review."}], "is_error": True}
        tests = {"before": None, "after": None}
        if draft["job"] is not None:
            try:
                tests = self.agents.jobs.get(draft["job"])["tests"]
            except KeyError:
                pass
        author = self.agents.agents.get(draft["agent"])
        diff = draft["diff"]
        cut = len(diff) > REVIEW_DIFF_CHARS
        report = {
            "id": draft["id"],
            "author": author.name if author is not None else draft["agent"],
            "for": draft["target"],
            "replaces": draft["replaces"],
            "title": draft["title"],
            "body": draft["body"],
            "overview": draft["overview"],
            "branch": draft["branch"],
            "base": draft["base"],
            "base_sha": draft["base_sha"],
            "commits": [commit["message"] for commit in draft["commits"]],
            "tests": tests,
            "evidence": [],
        }
        for item in draft["evidence"]:
            each = {key: item.get(key) for key in ["id", "kind", "stage", "topic", "context", "caption", "command", "exit_code", "output_tail"]}
            report["evidence"].append(each)
        text = json.dumps(report) + "\n\nThe diff" + (f" (cut at {REVIEW_DIFF_CHARS:,} characters; all of it is in the VM's file)" if cut else "") + ":\n" + diff[:REVIEW_DIFF_CHARS]

        # The diff as a file in the VM, while it holds one: to apply on base_sha and run the tests on.
        vm_name = self.record["target_vm"]
        desktop = None
        vm_record = None
        if vm_name is not None:
            try:
                vm_record = self.agents.vms.get(vm_name)
                desktop = vm_record.holding(self.agent_id)
            except VMsError:
                desktop = None
        if desktop is not None:
            vm = vm_record.desktop_vm(desktop)
            name = f"review-{draft['id']}.diff"
            body = diff if diff.endswith("\n") else diff + "\n"
            try:
                result = await asyncio.to_thread(vm.exec, f"cat > {name}", 120, body)
                if result.returncode == 0:
                    text += f"\n\nThe diff is in ~/{name}: `git -C ~/<folder> switch --detach {draft['base_sha']} && git -C ~/<folder> apply ~/{name}`."
            except Exception as error:
                text += f"\n\nThe diff couldn't be put in the VM: {error}"

        content = [{"type": "text", "text": text}]
        for item in draft["evidence"]:
            if item["kind"] not in ["screenshot", "image"] or not item.get("file"):
                continue
            ending = item["file"].rsplit(".", 1)[-1]
            path = EVIDENCE_DIR / item["file"]
            if ending not in PICTURE_TYPES or not path.is_file():
                continue
            data = await asyncio.to_thread(path.read_bytes)
            content.append({"type": "text", "text": f"{item['id']}, {item['stage']}, {item['topic']}: {item['caption']}"})
            content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": PICTURE_TYPES[ending]})
        return {"content": content}

    async def review_done(self, args: dict) -> dict:
        try:
            draft = self.agents.inbox.get(args["draft_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No draft {args['draft_id']}."}], "is_error": True}
        if draft["review"] is None or draft["review"]["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{draft['id']} wasn't given to you to review."}], "is_error": True}
        if draft["review"]["state"] != "waiting" or draft["status"] != "pending":
            return {"content": [{"type": "text", "text": f"{draft['id']} has its verdict already."}], "is_error": True}
        verdict = args.get("verdict")
        notes = (args.get("notes") or "").strip()
        if verdict not in ["pass", "changes"]:
            return {"content": [{"type": "text", "text": "verdict must be pass or changes."}], "is_error": True}
        if not notes:
            return {"content": [{"type": "text", "text": "Write your notes: what you checked, or what must change."}], "is_error": True}
        found = EMOJI.findall(notes)
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        self.agents.review_finished(draft["id"], verdict == "pass", notes)
        text = f"{draft['id']} went to the user's Inbox with your notes."
        if verdict == "changes":
            text = f"{draft['id']} went back to its author with your notes; its next draft comes to you again."
        vm_name, place = self.agents.queue.place(self.agent_id)
        left = [other for other in self.agents.jobs.for_agent(self.agent_id) if other["status"] in ["queued", "working"] and other["vm"] == vm_name]
        if place == 0 and not left:
            text += f" You have no open jobs left for {vm_name}: call release_vm now."
        return {"content": [{"type": "text", "text": text}]}
