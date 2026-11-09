"""The Dashboard's Automation tab (frontend/src/Automation.tsx): Seraph finds repos, works on them and lets go of them by
itself, as you, so the repos it works on keep changing: the ones that merge our PRs stay, new ones come in, the ones that
don't merge leave.

Its settings and what it did, in AUTOMATION_FILE (DATA_DIR/automation.json):

    {"on": bool, "active_repos": int,
     "take_new": bool,                                 False: Pause new issues (below)
     "rules": {"fast_days", "normal_days", "max_open_days", "close_days", "idle_days", "leave_days": int},
     "new_repos": the level of automation the repos it adds get (a repo's, repo_automation_api.py),
     "archived": {"owner/name": when it archived it, ...},
     "closed": ["owner/name#n", ...],                the PRs of ours it closed
     "run": started_at of the Explore run it started | None,
     "log": [{"at", "repo", "what", "why"}, ...],   newest last, the last LOG_KEPT
     "labels": {"owner/name": Label, ...}}           every repo in Repos, worked out every round, also while off

    Label = {"label", "rank", "why", "merged", "closed", "open", "days", "idle", "per_day"}

Each repo's label comes from our PRs there: the ones pr_tracking.py follows that we opened, not the ones this closed, nor
one an agent made again as a fresh PR, which closes the old one (backend/issues_api.py keep_stale_prs). Days are
business days, Monday to Friday, except idle. The numbers are the rules' (RULES at first):
    Fast          ours merged within fast_days (the median of them: days)
    Normal        within normal_days
    Slow          longer
    New           none of ours merged yet
    No issues     over the four above: a repo with Queue issues on that had nothing to work on for idle_days days (idle,
                  calendar days since it was added, or since the newest job or PR of ours there; a Catalog card or an
                  open job counts as now)
    Not merging   over all of them: one of ours open more than max_open_days without a merge, or MIN_CLOSED or more of
                  ours closed without a merge and they are MAX_CLOSED_SHARE or more of ours there (closed / all)
LABELS is their order (rank). per_day is how many PRs the repo merges a day, anyone's (its signals: the monthly average
over 90 days, repo_signals.py), None before they are read. Agents take the Issues board's Catalog cards by rank, then by
per_day, the most first (backend/issues_api.py take_from_catalog), and the page lists them so.

keep_automation() runs as long as the backend, every CHECK_SECONDS. It works out the labels and, on or off, holds every
repo to Explore's minimums (explore.py MIN_*: over 1k stars, 40 contributors or more, over 400 closed PRs, over 10 open
issues, a README in English), so no personal repo stays: once its signals are read, one in Repos that falls short
leaves (archived when it has a PR of ours, else off Repos and kept as checked by Explore, so it never comes back), and
so does one in Explore's found list (also one found before these were checked, which a later run checks anew). And while
on:
- archives a repo that is Not merging (Repos' Archived, repo_list.py): its issues leave the board's Open and Catalog,
  the jobs on its issues with no PR yet stop, and no new PR goes there (repo_automation_api.py keep_drafts). Our open
  PRs there stay and their agents still answer reviews. close_days business days after it archived the repo, the ones
  still open are closed (their agent set to Off first, so nobody drafts about it). Never for an issue our agents opened
  (its job goes on, its PR stays open): we never give one up; keep_branches_clean
  (backend/github_api.py) deletes their branches, as it does for every PR of ours that isn't open.
- unarchives a repo it archived when one of ours there gets merged after that, unless it is still Not merging.
- archives a repo that had No issues for leave_days days too. Archived repos stay in Repos, so Explore never adds one
  again; Unarchive on the Dashboard's Repository page brings one back.
- keeps active_repos repos active (in Repos, not archived; MAX_ACTIVE at most). What Explore found goes into Repos at
  once, the best first: the most PRs merged a day (Explore skips a repo under MIN_MERGED_PER_DAY, explore.py), then AI
  policy (welcome, disclose, none, unclear; never no_ai), then newcomers (welcomes, ok, few). Each comes with
  new_repos (AUTO_SETTINGS at first: every level of its Automation on, Add, Queue and Take issues, Questions, Comments and
  Pull requests), so agents take its issues and send their PRs as you once the reviewer passed them, under its Open PRs at once and
  Issue levels (repo_automation_api.py). With still too few, it starts an Explore run for the rest (explore.py) with as
  many workers as GitHub's quota allows, after adding a new type of repo to Explore's profile (Explore.add_type), so it
  looks wider each time. Not within RUN_PAUSE_MINUTES of a run that ended short.
Only repos it archived are unarchived or get their PRs closed: one you archived stays yours. Turning it off stops the
Explore run it started.

Pause new issues (take_new False, on or off): agents take no new issues from the Issues board's Catalog (backend/issues_api.py
take_from_catalog), not even ours; the cards wait there until Resume new issues. Everything else goes on: the jobs
already started, follow-ups on our PRs, Assign by hand, tagging, Explore, the labels and the archiving.

GET /api/automation gives it all (the live "automation" topic too: summary()), with every level of automation besides,
for the page's Settings tab: each repo's and each issue's (repo_automation_api.py), the defaults, and the Issues board's
(issues_api.py). PUT /api/automation sets on, active_repos and take_new, PUT /api/automation/rules the rules, PUT
/api/automation/new_repos the level new repos get. A change to any of them, here or in the robot dialogs, goes up
AUTOMATION_VERSION (issues_api.py), so every page shows it at once.
"""

import asyncio
import copy
import json
import statistics
import traceback
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.issues_api import AUTO_REMOVE_FILE, AUTO_REMOVE_OFF, AUTOMATION_VERSION, auto_remove_issues
from backend.repo_automation_api import DEFAULTS, ISSUE_SETTINGS_FILE, LEVELS, SETTINGS_FILE
from backend.shared import agents, explore, github_account, inbox, issues, jobs, pr_tracking, repo_signals, repos
from github_searcher.explore import MIN_CLOSED_PRS, MIN_CONTRIBUTORS, MIN_OPEN_ISSUES, MIN_STARS
from github_searcher.github_account import SendError
from github_searcher.issue_tags import DATA_DIR

router = APIRouter(prefix="/api")

AUTOMATION_FILE = DATA_DIR / "automation.json"
CHECK_SECONDS = 60
# The rules at first; the Settings tab changes them.
RULES = {"fast_days": 3, "normal_days": 5, "max_open_days": 10, "close_days": 10, "idle_days": 14, "leave_days": 30}
MIN_CLOSED = 2
MAX_CLOSED_SHARE = 0.5
LOG_KEPT = 200
MAX_ACTIVE = 300
RUN_PAUSE_MINUTES = 30
LABELS = ["Fast", "Normal", "New", "Slow", "No issues", "Not merging"]
POLICY_ORDER = ["welcome", "disclose", "none", "unclear"]
NEWCOMERS_ORDER = ["welcomes", "ok", "few"]
EXPLORE_FILTERS = {"policy:no_ai": "exclude"}
AUTO_SETTINGS = dict(DEFAULTS)
AUTO_SETTINGS.update({"add_issues": True, "queue_issues": True, "take_issues": True, "questions": True, "comments": True, "pull_requests": True})
OPEN_JOB = ["queued", "working", "waiting_on_user", "paused"]
EMPTY = {"on": False, "active_repos": MAX_ACTIVE, "take_new": True, "rules": RULES, "new_repos": AUTO_SETTINGS, "archived": {}, "closed": [], "run": None, "log": [], "labels": {}}

# Kept in memory and saved on every change. Everything that changes it runs on the event loop, so it needs no lock.
automation = copy.deepcopy(EMPTY)
if AUTOMATION_FILE.is_file():
    automation.update(json.loads(AUTOMATION_FILE.read_text()))
# The PRs a close was tried on (a restart tries them again).
STATE = {"tried": []}


class AutomationRequest(BaseModel):
    on: bool
    active_repos: int
    take_new: bool


class RulesRequest(BaseModel):
    fast_days: int
    normal_days: int
    max_open_days: int
    close_days: int
    idle_days: int
    leave_days: int


class NewReposRequest(BaseModel):
    add_issues: bool
    queue_issues: bool
    take_issues: bool
    questions: bool
    comments: bool
    pull_requests: bool
    open_issues: bool
    max_prs_first: int
    max_prs: int
    levels_first: list[str]
    levels: list[str]
    instructions: str


def summary() -> dict:
    """It all, with every level of automation besides (see the top of this file). On the event loop."""
    data = copy.deepcopy(automation)
    data["repo_levels"] = {}
    if SETTINGS_FILE.is_file():
        data["repo_levels"] = json.loads(SETTINGS_FILE.read_text())
    data["issue_levels"] = {}
    if ISSUE_SETTINGS_FILE.is_file():
        data["issue_levels"] = json.loads(ISSUE_SETTINGS_FILE.read_text())
    data["defaults"] = DEFAULTS
    # Each label's rule in words, for the pages to show on hover.
    rules = automation["rules"]
    data["label_rules"] = {
        "Fast": f"Merges ours within {rules['fast_days']} business days (the median)",
        "Normal": f"Merges ours within {rules['normal_days']} business days (the median)",
        "New": "None of ours merged yet",
        "Slow": f"Merges ours in more than {rules['normal_days']} business days (the median)",
        "No issues": f"Nothing to work on for {rules['idle_days']} days; archived after {rules['leave_days']}",
        "Not merging": (
            f"One of ours open over {rules['max_open_days']} business days without a merge, or half of ours closed without one. "
            f"Archived; our PRs still open there are closed {rules['close_days']} business days later"
        ),
    }
    data["board"] = dict(AUTO_REMOVE_OFF)
    if AUTO_REMOVE_FILE.is_file():
        data["board"].update(json.loads(AUTO_REMOVE_FILE.read_text()))
    return data


@router.get("/automation")
async def get_automation() -> dict:
    return summary()


@router.put("/automation")
async def put_automation(body: AutomationRequest) -> dict:
    """Turn it on or off, set how many repos to keep active, and Pause or Resume new issues."""
    if body.active_repos < 1 or body.active_repos > MAX_ACTIVE:
        raise HTTPException(status_code=400, detail=f"Active repositories is 1 to {MAX_ACTIVE}.")
    automation["on"] = body.on
    automation["active_repos"] = body.active_repos
    automation["take_new"] = body.take_new
    AUTOMATION_FILE.write_text(json.dumps(automation, indent=2))
    AUTOMATION_VERSION["version"] += 1
    return summary()


@router.put("/automation/rules")
async def put_rules(body: RulesRequest) -> dict:
    """The numbers behind the labels and what it does with them."""
    rules = body.model_dump()
    if any(value < 1 or value > 365 for value in rules.values()):
        raise HTTPException(status_code=400, detail="The days are 1 to 365.")
    if body.fast_days > body.normal_days:
        raise HTTPException(status_code=400, detail="Fast can't take longer than Normal.")
    if body.idle_days > body.leave_days:
        raise HTTPException(status_code=400, detail="A repo is No issues before it is archived for it.")
    automation["rules"] = rules
    AUTOMATION_FILE.write_text(json.dumps(automation, indent=2))
    AUTOMATION_VERSION["version"] += 1
    return summary()


@router.put("/automation/new_repos")
async def put_new_repos(body: NewReposRequest) -> dict:
    """The level of automation the repos it adds get, like a repo's (PUT /api/repos/automation)."""
    if any(level not in LEVELS for level in body.levels + body.levels_first):
        raise HTTPException(status_code=400, detail="The levels are easy, medium and hard.")
    if body.max_prs_first < 1 or body.max_prs_first > 50 or body.max_prs < 1 or body.max_prs > 50:
        raise HTTPException(status_code=400, detail="Open PRs at once is 1 to 50.")
    automation["new_repos"] = body.model_dump()
    automation["new_repos"]["instructions"] = body.instructions.strip()
    AUTOMATION_FILE.write_text(json.dumps(automation, indent=2))
    AUTOMATION_VERSION["version"] += 1
    return summary()


async def keep_automation() -> None:
    """Runs as long as the backend: labels the repos and, while on, acts on them (see the top of this file)."""
    while True:
        try:
            await automate()
        except Exception:
            # A file, GitHub or Claude failed: the next round tries again.
            traceback.print_exc()
        await asyncio.sleep(CHECK_SECONDS)


async def automate() -> None:
    before = json.dumps(automation)
    rules = automation["rules"]
    now = datetime.now(UTC)
    # A date as its number of Mondays to Fridays since day one (toordinal() is 1 on a Monday; a Saturday or Sunday
    # counts as the Monday after): two of them apart are the business days between.
    day = now.date().toordinal() - 1
    today = (day // 7) * 5 + min(day % 7, 5)

    # Our PRs, by repo in lower case: the business days each merged one took, when the newest was merged, how many
    # were closed without a merge, how many are open and the oldest open one (business days, number), and when each repo
    # last had work. Not the ones this closed, nor one an agent made again fresh.
    replaced = [draft["replaces"] for draft in inbox.list() if draft.get("replaces") and draft["sent"] is not None]
    prs = [pr for pr in pr_tracking.summary()["items"] if pr["relation"] == "author"]
    merge_days = {}
    merged_last = {}
    closed = {}
    open_prs = {}
    oldest = {}
    worked = {}
    for pr in prs:
        if pr["id"] in automation["closed"] or pr["id"] in replaced:
            continue
        name = pr["repo"].lower()
        day = datetime.fromisoformat(pr["opened_at"]).date().toordinal() - 1
        start = (day // 7) * 5 + min(day % 7, 5)
        end = today
        if pr["closed_at"] is not None:
            day = datetime.fromisoformat(pr["closed_at"]).date().toordinal() - 1
            end = (day // 7) * 5 + min(day % 7, 5)
        if pr["state"] == "merged":
            merge_days[name] = merge_days.get(name, []) + [end - start]
        if pr["state"] == "merged" and pr["closed_at"] > merged_last.get(name, ""):
            merged_last[name] = pr["closed_at"]
        if pr["state"] == "closed":
            closed[name] = closed.get(name, 0) + 1
        if pr["state"] == "open":
            open_prs[name] = open_prs.get(name, 0) + 1
        if pr["state"] == "open" and end - start > oldest.get(name, (-1, 0))[0]:
            oldest[name] = (end - start, pr["number"])
        opened = datetime.fromisoformat(pr["opened_at"])
        if name not in worked or opened > worked[name]:
            worked[name] = opened
    # The jobs on each repo too, and a Catalog card or an open job is work now.
    for job in jobs.list():
        if job["repo"] is None:
            continue
        name = job["repo"].lower()
        created = datetime.fromisoformat(job["created_at"])
        if job["status"] in OPEN_JOB:
            created = now
        if name not in worked or created > worked[name]:
            worked[name] = created
    for issue_id in issues.board()["catalog"]:
        worked[issue_id.split("#")[0].lower()] = now
    settings = {}
    if SETTINGS_FILE.is_file():
        settings = json.loads(SETTINGS_FILE.read_text())
    queuing = [repo.lower() for repo, each in settings.items() if each.get("queue_issues")]

    signals = repo_signals.all()
    labels = {}
    for item in repos.items():
        name = item["full_name"].lower()
        activity = (signals.get(item["full_name"]) or {}).get("activity") or {}
        days = merge_days.get(name, [])
        total = len(days) + closed.get(name, 0) + open_prs.get(name, 0)
        label = {"label": "New", "why": "None of ours merged yet", "merged": len(days), "closed": closed.get(name, 0), "open": open_prs.get(name, 0), "days": None}
        if days:
            label["days"] = statistics.median(days)
            label["label"] = "Slow"
            label["why"] = f"Merges ours in {label['days']:g} business days (the median of {len(days)})"
        if days and label["days"] <= rules["normal_days"]:
            label["label"] = "Normal"
        if days and label["days"] <= rules["fast_days"]:
            label["label"] = "Fast"
        last = datetime.fromisoformat(item["added_at"])
        if name in worked and worked[name] > last:
            last = worked[name]
        label["idle"] = (now - last).days
        if name in queuing and label["idle"] >= rules["idle_days"]:
            label["label"] = "No issues"
            label["why"] = f"Nothing to work on for {label['idle']} days"
        if label["closed"] >= MIN_CLOSED and label["closed"] / total >= MAX_CLOSED_SHARE:
            label["label"] = "Not merging"
            label["why"] = f"{label['closed']} of our {total} PRs closed without a merge"
        if name in oldest and oldest[name][0] > rules["max_open_days"]:
            label["label"] = "Not merging"
            label["why"] = f"#{oldest[name][1]} open {oldest[name][0]} business days without a merge"
        label["rank"] = LABELS.index(label["label"])
        label["per_day"] = None
        if activity.get("prs_merged_month") is not None:
            label["per_day"] = round(activity["prs_merged_month"] / 30, 2)
        labels[item["full_name"]] = label
    automation["labels"] = labels

    # Explore's minimums, on or off: what falls short leaves Repos (archived with a PR of ours) and the found list.
    log = []
    at = now.isoformat()
    archived = repos.archived()
    entries = [(item["full_name"], signals.get(item["full_name"])) for item in repos.items() if item["full_name"] not in archived]
    entries += [(entry["name"], entry.get("signals")) for entry in explore.found]
    found = [entry["name"] for entry in explore.found]
    short = {}
    for name, each in entries:
        # Numbers not read yet: a repo waits for them; a found one from before these were checked leaves. The README's
        # language is checked once it is read (backend/repos_api.py keep_signals).
        if each is None or "merged_prs_total" not in each or (name in found and "readme_english" not in each):
            if name in found:
                short[name] = "Found before the minimums were checked"
            continue
        if each["stars"] <= MIN_STARS:
            short[name] = f"{each['stars']} stars, 1k or fewer"
        elif each["contributors_total"] is not None and each["contributors_total"] < MIN_CONTRIBUTORS:
            short[name] = f"{each['contributors_total']} contributors, under {MIN_CONTRIBUTORS}"
        elif each["merged_prs_total"] + each["closed_prs_total"] <= MIN_CLOSED_PRS:
            short[name] = f"{each['merged_prs_total'] + each['closed_prs_total']} closed PRs, {MIN_CLOSED_PRS} or fewer"
        elif each["open_issues_total"] <= MIN_OPEN_ISSUES:
            short[name] = f"{each['open_issues_total']} open issues, {MIN_OPEN_ISSUES} or fewer"
        elif each.get("readme_english") is False:
            short[name] = "README not in English"
    ours = [pr["repo"].lower() for pr in prs]
    leave_archived = []
    leave_removed = []
    for item in repos.items():
        name = item["full_name"]
        if name not in short or name in archived:
            continue
        if name.lower() in ours:
            leave_archived.append(name)
            log.append({"at": at, "repo": name, "what": "Archived", "why": short[name]})
        else:
            leave_removed.append(name)
            log.append({"at": at, "repo": name, "what": "Removed", "why": short[name]})
    if leave_archived:
        repos.set_archived(leave_archived, True)
    if leave_removed:
        repos.remove(leave_removed)
    if leave_archived or leave_removed:
        auto_remove_issues()
    explore.remove([name for name in found if name in short])
    # Explore keeps them as checked, so no worker goes over one again (not one found before the minimums: checked anew).
    for name in leave_removed + [name for name in found if name in short]:
        if short[name] != "Found before the minimums were checked":
            explore.checked[name.lower()] = {"at": at, "reason": short[name]}
    if leave_removed or any(name in short for name in found):
        explore.save_checked()

    if not automation["on"]:
        # Its Explore run stops with it.
        if explore.run is not None and explore.run["status"] == "running" and explore.run["started_at"] == automation["run"]:
            explore.stop()
        automation["log"] = (automation["log"] + log)[-LOG_KEPT:]
        if json.dumps(automation) != before:
            AUTOMATION_FILE.write_text(json.dumps(automation, indent=2))
            AUTOMATION_VERSION["version"] += 1
        return

    # Not merging, or No issues for leave_days: archived.
    archived = repos.archived()
    archive = []
    for item in repos.items():
        name = item["full_name"]
        label = labels[name]
        if name in archived:
            continue
        if label["label"] == "Not merging" or (label["label"] == "No issues" and label["idle"] >= rules["leave_days"]):
            archive.append(name)
            automation["archived"][name] = at
            log.append({"at": at, "repo": name, "what": "Archived", "why": label["why"]})
    if archive:
        repos.set_archived(archive, True)
        auto_remove_issues()
    # The jobs on their issues that have no PR yet stop; never one on an issue our agents opened.
    opened = []
    for action in inbox.actions():
        if action["kind"] == "issue":
            opened.append(f"{action['sent']['repo']}#{action['sent']['number']}".lower())
    gone = [name.lower() for name in archive]
    with_pr = [pr["job"] for pr in prs if pr["job"] is not None]
    for job in jobs.list():
        if job["kind"] != "fix_issue" or job["repo"] is None or job["repo"].lower() not in gone:
            continue
        if job["issue"] is not None and job["issue"].lower() in opened:
            continue
        if job["status"] in OPEN_JOB and job["id"] not in with_pr:
            agents.stop_job(job["id"], f"{job['repo']} doesn't merge our PRs or has nothing to work on, so Seraph stopped working there.")

    # A repo it archived comes back once one of ours there is merged after that, unless it is still Not merging. One you
    # unarchived or deleted meanwhile is yours again.
    archived = repos.archived()
    for name in list(automation["archived"]):
        if name not in archived or name not in labels:
            del automation["archived"][name]
            continue
        merged_at = merged_last.get(name.lower())
        if labels[name]["label"] == "Not merging" or merged_at is None:
            continue
        if datetime.fromisoformat(merged_at) <= datetime.fromisoformat(automation["archived"][name]):
            continue
        repos.set_archived([name], False)
        del automation["archived"][name]
        log.append({"at": at, "repo": name, "what": "Unarchived", "why": "Merged one of ours after it was archived"})

    # Our PRs still open close_days business days after it archived their repo are closed; never one for an issue our
    # agents opened (the issues it says it fixes, or its job's).
    archived_at = {name.lower(): when for name, when in automation["archived"].items()}
    job_issue = {job["id"]: job["issue"] for job in jobs.list()}
    for pr in prs:
        when = archived_at.get(pr["repo"].lower())
        if pr["state"] != "open" or when is None or pr["id"] in STATE["tried"]:
            continue
        fixes = [f"{pr['repo']}#{issue['number']}".lower() for issue in pr["issues"]]
        fixes.append((job_issue.get(pr["job"]) or "").lower())
        if any(issue_id in opened for issue_id in fixes):
            continue
        day = datetime.fromisoformat(when).date().toordinal() - 1
        if today - ((day // 7) * 5 + min(day % 7, 5)) < rules["close_days"]:
            continue
        STATE["tried"].append(pr["id"])
        pr_tracking.set_agent(pr["id"], "off", None)
        try:
            await asyncio.to_thread(github_account.manage, "close", pr["repo"], pr["number"])
        except SendError as error:
            log.append({"at": at, "repo": pr["repo"], "what": f"Could not close #{pr['number']}", "why": str(error)})
            continue
        automation["closed"].append(pr["id"])
        pr_tracking.wanted = True
        log.append({"at": at, "repo": pr["repo"], "what": f"Closed #{pr['number']}", "why": f"Still open {rules['close_days']} business days after the repo was archived"})

    # Keep active_repos active: what Explore found goes into Repos, the best first.
    archived = repos.archived()
    room = automation["active_repos"] - len([item for item in repos.items() if item["full_name"] not in archived])
    ranked = []
    for entry in explore.found:
        if entry["ai_policy"] not in POLICY_ORDER:
            continue
        newcomers = len(NEWCOMERS_ORDER)
        if entry["newcomers"] in NEWCOMERS_ORDER:
            newcomers = NEWCOMERS_ORDER.index(entry["newcomers"])
        activity = (entry.get("signals") or {}).get("activity") or {}
        per_day = (activity.get("prs_merged_month") or 0) / 30
        ranked.append((-per_day, POLICY_ORDER.index(entry["ai_policy"]), newcomers, entry["name"]))
    ranked.sort()
    if room > 0 and ranked:
        notes = {entry["name"]: entry["note"] for entry in explore.found}
        added = await explore.approve([each[3] for each in ranked[:room]])
        settings = {}
        if SETTINGS_FILE.is_file():
            settings = json.loads(SETTINGS_FILE.read_text())
        for name in added:
            settings[name] = copy.deepcopy(automation["new_repos"])
            log.append({"at": at, "repo": name, "what": "Added", "why": notes.get(name, "")})
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2))
        AUTOMATION_VERSION["version"] += 1
        room -= len(added)

    # Still too few: an Explore run for the rest, on a new type of repo too. Not right after one that ended short.
    run = explore.run
    rested = run is None or run["ended_at"] is None or now - datetime.fromisoformat(run["ended_at"]) > timedelta(minutes=RUN_PAUSE_MINUTES)
    if run is not None and run["count"] is not None and run["found"] >= run["count"]:
        rested = True
    if room > 0 and rested and (run is None or run["status"] != "running"):
        try:
            await explore.add_type()
        except Exception:
            traceback.print_exc()
        # Workers: as many as GitHub's quota allows (None).
        explore.start(room, None, None, EXPLORE_FILTERS)
        automation["run"] = explore.run["started_at"]

    automation["log"] = (automation["log"] + log)[-LOG_KEPT:]
    if json.dumps(automation) != before:
        AUTOMATION_FILE.write_text(json.dumps(automation, indent=2))
        AUTOMATION_VERSION["version"] += 1
