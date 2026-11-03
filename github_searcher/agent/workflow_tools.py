"""The Workflow tab's agents' own tools (github_searcher/workflow.py): its chat agent's, its workers' and its review
agent's. Only an agent whose record has "workflow" (the repo) gets them, by its "workflow_role" (agent.py):

- workflow_status (all three): the repository as its Workflow page shows it: its settings, what each worker is on, its
  issues and its pull requests with their reviews and decisions.
- issue_create (all three): a new issue, one clearly confined goal with its requirements and how to check it is done.
  On GitHub (prs_on "github") it opens there as the user; in Seraph it stays here. A worker or the review agent names
  the issue or pull request it found it while working on (found_in): what it finds on the way is never part of its own
  work.
- issue_close (the chat agent, and a worker for its own job's issue): closed with a reason (REASONS) and why; a worker's
  job on it ends.
- issue_scope (a worker): an issue someone wrote without requirements (yours, or one opened on GitHub) gets its goal,
  requirements and how to check from its worker before any work, from what it says and nothing more.
- sync_code (a worker and the review agent): the newest code in its own folder in the VM, ~/<its name>, with GitHub's
  branches as origin/* and every pull request opened on GitHub as origin/pr/<its GitHub number>. The VM can't reach the
  repo: the app clones it here with the user's sign-in and copies it in as a git bundle, so the token never enters it.
- pr_read and pr_review (the review agent): a pull request as the user would see it, then the advice on it: merge or
  don't merge, what changes in one line, what the user must know, and what it ran. The pull request then waits for the
  decision, or, when the review agent decides (decides "agent"), backend/workflow_api.py carries the advice out.
A worker's pull request is draft_pr (work_tools.py), which hands it to Workflow.add_pr instead of the Inbox.

    tools = WorkflowTools(agents, record).list()
"""

import asyncio
import base64
import json
import secrets
import shlex
import subprocess
import tempfile
from datetime import UTC, datetime

import httpx
from claude_agent_sdk import tool

from github_searcher.agent.project_tools import PICTURE_TYPES, REVIEW_DIFF_CHARS
from github_searcher.agent.work_tools import EMOJI, NO_EMOJI
from github_searcher.github_account import GIT_ENV
from github_searcher.jobs import EVIDENCE_DIR
from github_searcher.workflow import DATA_DIR, REASONS
from sandbox.file_transfer import to_vm
from sandbox.vms import VMsError

# How an issue is written: short, so each is one confined piece of work.
TITLE_CHARS = 80
GOAL_CHARS = 300
REQUIREMENTS_MAX = 8
REQUIREMENT_CHARS = 200
VALIDATION_CHARS = 600
# The reasons an agent may close an issue for (the others are the app's and the user's).
AGENT_REASONS = ["duplicate", "not_valid", "cannot_reproduce", "too_big"]
# A review's parts.
SUMMARY_CHARS = 200
IMPORTANT_MAX = 6
IMPORTANT_CHARS = 300
CHECKED_CHARS = 800
# git clone of a big repo, and fetching its pull requests, may take a while.
FETCH_SECONDS = 600


class WorkflowTools:
    def __init__(self, agents, record: dict):
        # The Agents manager: workflow (github_searcher/workflow.py), jobs, the VMs and your_repositories (the user's sign-in).
        self.agents = agents
        # The agent's record (the same dict): "workflow" is its repository, "workflow_role" what it is there.
        self.record = record
        self.agent_id = record["id"]

    def list(self) -> list:
        repo = self.record.get("workflow")
        role = self.record.get("workflow_role")
        if repo is None:
            return []
        names = {"type": "array", "items": {"type": "string"}}
        status = tool(
            "workflow_status",
            f"See {repo} as the user sees it on its Workflow page: where its issues and pull requests live (Seraph or GitHub), "
            "who decides on merging (the user, or the review agent), what each worker is on, every open issue in full, the "
            "pull requests with their reviews and decisions, and the latest closed ones.",
            {},
        )(self.workflow_status)
        create = tool(
            "issue_create",
            f"Create an issue in {repo}: one clearly confined goal, small enough for one pull request, that a worker can do, "
            "test and stop at. title: short and plain. goal: one sentence, what is different for the user once it is done. "
            f"requirements: 1 to {REQUIREMENTS_MAX}, each one thing that must be true, checkable on its own. validation: how "
            "to check it is done, step by step, the way someone using the app would see it (what to open, do and see). "
            "found_in: the issue or pull request number you found it while working on, when you did. It is created at once "
            "(on GitHub as the user, when the repo's issues are there) and a worker takes it. No emoji.",
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "goal": {"type": "string"},
                    "requirements": names,
                    "validation": {"type": "string"},
                    "found_in": {"type": "integer"},
                },
                "required": ["title", "goal", "requirements", "validation"],
            },
        )(self.issue_create)
        close = tool(
            "issue_close",
            f"Close an issue of {repo}, with the reason and why. reason: duplicate (it repeats another issue or work that is "
            "done), not_valid (wrong, or too vague to act on), cannot_reproduce (it doesn't happen on the newest code), "
            "too_big (more than one pull request: create the smaller issues first, each with found_in this one). why: 1 to "
            "3 sentences, specific (the numbers it repeats, what you ran). A worker closes only its own job's issue, and its "
            "job ends.",
            {
                "type": "object",
                "properties": {"number": {"type": "integer"}, "reason": {"type": "string", "enum": AGENT_REASONS}, "why": {"type": "string"}},
                "required": ["number", "reason", "why"],
            },
        )(self.issue_close)
        sync_code = tool(
            "sync_code",
            f"Put the newest code of {repo} in your own folder in the VM, ~/{self.record['name']} (only while you hold the VM): "
            "made the first time, and every time after, origin/* is brought up to date with GitHub's branches (origin/HEAD is "
            "the default branch), and every pull request opened on GitHub is origin/pr/<its GitHub number>. The VM can't "
            "reach the repo itself, so this is the only way to get it. Your own branches and changes stay as they are.",
            {},
        )(self.sync_code)
        if role == "chat":
            return [status, create, close]
        if role == "worker":
            scope = tool(
                "issue_scope",
                "Write down your job's issue before any work, when it has no requirements yet (the user wrote it, or it was "
                "opened on GitHub): goal (one sentence), requirements (1 to "
                f"{REQUIREMENTS_MAX}, each checkable on its own) and validation (how to check it is done), taken from what "
                "the issue says and nothing more. They are what you do and when you stop. When it is more than one pull "
                "request, don't: create the smaller issues and close this one as too_big.",
                {
                    "type": "object",
                    "properties": {"job_id": {"type": "string"}, "goal": {"type": "string"}, "requirements": names, "validation": {"type": "string"}},
                    "required": ["job_id", "goal", "requirements", "validation"],
                },
            )(self.issue_scope)
            return [status, sync_code, scope, create, close]
        if role == "reviewer":
            read = tool(
                "pr_read",
                f"Read a pull request of {repo} you were given to review, by number: its issue (goal, requirements, how to "
                "check), title and text, the worker's overview with its checklist, its commits, test runs and evidence with "
                "the pictures, the files it changes and the diff. While you hold the VM, the diff is also put in "
                "~/review-<number>.diff, and it says how to get the pull request's code in your folder.",
                {"number": int},
            )(self.pr_read)
            review = tool(
                "pr_review",
                "Your review of a pull request, once you ran it and saw its effect. advice: merge or dont_merge. summary: what "
                f"changes for someone using the app, one plain line (under {SUMMARY_CHARS} characters). important: what the "
                f"user must know before deciding, up to {IMPORTANT_MAX} points, plain words (for dont_merge, every reason; "
                "leave it empty when there is nothing). checked: what you ran and saw, in a few plain lines. Your own pictures "
                "(evidence_add on your review job) go with it. No emoji.",
                {
                    "type": "object",
                    "properties": {
                        "number": {"type": "integer"},
                        "advice": {"type": "string", "enum": ["merge", "dont_merge"]},
                        "summary": {"type": "string"},
                        "important": names,
                        "checked": {"type": "string"},
                    },
                    "required": ["number", "advice", "summary", "important", "checked"],
                },
            )(self.pr_review)
            return [status, sync_code, read, review, create]
        return []

    def describe(self, name: str, args: dict) -> str | None:
        """The chat's line for a call of these tools, or None for another tool."""
        if name == "workflow_status":
            return "Looked at the repository's workflow"
        if name == "issue_create":
            return f"New issue: {args.get('title')}"
        if name == "issue_close":
            return f"Closing #{args.get('number')}: {str(args.get('reason') or '').replace('_', ' ')}"
        if name == "issue_scope":
            return f"Writing down the issue of {args.get('job_id')}"
        if name == "sync_code" and self.record.get("workflow") is not None:
            return "Getting the newest code into the VM"
        if name == "pr_read":
            return f"Reading pull request #{args.get('number')} to review it"
        if name == "pr_review":
            return f"Review of #{args.get('number')}: {'merge' if args.get('advice') == 'merge' else 'do not merge'}"
        return None

    async def workflow_status(self, args: dict) -> dict:
        repo = self.record["workflow"]
        record = self.agents.workflow.get(repo)
        if record is None:
            return {"content": [{"type": "text", "text": f"{repo} isn't on the Workflow tab anymore."}], "is_error": True}
        workers = []
        for agent_id in record["workers"]:
            agent = self.agents.agents.get(agent_id)
            if agent is None:
                continue
            jobs = []
            for job in self.agents.jobs.for_agent(agent_id):
                if job["status"] in ["queued", "working", "waiting_on_user"]:
                    jobs.append({"id": job["id"], "title": job["title"], "status": job["status"], "step": job["step"], "headline": job["headline"]})
            workers.append({"name": agent.name, "jobs": jobs})
        issues = sorted(record["issues"].values(), key=lambda issue: issue["number"])
        prs = sorted(record["prs"].values(), key=lambda pr: pr["number"])
        status = {
            "repo": repo,
            "issues_and_prs": "kept in Seraph" if record["prs_on"] == "seraph" else "on GitHub",
            "decides": "the user" if record["decides"] == "you" else "the review agent",
            "taking_new_issues": record["on"],
            "workers": workers,
            "open_issues": [issue for issue in issues if issue["state"] == "open"],
            "closed_issues": [{key: issue[key] for key in ["number", "title", "reason", "why"]} for issue in issues if issue["state"] == "closed"][-30:],
            "open_prs": [],
            "closed_prs": [],
        }
        for pr in prs:
            brief = {key: pr[key] for key in ["number", "title", "state", "issue", "area", "added", "removed", "decision"]}
            brief["by"] = "the user" if pr["by"] == "you" else (self.agents.agents[pr["by"]].name if pr["by"] in self.agents.agents else pr["by"])
            if pr["review"] is not None:
                brief["review"] = {key: pr["review"][key] for key in ["advice", "summary", "important"]}
            if pr["state"] in ["review", "waiting"]:
                status["open_prs"].append(brief)
            else:
                status["closed_prs"].append(brief)
        status["closed_prs"] = status["closed_prs"][-30:]
        return {"content": [{"type": "text", "text": json.dumps(status)}]}

    async def issue_create(self, args: dict) -> dict:
        repo = self.record["workflow"]
        record = self.agents.workflow.get(repo)
        if record is None:
            return {"content": [{"type": "text", "text": f"{repo} isn't on the Workflow tab anymore."}], "is_error": True}
        title = (args.get("title") or "").strip()
        goal = (args.get("goal") or "").strip()
        validation = (args.get("validation") or "").strip()
        requirements = [str(item).strip() for item in (args.get("requirements") or []) if str(item).strip()]
        if not title or len(title) > TITLE_CHARS:
            return {"content": [{"type": "text", "text": f"Give a title, under {TITLE_CHARS} characters."}], "is_error": True}
        if not goal or len(goal) > GOAL_CHARS:
            return {"content": [{"type": "text", "text": f"Give the goal in one sentence, under {GOAL_CHARS} characters."}], "is_error": True}
        if not requirements or len(requirements) > REQUIREMENTS_MAX:
            text = f"Give 1 to {REQUIREMENTS_MAX} requirements. More than that is more than one pull request: split it into issues that each stand on their own."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        for item in requirements:
            if len(item) > REQUIREMENT_CHARS:
                return {"content": [{"type": "text", "text": f"Keep each requirement under {REQUIREMENT_CHARS} characters: one thing that must be true."}], "is_error": True}
        if not validation or len(validation) > VALIDATION_CHARS:
            return {"content": [{"type": "text", "text": f"Say how to check it is done, under {VALIDATION_CHARS} characters."}], "is_error": True}
        found = EMOJI.findall(" ".join([title, goal, validation] + requirements))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        found_in = args.get("found_in")
        if found_in is not None and str(found_in) not in record["issues"] and str(found_in) not in record["prs"]:
            return {"content": [{"type": "text", "text": f"found_in: {repo} has no issue or pull request #{found_in}."}], "is_error": True}
        for issue in record["issues"].values():
            if issue["state"] == "open" and issue["title"].strip().lower() == title.lower():
                return {"content": [{"type": "text", "text": f"#{issue['number']} is open with that title already: {issue['goal']}"}], "is_error": True}
        fields = {"title": title, "goal": goal, "requirements": requirements, "validation": validation, "by": self.agent_id, "found_in": found_in}
        try:
            issue = await asyncio.to_thread(self.agents.workflow.add_issue, repo, fields)
        except (ValueError, KeyError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not create the issue: {error}"}], "is_error": True}
        self.agents.workflow.wake()
        text = f"Created #{issue['number']}: {title}. A worker takes it."
        if issue["url"] is not None:
            text = f"Created #{issue['number']} on GitHub: {issue['url']}. A worker takes it."
        if self.record.get("workflow_role") != "chat":
            text += " Don't work on it yourself: go on with your own job."
        return {"content": [{"type": "text", "text": text}]}

    async def issue_close(self, args: dict) -> dict:
        repo = self.record["workflow"]
        record = self.agents.workflow.get(repo)
        if record is None:
            return {"content": [{"type": "text", "text": f"{repo} isn't on the Workflow tab anymore."}], "is_error": True}
        number = args.get("number")
        reason = args.get("reason")
        why = (args.get("why") or "").strip()
        issue = record["issues"].get(str(number))
        if issue is None or issue["state"] != "open":
            return {"content": [{"type": "text", "text": f"#{number} isn't an open issue of {repo}."}], "is_error": True}
        if reason not in AGENT_REASONS:
            return {"content": [{"type": "text", "text": f"reason must be one of: {', '.join(AGENT_REASONS)}."}], "is_error": True}
        if not why:
            return {"content": [{"type": "text", "text": "Say why, specific: the numbers it repeats, what you ran."}], "is_error": True}
        found = EMOJI.findall(why)
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        if self.record.get("workflow_role") == "worker" and issue["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"#{number} isn't your job's issue: only its own worker closes it."}], "is_error": True}
        open_prs = [pr for pr in record["prs"].values() if pr["issue"] == number and pr["state"] in ["review", "waiting"]]
        if open_prs:
            return {"content": [{"type": "text", "text": f"#{number} has pull request #{open_prs[0]['number']} waiting: it is up to the user now."}], "is_error": True}
        comment = f"Closed by the agent: {REASONS[reason]}.\n\n{why}"
        try:
            await asyncio.to_thread(self.agents.workflow.close_issue, repo, number, reason, comment if issue["url"] is not None else why)
        except (ValueError, KeyError, httpx.HTTPError) as error:
            return {"content": [{"type": "text", "text": f"Could not close #{number}: {error}"}], "is_error": True}
        self.agents.workflow.set_issue(repo, number, {"why": why})
        # Its job ends; when it isn't this agent's own, its worker hears so.
        if issue["job"] is not None:
            try:
                job = self.agents.jobs.get(issue["job"])
                if job["status"] not in ["done", "cancelled"]:
                    self.agents.jobs.update(job["id"], status="cancelled", notes=f"Closed ({reason}): {why}")
                    if job["agent"] != self.agent_id:
                        self.agents.notify(job["agent"], f"#{number} was closed ({reason.replace('_', ' ')}): {why}\nSo {job['id']} is cancelled: stop working on it.")
            except KeyError:
                pass
        self.agents.workflow.wake()
        text = f"#{number} is closed: {REASONS[reason]}."
        if self.record.get("workflow_role") == "worker":
            vm_name, place = self.agents.queue.place(self.agent_id)
            left = [other for other in self.agents.jobs.for_agent(self.agent_id) if other["status"] in ["queued", "working"] and other["vm"] == vm_name]
            if place == 0 and not left:
                text += f" You have no open jobs left for {vm_name}: call release_vm now."
        return {"content": [{"type": "text", "text": text}]}

    async def issue_scope(self, args: dict) -> dict:
        repo = self.record["workflow"]
        try:
            job = self.agents.jobs.get(args["job_id"])
        except KeyError:
            return {"content": [{"type": "text", "text": f"No job {args['job_id']}."}], "is_error": True}
        if job["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"{job['id']} is not your job."}], "is_error": True}
        record = self.agents.workflow.get(repo)
        issue = None
        if record is not None:
            for each in record["issues"].values():
                if each["job"] == job["id"]:
                    issue = each
        if issue is None:
            return {"content": [{"type": "text", "text": f"{job['id']} isn't about an issue of {repo}."}], "is_error": True}
        if issue["requirements"]:
            return {"content": [{"type": "text", "text": f"#{issue['number']} has its requirements already: keep to them."}], "is_error": True}
        goal = (args.get("goal") or "").strip()
        validation = (args.get("validation") or "").strip()
        requirements = [str(item).strip() for item in (args.get("requirements") or []) if str(item).strip()]
        if not goal or len(goal) > GOAL_CHARS:
            return {"content": [{"type": "text", "text": f"Give the goal in one sentence, under {GOAL_CHARS} characters."}], "is_error": True}
        if not requirements or len(requirements) > REQUIREMENTS_MAX:
            text = f"Give 1 to {REQUIREMENTS_MAX} requirements. More than that is more than one pull request: create the smaller issues and close this one as too_big."
            return {"content": [{"type": "text", "text": text}], "is_error": True}
        for item in requirements:
            if len(item) > REQUIREMENT_CHARS:
                return {"content": [{"type": "text", "text": f"Keep each requirement under {REQUIREMENT_CHARS} characters."}], "is_error": True}
        if not validation or len(validation) > VALIDATION_CHARS:
            return {"content": [{"type": "text", "text": f"Say how to check it is done, under {VALIDATION_CHARS} characters."}], "is_error": True}
        found = EMOJI.findall(" ".join([goal, validation] + requirements))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}
        self.agents.workflow.set_issue(repo, issue["number"], {"goal": goal, "requirements": requirements, "validation": validation})
        lines = [f"Goal: {goal}", "Requirements:"] + [f"- {item}" for item in requirements] + [f"How to check: {validation}"]
        self.agents.jobs.update(job["id"], instructions="\n".join(lines))
        return {"content": [{"type": "text", "text": f"#{issue['number']} is written down. Do exactly that, and stop there."}]}

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
            f"~/{folder} has {self.record['workflow']} with origin/* as on GitHub now (pull requests opened there are "
            f"origin/pr/<number>); origin/HEAD (the default branch) is at {newest}. Start new work from it "
            "(git switch -c <branch> origin/HEAD); your own branches are as you left them."
        )
        return {"content": [{"type": "text", "text": text}]}

    def copy_code(self, vm, folder: str) -> str:
        """Clone the repo here with the user's sign-in, with its pull requests, copy it into the VM as a bundle and fetch
        from that into folder (cloned from it the first time). Returns the default branch's newest commit, in one line.
        In a thread."""
        repo = self.record["workflow"]
        result = vm.exec("cd && pwd", 30)
        home = result.stdout.strip()
        if result.returncode != 0 or not home.startswith("/"):
            raise ValueError(f"the VM didn't say where your home is: {result.stderr.strip()}")
        token = self.agents.your_repositories.token()
        if token is None:
            raise ValueError("the user isn't signed in to GitHub (the GitHub tab, Account)")
        bundle = f"code-{secrets.token_hex(3)}.bundle"
        # On this computer's disk, not in /tmp (memory).
        with tempfile.TemporaryDirectory(dir=DATA_DIR) as temporary:
            self.agents.your_repositories.clone(repo, f"{temporary}/code")
            # The pull requests, as your_repositories.clone signs in: the token in git's settings from the environment, for
            # this command only, never on its command line.
            basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
            env = dict(GIT_ENV)
            env["GIT_TERMINAL_PROMPT"] = "0"
            env["GIT_CONFIG_COUNT"] = "1"
            env["GIT_CONFIG_KEY_0"] = "http.https://github.com/.extraheader"
            env["GIT_CONFIG_VALUE_0"] = f"Authorization: Basic {basic}"
            fetched = subprocess.run(
                ["git", "-C", f"{temporary}/code", "fetch", "-q", "origin", "+refs/pull/*/head:refs/remotes/origin/pr/*"],
                capture_output=True,
                stdin=subprocess.DEVNULL,
                text=True,
                env=env,
                timeout=FETCH_SECONDS,
            )
            if fetched.returncode != 0:
                raise ValueError(f"git fetch of the pull requests failed: {fetched.stderr.strip()[-500:]}")
            made = subprocess.run(["git", "-C", f"{temporary}/code", "bundle", "create", f"{temporary}/{bundle}", "--all"], capture_output=True, text=True, env=GIT_ENV, timeout=FETCH_SECONDS)
            if made.returncode != 0:
                raise ValueError(f"git bundle failed: {made.stderr.strip()[-500:]}")
            to_vm(vm, f"{temporary}/{bundle}", home)
        quoted = shlex.quote(folder)
        script = (
            f"set -e; cd; if [ ! -d {quoted} ]; then git clone -q {bundle} {quoted}; "
            f"git -C {quoted} remote set-url origin https://github.com/{repo}.git; fi; "
            f"git -C {quoted} fetch -q --prune {bundle} '+refs/remotes/origin/*:refs/remotes/origin/*'; rm -f {bundle}; "
            f"git -C {quoted} log -1 --format='%h %s (%cr)' origin/HEAD"
        )
        result = vm.exec(script, FETCH_SECONDS)
        if result.returncode != 0:
            vm.exec(f"rm -f {bundle}", 30)
            raise ValueError(result.stderr.strip()[-500:])
        return result.stdout.strip()

    async def pr_read(self, args: dict) -> dict:
        repo = self.record["workflow"]
        record = self.agents.workflow.get(repo)
        number = args.get("number")
        pr = None
        if record is not None:
            pr = record["prs"].get(str(number))
        if pr is None:
            return {"content": [{"type": "text", "text": f"{repo} has no pull request #{number}."}], "is_error": True}
        if pr["review"] is None or pr["review"]["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"#{number} wasn't given to you to review."}], "is_error": True}
        parts = await asyncio.to_thread(self.agents.workflow.parts, pr["id"])
        issue = None
        if pr["issue"] is not None:
            issue = record["issues"].get(str(pr["issue"]))
        author = "the user, by hand on GitHub"
        if pr["by"] in self.agents.agents:
            author = self.agents.agents[pr["by"]].name
        diff = parts.get("diff", "")
        report = {
            "number": pr["number"],
            "by": author,
            "title": pr["title"],
            "body": parts.get("body", ""),
            "issue": issue,
            "overview": parts.get("overview"),
            "tests": parts.get("tests"),
            "commits": [commit["message"] for commit in parts.get("commits", [])],
            "base_sha": parts.get("base_sha"),
            "files": pr["files"],
            "evidence": [],
        }
        for item in parts.get("evidence", []):
            report["evidence"].append({key: item.get(key) for key in ["id", "kind", "stage", "topic", "context", "caption", "command", "exit_code", "output_tail"]})
        cut = len(diff) > REVIEW_DIFF_CHARS
        text = json.dumps(report) + "\n\nThe diff" + (f" (cut at {REVIEW_DIFF_CHARS:,} characters; all of it is in the VM's file)" if cut else "") + ":\n" + diff[:REVIEW_DIFF_CHARS]

        # The pull request's code, in the VM it holds: the worker's diff on its own commit, or the branch on GitHub.
        vm_name = self.record["target_vm"]
        desktop = None
        vm_record = None
        if vm_name is not None:
            try:
                vm_record = self.agents.vms.get(vm_name)
                desktop = vm_record.holding(self.agent_id)
            except VMsError:
                desktop = None
        folder = f"~/{self.record['name']}"
        if desktop is not None and pr["github"] is not None:
            text += f"\n\nIts code is on GitHub: sync_code, then `git -C {folder} switch --detach origin/pr/{pr['github']}`."
        if desktop is not None and pr["github"] is None and diff:
            vm = vm_record.desktop_vm(desktop)
            name = f"review-{pr['number']}.diff"
            body = diff if diff.endswith("\n") else diff + "\n"
            try:
                result = await asyncio.to_thread(vm.exec, f"cat > {name}", 120, body)
                if result.returncode == 0:
                    text += f"\n\nThe diff is in ~/{name}: sync_code, then `git -C {folder} switch --detach {parts.get('base_sha')} && git -C {folder} apply ~/{name}`."
            except Exception as error:
                text += f"\n\nThe diff couldn't be put in the VM: {error}"
        if desktop is None:
            text += "\n\nYou don't hold the VM: queue_for_vm, then pr_read again for its code."

        content = [{"type": "text", "text": text}]
        for item in parts.get("evidence", []):
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

    async def pr_review(self, args: dict) -> dict:
        repo = self.record["workflow"]
        record = self.agents.workflow.get(repo)
        number = args.get("number")
        pr = None
        if record is not None:
            pr = record["prs"].get(str(number))
        if pr is None:
            return {"content": [{"type": "text", "text": f"{repo} has no pull request #{number}."}], "is_error": True}
        if pr["review"] is None or pr["review"]["agent"] != self.agent_id:
            return {"content": [{"type": "text", "text": f"#{number} wasn't given to you to review."}], "is_error": True}
        if pr["state"] != "review":
            return {"content": [{"type": "text", "text": f"#{number} has its review already ({pr['state']})."}], "is_error": True}
        advice = args.get("advice")
        summary = (args.get("summary") or "").strip()
        checked = (args.get("checked") or "").strip()
        important = [str(item).strip() for item in (args.get("important") or []) if str(item).strip()]
        if advice not in ["merge", "dont_merge"]:
            return {"content": [{"type": "text", "text": "advice must be merge or dont_merge."}], "is_error": True}
        if not summary or len(summary) > SUMMARY_CHARS:
            return {"content": [{"type": "text", "text": f"Give the summary: what changes for someone using the app, one plain line under {SUMMARY_CHARS} characters."}], "is_error": True}
        if not checked or len(checked) > CHECKED_CHARS:
            return {"content": [{"type": "text", "text": f"Say what you ran and saw, under {CHECKED_CHARS} characters."}], "is_error": True}
        if advice == "dont_merge" and not important:
            return {"content": [{"type": "text", "text": "Say why not in important: every reason, one point each."}], "is_error": True}
        if len(important) > IMPORTANT_MAX:
            return {"content": [{"type": "text", "text": f"At most {IMPORTANT_MAX} important points: only what the user must know to decide."}], "is_error": True}
        for item in important:
            if len(item) > IMPORTANT_CHARS:
                return {"content": [{"type": "text", "text": f"Keep each important point under {IMPORTANT_CHARS} characters."}], "is_error": True}
        found = EMOJI.findall(" ".join([summary, checked] + important))
        if found:
            return {"content": [{"type": "text", "text": NO_EMOJI + " ".join(sorted(set(found)))}], "is_error": True}

        evidence = []
        job_id = pr["review"]["job"]
        if job_id is not None:
            try:
                evidence = self.agents.jobs.get(job_id)["evidence"]
            except KeyError:
                evidence = []
        review = dict(pr["review"])
        review.update({"advice": advice, "summary": summary, "important": important, "checked": checked, "evidence": evidence, "at": datetime.now(UTC).isoformat()})
        self.agents.workflow.set_pr(repo, pr["number"], {"state": "waiting", "review": review})
        if job_id is not None:
            try:
                verdict = "Merge" if advice == "merge" else "Don't merge"
                self.agents.jobs.update(job_id, status="done", notes=f"{verdict}: {summary}")
            except KeyError:
                pass

        # On GitHub the review is a comment on the pull request, as the user: the repo keeps its messages there.
        if record["prs_on"] == "github" and pr["github"] is not None:
            lines = [f"**Review agent: {'merge' if advice == 'merge' else 'do not merge'}**", "", summary]
            if important:
                lines += ["", "Important:"] + [f"- {item}" for item in important]
            lines += ["", f"Checked: {checked}"]
            try:
                await asyncio.to_thread(self.agents.workflow.comment, repo, pr["github"], "\n".join(lines))
            except (ValueError, httpx.HTTPError):
                # The review is kept here either way; GitHub missing it only costs the comment.
                pass
        self.agents.workflow.wake()

        text = f"Your review of #{pr['number']} is with the user, who decides."
        if record["decides"] == "agent":
            text = f"The review agent decides on {repo}: your advice on #{pr['number']} is carried out now."
        vm_name, place = self.agents.queue.place(self.agent_id)
        left = [other for other in self.agents.jobs.for_agent(self.agent_id) if other["status"] in ["queued", "working"] and other["vm"] == vm_name]
        if place == 0 and not left:
            text += f" You have no open jobs left for {vm_name}: call release_vm now."
        return {"content": [{"type": "text", "text": text}]}
