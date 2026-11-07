"""The Inbox: drafts agents write for the user, and the user's decisions on them. It is on the header's
GitHub tab (#/inbox).

Agents never send anything to GitHub. A pull request, a comment or a question becomes a draft
here, and the user approves, rejects, or replies to it (the agent then keeps working).
Approving tells the agent. With the user's GitHub account connected (the GitHub tab, Account; github_account.py),
Approve on a PR or comment also sends it to GitHub as them, first; "sent" then says what went out
(mark_sent). Each draft is one JSON file, DATA_DIR/inbox/<id>.json:

    {"id": "draft_a1b2c3", "kind": "pr" | "comment" | "question" | "report" | "edit" | "taken" (old) | ..., "agent": "<agent id>",
     "job": "job_..." | null, "repo": "owner/name" | null, "target": "owner/name#n" | null,
     "title", "body": "markdown",
     "diff": "unified diff (pr only)", "branch": "branch in the VM (pr only)", "base": "origin/main (pr only)",
     "base_sha": "the commit base was when drafted, where the diff starts (pr only; empty on older drafts)",
     "commits": [{"sha", "message", "author": {"name", "email", "date"}, "own": the agent's (by vm_email),
                  "vm_email", "diff"}, ...] (pr only: the branch's commits since base, replayed when it is sent),
     "vm": "vm1" | null, "path": "repo folder in the VM (pr only)" | null,
     "evidence": [Evidence, ...] (a copy of the job's, see jobs.py),
     "overview": {...} (for the user, see below), "template": ".github/pull_request_template.md" | null,
     "status": "pending" | "approved" | "rejected" | "replied", "reply": "the user's text",
     "created_at", "decided_at": null until decided, "sent": null | what went to GitHub (github_account.py),
     "update_of": "owner/name#n" | null (pr only: a new version of the user's open PR, see below),
     "rebase_of": "sha" | null (update_of only: the new version replaces the PR's commits, see below),
     "edited": bool (the user changed the title or text before deciding),
     "review": null | {"state": "waiting" | "passed" | "changes", "agent", "job", "notes", "at"} (pr only, see below),
     "replaces": "owner/name#n" | null (pr only: the older PR this one is made again of, see below),
     "previous": {"title", "body"} | null (edit only, see below),
     "options": ["what the user can pick", ...] (question only: [] when they answer in their own words),
     "recommended": "one of options" | null, "answer_by": ISO time | null, "must_wait": "money" | "sensitive" |
     "github" | "delete" | "open" | null, "answered_by": "user" | "timer" | null (question only, see below)}

"body" is what would be sent to GitHub; "overview" is only for the user, who doesn't know the
project: plain words on what is wrong and what the draft does about it.

A PR draft with "update_of" is the next version of a PR that is open already (a follow-up job: a reviewer asked
for changes, or its checks failed). Its commits start from the PR's newest commit (base_sha), "title" is the commit
message's subject and "body" the comment posted on the PR with them. Approve pushes them onto the PR's branch
instead of opening a new PR (github_account.py).

One with "rebase_of" too is a rebase: its commits replace the PR's instead of going on top (rebased onto the
project's newer main, or squashed, reworded or signed off as a reviewer asked). "rebase_of" is the PR's newest commit
when it was drafted, and "base_sha" the commit the rewritten branch starts from. Approve force-pushes them, only while
the PR's branch is still at "rebase_of".

edit() lets the user change a pending PR or comment draft's title and text before deciding (the Inbox and the GitHub
tab's thread pop-up). "edited" then says so, and its agent hears the final text with the decision (Agents.decide),
so it learns how the user wants it written.

    pr:      {"project", "problem", "cause", "fix", "risks": ["what could go wrong", ...],
              "checklist": [{"item": "a point that was asked", "done": bool, "how": "what shows it, or why not"}, ...],
              "also_tested": ["a case of the same kind beyond the asked example, and what came out", ...]}
    comment: {"project", "problem", "why"}  (why post this comment now)

"template" is the repo's PR template when a PR's body keeps all its headings (None: the repo has none, or the body
is written another way, as the project's merged PRs or the user's instructions have it).

"report" is an agent's report on a paper it reproduced (a reproduce_paper job, work_tools.py draft_report): "body" is the
full technical report, "diff" the agent's code (every file new), "path" its folder in the VM, and "overview" holds the
rest for the user: {"paper", "claims", "verdict", "results": [{"what", "paper", "ours", "authors", "note"}, ...],
"problems": [{"title", "what", "why", "evidence": "ev_..."}, ...], "unchecked": ["what couldn't be checked, and why"]}.
Approving it ends the job; nothing is sent anywhere.

Every PR draft is reviewed by a reviewer agent before you see it: a project's (github_searcher/projects.py: one of your
repositories agents develop all the time) by the project's reviewer, any other by that repo's own reviewer. "review" is
waiting until the reviewer's verdict (Agents.give_review, review_finished). Drafts from before every PR was reviewed
have none (null). passed: it shows in the Inbox, with the reviewer's notes. changes: it went back to its author and is
rejected with the reviewer's notes, so it never shows. The Inbox only lists drafts with no review or a passed one.
"replaces" is an older PR this one is made again of: a project's that conflicted with main (Agents.redo_pr), or one of
the agent's own that stalled, made again fresh with a clean history (Agents.remake_pr, or the agent's own call: draft_pr
replaces). Once this one is on GitHub, the old one is closed (github_account.py; backend/projects_api.py for a project's).

"edit" is a new title and description for one of the user's own PRs or issues (a follow-up: a maintainer asked for
it, or the text no longer matches the PR; work_tools.py draft_edit): "target" is it, "title" and "body" the new text,
"previous" the text as it was when drafted, "diff" the change between them (one part for the title, one for the
description), and "overview" {"project", "problem", "why"} like a comment's. Approve changes them on GitHub, only while
they are still "previous" (github_account.py).

A question can come with "options": the answers the agent offers. The Inbox shows each as a button, and picking one is
a reply with that answer (with the user's note, if any), so the agent always knows which one was meant.

A question with options also has "recommended", the one the agent would pick. Unless it must wait, it is timed:
"answer_by" is when the app answers it for the user (now plus the timer when it is asked), with the reply
"I pick: <recommended>" (Agents.answer_questions), and the agent goes on with that. "must_wait" says why one waits for
the user however long it takes: the agent marked it money, sensitive (politics and the like), github (how or what gets
sent there) or delete (what can't come back), or "open" for a question without options, answered in the user's own
words. The user's Settings (ASK_SETTINGS_FILE) set the timer and which of those four must wait: a question marked with
one that is switched off is timed. Changing them doesn't move the deadline of a question already asked.
"answered_by" says who answered it once it is decided: "user" (any decision of the user's), "timer", or "automation"
(its repo's or issue's Level of automation answers questions: at once, with the recommendation, unless it must wait).

A repo's Level of automation (AUTOMATION_FILE, set on the Dashboard: backend/repo_automation_api.py) lets drafts go
without the user: comments are posted, PRs (once their review passed) and edits sent, questions answered, as the user
would. Such a draft is in the Inbox only for the moments until the app acts on it (or longer when sending fails).
ISSUE_AUTOMATION_FILE holds an issue's own level, which goes over its repo's for its jobs' drafts.

    ask_settings.json: {"timer_minutes": TIMER_MINUTES (1 to 1440), "must_wait": MUST_WAIT or some of them}

"taken" was the one kind the app made, not the agent: an issue an agent has a job for went from free to assigned.
Now the agent is told and decides itself (Agents.issue_taken), so none are made anymore; the ones from before still
decide: approved means keep working, rejected means stop the agent (its job is cancelled). It takes no reply.

A draft is decided once. A decided draft can be deleted (the Inbox's Delete); a pending one can't, its agent waits
for the answer. Its job keeps the id (jobs.py "drafts"), and whoever reads one skips it once it is gone.

ACTIONS_FILE is the list of everything agents put on GitHub, oldest first, for the Dashboard's Pull requests, Actions
(GET /api/actions): each draft once it is sent (mark_sent), and what an agent does on GitHub itself (work_tools.py
open_issue and update_branch, add_action). It stays when the draft is deleted. The first time, it is made from the
drafts sent before it existed.

    actions.json: [{"draft": draft id | None, "kind": "pr" | "comment" | "edit" | "issue" | "update_branch",
                    "agent", "job": job id | None, "title",
                    "sent": {"url", "repo", "number", "at", ...: the draft's "sent", or the same four}}, ...]

The backend keeps one Inbox that the API and every agent share, so each method takes the
lock. version goes up by one on every change; the live feed compares it to see what to send.
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
DECISIONS = ["approved", "rejected", "replied"]
# Asking the user (Settings, backend/ask_settings_api.py): how long a timed question waits before the app answers it
# with the agent's recommendation, and the kinds of question that always wait for the user (all of them until the
# user switches some off). Read from the file each time it is needed; these are the defaults.
ASK_SETTINGS_FILE = DATA_DIR / "ask_settings.json"
# What goes without the user, by repo: {"owner/name": {"queue_issues", "take_issues", "questions", "comments", "pull_requests",
# "open_issues": bool, "levels", "instructions"}}; and by issue, over its repo's: {"owner/name#n": {"questions",
# "comments", "pull_requests": bool}}. Read from the files each time they are needed.
AUTOMATION_FILE = DATA_DIR / "repo_automation.json"
ISSUE_AUTOMATION_FILE = DATA_DIR / "issue_automation.json"
ACTIONS_FILE = DATA_DIR / "actions.json"
TIMER_MINUTES = 10
MUST_WAIT = ["money", "sensitive", "github", "delete"]


class Inbox:
    def __init__(self):
        self.folder = DATA_DIR / "inbox"
        self.lock = threading.Lock()
        self.version = 0
        self.drafts: dict[str, dict] = {}
        # "*.json" leaves out a "*.json.tmp" a crash may have left behind.
        for path in sorted(self.folder.glob("*.json")):
            draft = json.loads(path.read_text())
            # Drafts from before evidence existed have none.
            draft.setdefault("evidence", [])
            # And from before overviews.
            draft.setdefault("overview", {})
            draft.setdefault("template", None)
            # And from before sending.
            draft.setdefault("base_sha", "")
            draft.setdefault("commits", [])
            draft.setdefault("sent", None)
            # And from before PR updates and editing.
            draft.setdefault("update_of", None)
            draft.setdefault("rebase_of", None)
            draft.setdefault("edited", False)
            # And from before project reviews.
            draft.setdefault("review", None)
            draft.setdefault("replaces", None)
            # And from before edits and question options.
            draft.setdefault("previous", None)
            draft.setdefault("options", [])
            # And from before timed questions.
            draft.setdefault("recommended", None)
            draft.setdefault("answer_by", None)
            draft.setdefault("must_wait", None)
            draft.setdefault("answered_by", None)
            self.drafts[draft["id"]] = draft

        # What agents put on GitHub. The first time, the drafts sent before it existed, by when they were sent.
        self.sent_actions: list[dict] = []
        if ACTIONS_FILE.is_file():
            self.sent_actions = json.loads(ACTIONS_FILE.read_text())
        else:
            for draft in sorted(self.drafts.values(), key=lambda draft: draft["sent"]["at"] if draft["sent"] else ""):
                if draft["sent"] is None:
                    continue
                self.sent_actions.append(
                    {"draft": draft["id"], "kind": draft["kind"], "agent": draft["agent"], "job": draft["job"], "title": draft["title"], "sent": draft["sent"]}
                )
            self.save_actions()

    def save(self, draft: dict) -> None:
        """Write one draft to disk. Called with the lock held, after every change."""
        self.version += 1
        self.folder.mkdir(parents=True, exist_ok=True)
        # Write, then rename: a crash never leaves half a record.
        temporary = self.folder / f"{draft['id']}.json.tmp"
        temporary.write_text(json.dumps(draft, indent=2))
        temporary.replace(self.folder / f"{draft['id']}.json")

    def save_actions(self) -> None:
        """Write the actions to disk. Called with the lock held, after every change."""
        ACTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = ACTIONS_FILE.with_name(ACTIONS_FILE.name + ".tmp")
        temporary.write_text(json.dumps(self.sent_actions, indent=2))
        temporary.replace(ACTIONS_FILE)

    def actions(self) -> list[dict]:
        """Everything agents put on GitHub, newest first."""
        with self.lock:
            return copy.deepcopy(list(reversed(self.sent_actions)))

    def add_action(self, action: dict) -> None:
        """Something an agent did on GitHub itself, not from a draft (work_tools.py open_issue and update_branch)."""
        with self.lock:
            self.sent_actions.append(copy.deepcopy(action))
            self.save_actions()

    def list(self) -> list[dict]:
        """All drafts, newest first."""
        with self.lock:
            drafts = sorted(self.drafts.values(), key=lambda draft: draft["created_at"], reverse=True)
            return copy.deepcopy(drafts)

    def get(self, draft_id: str) -> dict:
        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            return copy.deepcopy(self.drafts[draft_id])

    def pr_owners(self) -> dict:
        """How many PR drafts each agent has that wait for the user or were approved: PRs that are, or may soon be,
        on GitHub. Such an agent can't be deleted, only archived (agents.py). Cheap: no copies, it runs on every change."""
        with self.lock:
            counts = {}
            for draft in self.drafts.values():
                if draft["kind"] == "pr" and draft["status"] in ["pending", "approved"]:
                    counts[draft["agent"]] = counts.get(draft["agent"], 0) + 1
            return counts

    def create(self, kind: str, agent: str, title: str, body: str, job: str | None = None,
               repo: str | None = None, target: str | None = None, diff: str = "", branch: str = "",
               base: str = "", base_sha: str = "", commits: list | None = None, vm: str | None = None, path: str | None = None, evidence: list | None = None,
               overview: dict | None = None, template: str | None = None, update_of: str | None = None, review: dict | None = None,
               replaces: str | None = None, rebase_of: str | None = None, previous: dict | None = None,
               options: list | None = None, recommended: str | None = None, answer_by: str | None = None,
               must_wait: str | None = None) -> dict:
        with self.lock:
            draft_id = "draft_" + secrets.token_hex(3)
            while draft_id in self.drafts:
                draft_id = "draft_" + secrets.token_hex(3)
            draft = {
                "id": draft_id,
                "kind": kind,
                "agent": agent,
                "job": job,
                "repo": repo,
                "target": target,
                "title": title,
                "body": body,
                "diff": diff,
                "branch": branch,
                "base": base,
                "base_sha": base_sha,
                "commits": copy.deepcopy(commits or []),
                "vm": vm,
                "path": path,
                "evidence": copy.deepcopy(evidence or []),
                "overview": copy.deepcopy(overview or {}),
                "template": template,
                "status": "pending",
                "reply": "",
                "created_at": datetime.now(UTC).isoformat(),
                "decided_at": None,
                "sent": None,
                "update_of": update_of,
                "rebase_of": rebase_of,
                "edited": False,
                "review": copy.deepcopy(review),
                "replaces": replaces,
                "previous": copy.deepcopy(previous),
                "options": list(options or []),
                "recommended": recommended,
                "answer_by": answer_by,
                "must_wait": must_wait,
                "answered_by": None,
            }
            self.drafts[draft_id] = draft
            self.save(draft)
            return copy.deepcopy(draft)

    def decide(self, draft_id: str, status: str, reply: str = "", answered_by: str = "user") -> dict:
        """Approve, reject or reply to a pending draft. Returns the draft as it is now. answered_by ("user", "timer" or
        "automation") is kept on a question."""
        if status not in DECISIONS:
            raise ValueError(f"Unknown decision {status!r}, use one of: {', '.join(DECISIONS)}")

        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            draft = self.drafts[draft_id]
            if draft["status"] != "pending":
                raise ValueError(f"{draft_id} was already {draft['status']}")
            draft["status"] = status
            draft["reply"] = reply
            draft["decided_at"] = datetime.now(UTC).isoformat()
            if draft["kind"] == "question":
                draft["answered_by"] = answered_by
            self.save(draft)
            return copy.deepcopy(draft)

    def edit(self, draft_id: str, title: str, body: str) -> dict:
        """The user changes a pending PR, comment or edit draft's title and text before deciding. Returns the draft as it is now."""
        title = title.strip()
        body = body.strip()
        if title == "" or body == "":
            raise ValueError("The title and the text can't be empty.")

        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            draft = self.drafts[draft_id]
            if draft["status"] != "pending":
                raise ValueError(f"{draft_id} was already {draft['status']}")
            if draft["kind"] not in ["pr", "comment", "edit"]:
                raise ValueError("Only a PR, a comment or a new title and description can be edited.")
            # Saved as it was: nothing changed, so it isn't edited.
            if title == draft["title"] and body == draft["body"].strip():
                return copy.deepcopy(draft)
            draft["title"] = title
            draft["body"] = body
            draft["edited"] = True
            self.save(draft)
            return copy.deepcopy(draft)

    def delete(self, draft_ids: list[str]) -> list[str]:
        """Delete these drafts if they are decided. Pending and unknown ones are left as they are. Returns the ids deleted."""
        with self.lock:
            deleted = []
            for draft_id in draft_ids:
                if draft_id not in self.drafts:
                    continue
                if self.drafts[draft_id]["status"] == "pending":
                    continue
                del self.drafts[draft_id]
                (self.folder / f"{draft_id}.json").unlink(missing_ok=True)
                deleted.append(draft_id)
            if deleted:
                self.version += 1
            return deleted

    def set_review(self, draft_id: str, review: dict) -> dict:
        """Where a project PR draft's review stands (see above). Returns the draft as it is now."""
        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            draft = self.drafts[draft_id]
            draft["review"] = copy.deepcopy(review)
            self.save(draft)
            return copy.deepcopy(draft)

    def mark_sent(self, draft_id: str, sent: dict) -> dict:
        """What went to GitHub for this draft (github_account.py). Returns the draft as it is now."""
        with self.lock:
            if draft_id not in self.drafts:
                raise KeyError(f"No draft {draft_id}")
            draft = self.drafts[draft_id]
            # A new action the first time; a deleted comment comes here again (deleted_at), and its action says so too.
            if draft["sent"] is None:
                self.sent_actions.append(
                    {"draft": draft["id"], "kind": draft["kind"], "agent": draft["agent"], "job": draft["job"], "title": draft["title"], "sent": copy.deepcopy(sent)}
                )
            for action in self.sent_actions:
                if action["draft"] == draft_id:
                    action["sent"] = copy.deepcopy(sent)
            self.save_actions()
            draft["sent"] = copy.deepcopy(sent)
            self.save(draft)
            return copy.deepcopy(draft)
