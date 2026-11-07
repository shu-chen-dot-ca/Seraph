/*
The Dashboard's Issues page (#/dashboard/issues): the issues in the Issues list as a board, one card per issue, in five
columns from left to right, by the issue's latest job and your pull request for it:
- Open: no job yet, or the last one was cancelled.
- Catalog: you moved it there (Add, here or in a repo's pop-up on the Repository page, or dragged), or a job waits in
  the queue for its agent.
- In progress: an agent is working on it.
- Review: its draft waits for you in the Inbox.
- Open PR: your pull request for it is open on GitHub. A dot after the name: green while an agent works on it (a
  follow-up on the pull request), yellow while it waits for others (maintainers, CI, ...).
Finished ones are left off the board, so the others have more room: the job is done and its pull request merged or
closed (or there is none), or the issue was closed. They are still sorted into board.finished, only not shown, and the
count on top leaves them out.
Open PR is every pull request of yours open on GitHub: one with no job (or a cancelled one) goes there too, one merged
or closed leaves it even while its job waits, and one whose issue isn't on the list (taken off, or it links none) gets
a card of its own, made from the pull request (its job's issue, else the one it links, else the pull request).
Only Open cards have the ×. At a card's bottom right, filled buttons, side by side: Add on Open cards (to the end of
Catalog), Cancel on Catalog cards you put there (back to Open), and Pause / Resume on Catalog and In progress cards.
Finished cards have none.
Your pull request for an issue is the one sent from its job, or one of yours that links the issue; an open one first.
Review, Open PR and Finished cards end with the change's size: the lines it adds and removes (+12 −3) and the files it
changes, from the draft waiting in the Inbox on Review and from the pull request after (GitHub's numbers, missing until
the pull request is read again).

A card: the repo owner's picture as its logo, and next to it two lines as tall as the logo: on top the issue's short
name, which Claude gives with its tags (github_searcher/issue_tags.py): what the agent has to do, in a few words, one
line ("Fix SQL query logic"); until then, and for one assigned on GitHub (not asked), the GitHub title. At the bottom
the repo and the issue's number. Under them its tags, from the same read (none until then): Free, Claimed (someone
else is on it: never you or your agents) or Fixed (already done, it only needs closing), the complexity (Easy, Medium, Hard, or Out of scope when we don't take it), about
how many lines the fix changes, and Scope clear or Scope not clear. Good is green, bad is red: Free, Scope clear
and Easy green; Claimed, Scope not clear and Out of scope red; Medium yellow and Hard orange, between them; the lines
gray. Then when it was opened (hover for the date) and how many comments it has, and on an Open card, at the bottom
right, Add: it moves to the end of Catalog. A click opens it in a pop-up: the short name,
then its real name (#number and GitHub title, opens the issue on GitHub), the repository (opens it on GitHub), the
agent (its chat; none before a job), the VM its job is on (its page) and who opened it (their GitHub profile). Not the issue's text: that is on GitHub.

Open goes by repo like the Repository page (RepositoryCards.tsx): the repos where most of your pull requests were
merged first, ties by stars, then A to Z; within a repo by when the issue was opened on GitHub, newest first. In
progress, Review, Open PR and Finished go by repo,
A to Z, then Free first (then Claimed, Fixed), Scope clear before Scope not clear, Easy to Hard (then Out of scope), and
the fewest lines first; ones not read yet go last each time. Catalog is in your order (dragged).
Cards drag: up and down within Catalog, and between Open and Catalog (not one with a job: its job decides its
column). Dropped on a Catalog card it goes before that card, dropped on its empty space to its end; the column it can go
to is outlined while dragging. Catalog and the order are kept by the backend (POST /api/issues/board, issue_list.py),
so they are the same everywhere.

Catalog's order is its priority: while fewer than the board's Max agents work, the backend gives the top card of a repo
with Take issues on to a new agent (agent-N, which picks its VM itself), first come first served (keep_catalog_agents in
backend/issues_api.py).

Each card's level of automation shows under its tags, past a line: Questions, Comments and Pull requests when on, or
No automation. Its repo's (AutomationDialog.tsx, kept by the backend: GET /api/repos/automation) is the default; the
issue's own, from the robot at its top right (IssueAutomationDialog.tsx, also kept by the backend), goes over it. Add
issues, Queue issues, Take issues and Open issues are the repo's only, so cards don't show them: with Add issues on, the
repo's open issues of its levels come into Open by themselves (each once), with Queue issues on, the repo's
issues that fit go to Catalog by themselves, and with Take issues on, agents take its Catalog cards. A click on the card's logo opens its repo's automation right here. The backend acts on all of it
(backend/repo_automation_api.py): Questions are answered, Comments posted and Pull requests sent without you. Repo and
issue settings from before, kept in this browser, are handed to the backend when the board reads the settings (unless
it has its own for them already), so what the backend acts on is what the cards show.

Over the board, the robot button opens its Automation (BoardAutomationDialog.tsx): which issues leave the list by
themselves (claimed, out of scope, a complexity, scope not clear, opened too long ago), how often each column's
issues are read again, and how many agents work at once. The × at a card's top right takes that issue off for good (POST /api/issues/dismiss): no agent
or bulk add puts it back, only adding that one issue yourself on the Tracked page; Undo on its toast puts it back. One
an agent is working on stays (a toast says so); cancel its job first.

At every card's top right, from right to left: the × (Open only), the ⋯ and the robot (not on Finished ones). The ⋯ is
the card's menu, so far only Delete, in any column: it asks first, cancels the issue's open jobs (their agents are told
to stop) and takes it off for good like the × (POST /api/issues/delete); Undo on its toast puts the issue back, not
the jobs.

Everything comes from the live "issues", "jobs", "prs", "repos" and "agents" topics, so cards move by themselves.
*/

import { Bot, MessageSquare, MoreHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import AutomationDialog, { type Automation } from "@/AutomationDialog";
import BoardAutomationDialog from "@/BoardAutomationDialog";
import IssueAutomationDialog, { type Level } from "@/IssueAutomationDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/ui/status-dot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, useLive, type IssueItem, type Job } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

// Finished ones (board.finished) aren't shown.
const COLUMNS = ["open", "catalog", "in_progress", "review", "open_pr"];

const COLUMN_NAMES: Record<string, string> = {
  open: "Open",
  catalog: "Catalog",
  in_progress: "In progress",
  review: "Review",
  open_pr: "Open PR",
  finished: "Finished",
};

// A tag on a card: its words and its color (a Badge variant: green good, red bad, gray the rest). Medium and Hard
// sit between green and red, yellow and orange, which no variant has: className gives them.
type Tag = {
  label: string;
  variant: "ok" | "bad" | "secondary";
  className?: string;
};

const COMPLEXITY_TAGS: Record<string, Tag> = {
  easy: { label: "Easy", variant: "ok" },
  medium: {
    label: "Medium",
    variant: "secondary",
    className: "bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400",
  },
  hard: {
    label: "Hard",
    variant: "secondary",
    className: "bg-orange-500/10 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400",
  },
};

type Card = {
  issue: IssueItem;
  job: Job | null;
  shortName: string;
  tags: Tag[];
  column: string;
  // No job decides its column (none, or only cancelled ones): it can move between Open and Catalog.
  movable: boolean;
  // Its level of automation, and whether it is the issue's own (else its repo's).
  level: Level;
  ownLevel: boolean;
  // Paused, and its stage done while paused (the yellow dot); nothing tracks a stage being done yet.
  held: boolean;
  done: boolean;
  // Why only you can move it on ("" when nothing): the red dot.
  blocker: string;
  // In Open PR: an agent works on its pull request (the green dot), else it waits for others (yellow).
  prWorking: boolean;
  // How it sorts after its repo, lowest first: free, scope, complexity, lines.
  rank: number[];
};

const LEVEL_NAMES: Record<string, string> = {
  questions: "Questions",
  comments: "Comments",
  pull_requests: "Pull requests",
};

export default function IssueBoard() {
  const issues = useLive("issues");
  const jobs = useLive("jobs");
  const prs = useLive("prs");
  const repos = useLive("repos");
  const agents = useLive("agents");
  const inbox = useLive("inbox");
  // The issue whose pop-up is open, by id.
  const [openId, setOpenId] = useState<string | null>(null);
  const [automation, setAutomation] = useState(false);
  // The card being dragged, and the column it is over (outlined when it may go there).
  const [dragging, setDragging] = useState<Card | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // The card the dragged one would go before (the line above it), or null: the end of the column.
  const [overCard, setOverCard] = useState<string | null>(null);
  // The repo whose automation is open (from a card's logo), and the card whose own is open (its ⋯).
  const [repoAutomation, setRepoAutomation] = useState<string | null>(null);
  const [issueAutomation, setIssueAutomation] = useState<Card | null>(null);
  // The card Delete asks about. It stays set while the dialog fades out, so the title doesn't blank.
  const [deleting, setDeleting] = useState<Card | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Goes up when one of those closes, so the cards read the settings again.
  const [saved, setSaved] = useState(0);
  // Every repo's automation from the backend, by repo name in lower case, and every issue's own level, by issue id; read
  // again when a dialog closes.
  const [repoSettings, setRepoSettings] = useState<Record<string, Automation>>({});
  const [issueSettings, setIssueSettings] = useState<Record<string, Level>>({});

  useEffect(() => {
    api<{ repos: Record<string, Automation>; issues: Record<string, Level> }>("/api/repos/automation")
      .then(async (data) => {
        const byName: Record<string, Automation> = {};
        for (const repo of Object.keys(data.repos)) {
          byName[repo.toLowerCase()] = data.repos[repo];
        }
        // Settings from before, kept in this browser, go to the backend, which acts on them.
        let keys: string[] = [];
        try {
          keys = Object.keys(localStorage).filter((key) => key.startsWith("automation:"));
        } catch {
          // Storage blocked: nothing was kept.
        }
        for (const key of keys.filter((each) => !each.startsWith("automation:issue:"))) {
          const repo = key.slice("automation:".length);
          try {
            const old = JSON.parse(localStorage.getItem(key) ?? "null");
            if (old !== null && byName[repo.toLowerCase()] === undefined) {
              const next: Automation = {
                queue_issues: old.take_issues === true,
                take_issues: old.take_issues === true,
                questions: old.questions === true,
                comments: old.comments === true,
                pull_requests: old.pull_requests === true,
                open_issues: false,
                levels: Array.isArray(old.levels) ? old.levels : ["easy"],
                instructions: typeof old.instructions === "string" ? old.instructions : "",
              };
              await api("/api/repos/automation", { method: "PUT", body: { repos: [repo], ...next } });
              byName[repo.toLowerCase()] = next;
            }
            localStorage.removeItem(key);
          } catch {
            // Kept for the next read.
          }
        }
        setRepoSettings(byName);
        const issueLevels = { ...data.issues };
        for (const key of keys.filter((each) => each.startsWith("automation:issue:"))) {
          const id = key.slice("automation:issue:".length);
          try {
            const old = JSON.parse(localStorage.getItem(key) ?? "null");
            if (old !== null && issueLevels[id] === undefined) {
              const level: Level = { questions: old.questions === true, comments: old.comments === true, pull_requests: old.pull_requests === true };
              await api("/api/issues/automation", { method: "PUT", body: { id: id, level: level } });
              issueLevels[id] = level;
            }
            localStorage.removeItem(key);
          } catch {
            // Kept for the next read.
          }
        }
        setIssueSettings(issueLevels);
      })
      .catch(() => {
        // The cards show No automation until it reads.
      });
  }, [saved]);

  // Delete on the ⋯: its open jobs are cancelled, then it is off the board for good.
  async function remove() {
    if (deleting === null) {
      return;
    }
    const card = deleting;
    try {
      await api("/api/issues/delete", { method: "POST", body: { ids: [card.issue.id] } });
      toast.success(`Deleted ${card.shortName}`, {
        action: { label: "Undo", onClick: () => restore(card.issue.id) },
      });
    } catch (err) {
      toast.error(`Could not delete it: ${err instanceof Error ? err.message : err}`);
    }
  }

  // The ×: off the board for good, unless an agent is working on it.
  async function dismiss(card: Card) {
    try {
      const result = await api<{ removed: string[]; working: string[] }>("/api/issues/dismiss", { method: "POST", body: { ids: [card.issue.id] } });
      if (result.working.length > 0) {
        toast.warning("An agent is working on it. Cancel its job first.");
      } else {
        toast.success(`Removed ${card.shortName}`, {
          action: { label: "Undo", onClick: () => restore(card.issue.id) },
        });
      }
    } catch (err) {
      toast.error(`Could not remove it: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Undo on the toast after the ×: back on the board, and agents may add it again.
  async function restore(id: string) {
    try {
      await api("/api/issues/restore", { method: "POST", body: { ids: [id] } });
    } catch (err) {
      toast.error(`Could not put it back: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Each issue's latest job.
  const latest: Record<string, Job> = {};
  for (const job of jobs) {
    if (job.issue === null) {
      continue;
    }
    const current = latest[job.issue];
    if (current === undefined || job.created_at > current.created_at) {
      latest[job.issue] = job;
    }
  }

  // The issues on the board, and one for each of your open pull requests whose issue isn't there (taken off the list,
  // or it links none), so Open PR has every one that is open on GitHub. Made from the pull request: its job's issue,
  // else the issue it links, else the pull request itself.
  const items: IssueItem[] = [...issues.items];
  const listed = issues.items.map((item) => item.id.toLowerCase());
  for (const pr of prs.items) {
    if (pr.relation !== "author" || pr.state !== "open") {
      continue;
    }
    const prJob = jobs.find((each) => each.id === pr.job);
    const ids = pr.issues.map((linked) => `${pr.repo}#${linked.number}`.toLowerCase());
    if (prJob !== undefined && prJob.issue !== null) {
      ids.push(prJob.issue.toLowerCase());
    }
    if (ids.some((id) => listed.includes(id))) {
      continue;
    }
    const linked = pr.issues.length > 0 ? pr.issues[0] : null;
    let id = pr.id;
    if (linked !== null) {
      id = `${pr.repo}#${linked.number}`;
    }
    if (prJob !== undefined && prJob.issue !== null) {
      id = prJob.issue;
    }
    items.push({
      id: id,
      repo: pr.repo,
      number: linked !== null ? linked.number : pr.number,
      title: linked !== null ? linked.title : pr.title,
      labels: [],
      state: linked !== null && linked.state === "closed" ? "CLOSED" : "OPEN",
      comments: 0,
      html_url: linked !== null ? linked.url : pr.url,
      note: "",
      added_by: "",
      added_at: pr.opened_at,
      facts: null,
      tags: null,
    });
  }

  // The lines and files each job's draft waiting in the Inbox changes, by job id, for its card on Review.
  const draftChanges: Record<string, { additions: number; deletions: number; files: number }> = {};
  for (const draft of inbox) {
    if (draft.job === null || draft.status !== "pending" || !draft.diff) {
      continue;
    }
    const counted = { additions: 0, deletions: 0, files: 0 };
    for (const line of draft.diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        counted.files += 1;
      } else if (line.startsWith("+") && !line.startsWith("+++ ")) {
        counted.additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("--- ")) {
        counted.deletions += 1;
      }
    }
    draftChanges[draft.job] = counted;
  }

  const board: Record<string, Card[]> = {
    open: [],
    catalog: [],
    in_progress: [],
    review: [],
    open_pr: [],
    finished: [],
  };
  for (const issue of items) {
    const job = latest[issue.id] ?? null;
    const repo = issue.repo.toLowerCase();
    // Your pull request for it: sent from its job, one of yours that links the issue, or the card's own (one made
    // from a pull request above). An open one first, when there are more.
    const mine = prs.items.filter(
      (each) =>
        each.relation === "author" &&
        ((job !== null && each.job === job.id) ||
          each.id === issue.id ||
          (each.repo.toLowerCase() === repo && each.issues.some((linked) => linked.number === issue.number))),
    );
    const pr = mine.find((each) => each.state === "open") ?? (mine.length > 0 ? mine[0] : undefined);
    let column = "open";
    // A paused job stays in the column it was paused in.
    const status = job !== null && job.status === "paused" ? (job.paused_from ?? "queued") : job?.status;
    if (job !== null && status === "queued") {
      column = "catalog";
    }
    if (job !== null && status === "working") {
      column = "in_progress";
    }
    if (job !== null && status === "waiting_on_user") {
      column = "review";
    }
    if (job !== null && job.status === "waiting_on_maintainers") {
      column = "open_pr";
    }
    if (job !== null && job.status === "done") {
      column = pr !== undefined && pr.state === "open" ? "open_pr" : "finished";
    }
    // Open PR is what is open on GitHub: a pull request of yours that is open, even with no job (or a cancelled one),
    // and not one merged or closed while its job still waits.
    if (column === "open" && pr !== undefined && pr.state === "open") {
      column = "open_pr";
    }
    if (column === "open_pr" && pr !== undefined && pr.state !== "open") {
      column = "finished";
    }
    // With its pull request open: an agent working on it (a follow-up job on the pull request), or waiting for others.
    let prWorking = false;
    for (const other of jobs) {
      if (pr !== undefined && other.thread === pr.id && (other.status === "queued" || other.status === "working")) {
        prWorking = true;
      }
    }
    const movable = column === "open";
    if (column === "open" && (issue.facts?.state ?? issue.state) === "CLOSED") {
      column = "finished";
    } else if (column === "open" && issues.catalog.includes(issue.id)) {
      column = "catalog";
    }

    // Its tags, in this order: free or claimed, complexity, lines, scope.
    // And how it sorts: not read yet is last each time.
    const tags: Tag[] = [];
    const read = issue.tags;
    let freeRank = 3;
    let scopeRank = 2;
    let complexityRank = 4;
    let linesRank = 1000000;
    if (read !== null && read !== undefined) {
      // Claimed is someone else only: the tags never count you or your agents.
      if (read.status === "assigned") {
        tags.push({ label: "Claimed", variant: "bad" });
        freeRank = 1;
      } else if (read.status === "fixed") {
        tags.push({ label: "Fixed", variant: "secondary" });
        freeRank = 2;
      } else {
        tags.push({ label: "Free", variant: "ok" });
        freeRank = 0;
      }
    }
    if (read?.merge === "out of scope") {
      tags.push({ label: "Out of scope", variant: "bad" });
      complexityRank = 3;
    } else if (read?.complexity) {
      tags.push(COMPLEXITY_TAGS[read.complexity]);
      complexityRank = ["easy", "medium", "hard"].indexOf(read.complexity);
    }
    if (read?.lines !== null && read?.lines !== undefined) {
      tags.push({ label: `~${read.lines} lines`, variant: "secondary" });
      linesRank = read.lines;
    }
    if (read?.scope_clear === true) {
      tags.push({ label: "Scope clear", variant: "ok" });
      scopeRank = 0;
    }
    if (read?.scope_clear === false) {
      tags.push({ label: "Scope not clear", variant: "bad" });
      scopeRank = 1;
    }
    // On Finished, first: Merged or Closed, its pull request's (the issue's, when it has none).
    if (column === "finished" && pr !== undefined && pr.state === "merged") {
      tags.unshift({ label: "Merged", variant: "ok" });
    } else if (column === "finished" && pr !== undefined && pr.state === "closed") {
      tags.unshift({ label: "Closed", variant: "bad" });
    } else if (column === "finished" && pr === undefined && (issue.facts?.state ?? issue.state) === "CLOSED") {
      tags.unshift({ label: "Closed", variant: "bad" });
    }
    // On Review, Open PR and Finished, last: the lines its change adds and removes and the files it changes, from its
    // draft waiting in the Inbox on Review, from its pull request after.
    let changes: { additions: number; deletions: number; files: number } | null = null;
    if (column === "review" && job !== null) {
      changes = draftChanges[job.id] ?? null;
    }
    if ((column === "open_pr" || column === "finished") && pr !== undefined && pr.additions !== undefined) {
      changes = { additions: pr.additions, deletions: pr.deletions ?? 0, files: pr.changed_files ?? 0 };
    }
    if (changes !== null) {
      tags.push({ label: `+${changes.additions} −${changes.deletions}`, variant: "secondary" });
      tags.push({ label: `${changes.files} ${changes.files === 1 ? "file" : "files"}`, variant: "secondary" });
    }

    // Its level of automation: the repo's, else the issue's own over it.
    let repoLevel: Level = { questions: false, comments: false, pull_requests: false };
    const own: Level | null = issueSettings[issue.id] ?? null;
    const fromBackend = repoSettings[issue.repo.toLowerCase()];
    if (fromBackend !== undefined) {
      repoLevel = fromBackend;
    }
    const ownLevel: Level | null = own === null ? null : { questions: own.questions, comments: own.comments, pull_requests: own.pull_requests };
    const level: Level = ownLevel ?? { questions: repoLevel.questions, comments: repoLevel.comments, pull_requests: repoLevel.pull_requests };

    // A blocker only you can solve: its job waits on you for something its level of automation doesn't cover, or for a
    // question that must wait for a person whatever is automated (money, sensitive, GitHub, delete, no options to pick).
    let blocker = "";
    for (const draft of inbox) {
      if (job === null || draft.job !== job.id || draft.status !== "pending") {
        continue;
      }
      if (draft.kind === "question" && (!level.questions || draft.must_wait !== null)) {
        blocker = "Waiting for you";
      } else if ((draft.kind === "pr" || draft.kind === "edit") && !level.pull_requests) {
        blocker = "Waiting for you";
      } else if (draft.kind === "comment" && !level.comments) {
        blocker = "Waiting for you";
      } else if (draft.kind !== "question" && draft.kind !== "pr" && draft.kind !== "edit" && draft.kind !== "comment") {
        blocker = "Waiting for you";
      }
    }

    board[column].push({
      issue: issue,
      job: job,
      shortName: read?.name ?? issue.facts?.title ?? issue.title,
      tags: tags,
      column: column,
      movable: movable && column !== "finished",
      level: level,
      ownLevel: ownLevel !== null,
      held: issues.held.includes(issue.id),
      done: false,
      blocker: blocker,
      prWorking: prWorking,
      rank: [freeRank, scopeRank, complexityRank, linesRank],
    });
  }

  // Catalog in the board's order; cards not placed yet go after, in the order they were added.
  const place: Record<string, number> = {};
  issues.order.forEach((id, index) => {
    place[id] = index;
  });
  board.catalog.sort((a, b) => (place[a.issue.id] ?? issues.order.length) - (place[b.issue.id] ?? issues.order.length));
  // Open like the Repository page: the repos where most of your pull requests were merged first, ties by stars, then
  // by repo (A to Z); within a repo by when the issue was opened on GitHub, newest first (before its facts are in: when
  // it was added).
  const mergedIn: Record<string, number> = {};
  for (const pr of prs.items) {
    if (pr.relation === "author" && pr.state === "merged") {
      mergedIn[pr.repo.toLowerCase()] = (mergedIn[pr.repo.toLowerCase()] ?? 0) + 1;
    }
  }
  const stars: Record<string, number> = {};
  for (const repo of repos.items) {
    stars[repo.full_name.toLowerCase()] = repo.stars;
  }
  board.open.sort((a, b) => {
    const aRepo = a.issue.repo.toLowerCase();
    const bRepo = b.issue.repo.toLowerCase();
    return (
      (mergedIn[bRepo] ?? 0) - (mergedIn[aRepo] ?? 0) ||
      (stars[bRepo] ?? 0) - (stars[aRepo] ?? 0) ||
      aRepo.localeCompare(bRepo) ||
      (b.issue.facts?.created_at ?? b.issue.added_at).localeCompare(a.issue.facts?.created_at ?? a.issue.added_at)
    );
  });
  // The rest by repo, A to Z, then free, scope, complexity and lines.
  for (const column of COLUMNS) {
    if (column === "catalog" || column === "open") {
      continue;
    }
    board[column].sort(
      (a, b) =>
        a.issue.repo.toLowerCase().localeCompare(b.issue.repo.toLowerCase()) ||
        a.rank[0] - b.rank[0] ||
        a.rank[1] - b.rank[1] ||
        a.rank[2] - b.rank[2] ||
        a.rank[3] - b.rank[3],
    );
  }

  // Within Catalog (the rest are sorted); between Open and Catalog when no job decides its column.
  function canDrop(column: string) {
    if (dragging === null) {
      return false;
    }
    if (dragging.column === column) {
      return column === "catalog";
    }
    return dragging.movable && (column === "open" || column === "catalog");
  }

  // Put the card before another one (or at the end of the column), and keep the order and Catalog.
  async function move(card: Card, column: string, before: string | null) {
    const ids = COLUMNS.flatMap((each) => board[each].map((other) => other.issue.id)).filter((id) => id !== card.issue.id);
    let index = ids.length;
    const last = board[column].filter((other) => other.issue.id !== card.issue.id).pop();
    if (before !== null) {
      index = ids.indexOf(before);
    } else if (last !== undefined) {
      index = ids.indexOf(last.issue.id) + 1;
    }
    ids.splice(index, 0, card.issue.id);
    let catalog = issues.catalog;
    if (card.movable) {
      catalog = catalog.filter((id) => id !== card.issue.id);
    }
    if (card.movable && column === "catalog") {
      catalog = [...catalog, card.issue.id];
    }
    try {
      await api("/api/issues/board", { method: "POST", body: { catalog: catalog, order: ids, held: issues.held } });
    } catch (err) {
      toast.error(`Could not move it: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Pause: everything on it stops, its agent too, until Resume (backend/issues_api.py pause_issue, Agents.pause_job).
  async function setHold(card: Card, held: boolean) {
    try {
      await api(held ? "/api/issues/pause" : "/api/issues/resume", { method: "POST", body: { id: card.issue.id } });
      toast.success(held ? `Paused ${card.shortName}` : `Resumed ${card.shortName}`);
    } catch (err) {
      toast.error(`Could not ${held ? "pause" : "resume"} it: ${err instanceof Error ? err.message : err}`);
    }
  }

  function drop(column: string, before: string | null) {
    if (dragging !== null && dragging.issue.id !== before && canDrop(column)) {
      move(dragging, column, before);
    }
    setDragging(null);
    setOver(null);
    setOverCard(null);
  }

  let open: Card | null = null;
  for (const column of COLUMNS) {
    const found = board[column].find((card) => card.issue.id === openId);
    if (found !== undefined) {
      open = found;
    }
  }
  const agentName = open !== null && open.job !== null ? (agents.find((agent) => agent.id === open.job?.agent)?.name ?? open.job.agent) : "";
  const author = open?.issue.facts?.author ?? "";
  const link = "text-primary hover:underline";
  // The cards on the board: Finished ones aren't shown.
  const shown = COLUMNS.reduce((count, column) => count + board[column].length, 0);
  // The buttons at a card's top right.
  const corner = "flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-muted-foreground tabular-nums">
          {shown} {shown === 1 ? "issue" : "issues"}
        </span>
        <button
          type="button"
          className="ml-auto flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Automation"
          onClick={() => setAutomation(true)}
        >
          <Bot className="size-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {COLUMNS.map((column) => (
          <div
            key={column}
            className={cn("flex min-w-56 flex-1 flex-col rounded-lg bg-muted/40", over === column && canDrop(column) && "ring-1 ring-primary/50")}
          >
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
              {COLUMN_NAMES[column]}
              <span className="tabular-nums">{board[column].length}</span>
            </div>
            <div
              className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2"
              onDragOver={(event) => {
                if (canDrop(column)) {
                  event.preventDefault();
                  setOver(column);
                  setOverCard(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop(column, null);
              }}
            >
              {board[column].map((card) => (
                <div
                  key={card.issue.id}
                  className="relative py-1"
                  onDragOver={(event) => {
                    if (canDrop(column)) {
                      event.preventDefault();
                      event.stopPropagation();
                      setOver(column);
                      setOverCard(card.issue.id);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    drop(column, card.issue.id);
                  }}
                >
                  {column === "catalog" && over === column && overCard === card.issue.id && canDrop(column) && dragging?.issue.id !== card.issue.id && (
                    <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 -translate-y-1/2 rounded-full bg-primary" />
                  )}
                  <div
                    className={cn(
                      "relative flex cursor-pointer flex-col gap-2 rounded-md border bg-card p-2.5 text-left hover:bg-accent/50",
                      dragging?.issue.id === card.issue.id && "opacity-50",
                    )}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", card.issue.id);
                      setDragging(card);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                      setOverCard(null);
                    }}
                    onClick={() => setOpenId(card.issue.id)}
                  >
                    <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                      {card.column !== "finished" && (
                        <button
                          type="button"
                          className={corner}
                          aria-label={`Level of automation for ${card.shortName}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setIssueAutomation(card);
                          }}
                        >
                          <Bot className="size-3.5" />
                        </button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={cn(corner, "data-[state=open]:bg-accent data-[state=open]:text-foreground")}
                            aria-label={`Settings for ${card.shortName}`}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => {
                              setDeleting(card);
                              setDeleteOpen(true);
                            }}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {card.column === "open" && (
                        <button
                          type="button"
                          className={corner}
                          title="Remove"
                          aria-label={`Remove ${card.shortName} from board`}
                          onClick={(event) => {
                            event.stopPropagation();
                            dismiss(card);
                          }}
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </span>
                    <span className={cn("flex min-w-0 items-center gap-2.5", card.column === "open" ? "pr-17" : card.column === "finished" ? "pr-6" : "pr-11")}>
                      <button
                        type="button"
                        className="shrink-0 rounded-md hover:opacity-80"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRepoAutomation(card.issue.repo);
                        }}
                      >
                        <img src={`https://github.com/${card.issue.repo.split("/")[0]}.png?size=72`} alt="" className="size-9 rounded-md" />
                      </button>
                      <span className="flex h-9 min-w-0 flex-col justify-between">
                        <span className="flex min-w-0 items-center gap-1.5 leading-tight font-medium">
                          <span className="truncate" title={card.shortName}>
                            {card.shortName}
                          </span>
                          {card.held && card.done && (
                            <span title="This stage is done; paused">
                              <StatusDot tone="amber" className="bg-yellow-400" />
                            </span>
                          )}
                          {card.column === "open_pr" && (
                            <span title={card.prWorking ? "Agent working" : "Waiting for others"}>
                              <StatusDot tone={card.prWorking ? "green" : "amber"} className={card.prWorking ? "" : "bg-yellow-400"} />
                            </span>
                          )}
                          {card.blocker !== "" && (
                            <span title={card.blocker}>
                              <StatusDot tone="red" />
                            </span>
                          )}
                        </span>
                        <span className="truncate text-xs leading-tight text-muted-foreground">
                          {card.issue.repo} #{card.issue.number}
                        </span>
                      </span>
                    </span>
                    {card.tags.length > 0 && (
                      <span className="flex flex-wrap gap-1">
                        {card.tags.map((tag) => (
                          <Badge key={tag.label} variant={tag.variant} className={tag.className}>
                            {tag.label}
                          </Badge>
                        ))}
                      </span>
                    )}
                    <span className="flex flex-wrap gap-1 border-t pt-2">
                      {Object.keys(LEVEL_NAMES)
                        .filter((key) => card.level[key as keyof Level])
                        .map((key) => (
                          <Badge key={key} variant="outline">
                            {LEVEL_NAMES[key]}
                          </Badge>
                        ))}
                      {!Object.values(card.level).some((on) => on) && <Badge variant="outline">No automation</Badge>}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted-foreground">
                      {card.issue.facts && (
                        <span title={new Date(card.issue.facts.created_at).toLocaleString()}>Opened {timeAgo(card.issue.facts.created_at)}</span>
                      )}
                      <span className="flex items-center gap-1" title="Comments">
                        <MessageSquare className="size-3" />
                        {card.issue.facts?.comments ?? card.issue.comments}
                      </span>
                      <span className="ml-auto flex gap-1">
                        {card.column === "open" && card.movable && (
                          <Button
                            size="xs"
                            onClick={(event) => {
                              event.stopPropagation();
                              move(card, "catalog", null);
                            }}
                          >
                            Add
                          </Button>
                        )}
                        {card.column === "catalog" && card.movable && (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              move(card, "open", null);
                            }}
                          >
                            Cancel
                          </Button>
                        )}
                        {(card.column === "catalog" || card.column === "in_progress") && (
                          <Button
                            size="xs"
                            variant="secondary"
                            className={card.held ? "bg-ok/15 text-ok hover:bg-ok/25" : "bg-warn/15 text-warn hover:bg-warn/25"}
                            onClick={(event) => {
                              event.stopPropagation();
                              setHold(card, !card.held);
                            }}
                          >
                            {card.held ? "Resume" : "Pause"}
                          </Button>
                        )}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
              {column === "catalog" && over === column && overCard === null && canDrop(column) && (
                <div className="mt-1 h-0.5 shrink-0 rounded-full bg-primary" />
              )}
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.shortName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting !== null &&
              deleting.job !== null &&
              (deleting.column === "catalog" || deleting.column === "in_progress" || deleting.column === "review")
                ? "Its agent stops working on it, and no agent adds it again."
                : "No agent adds it again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {automation && <BoardAutomationDialog onClose={() => setAutomation(false)} />}
      {repoAutomation !== null && (
        <AutomationDialog
          repos={[repoAutomation]}
          onClose={() => {
            setRepoAutomation(null);
            setSaved((count) => count + 1);
          }}
        />
      )}
      {issueAutomation !== null && (
        <IssueAutomationDialog
          id={issueAutomation.issue.id}
          name={issueAutomation.shortName}
          level={issueAutomation.level}
          own={issueAutomation.ownLevel}
          onClose={() => {
            setIssueAutomation(null);
            setSaved((count) => count + 1);
          }}
        />
      )}

      <Dialog open={open !== null} onOpenChange={(value) => !value && setOpenId(null)}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{open?.shortName}</DialogTitle>
          </DialogHeader>
          {open !== null && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="min-w-0">
                <a href={open.issue.html_url} target="_blank" rel="noreferrer" className={link}>
                  #{open.issue.number} {open.issue.facts?.title ?? open.issue.title}
                </a>
              </dd>
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="min-w-0">
                <a href={`https://github.com/${open.issue.repo}`} target="_blank" rel="noreferrer" className={link}>
                  {open.issue.repo}
                </a>
              </dd>
              <dt className="text-muted-foreground">Agent</dt>
              <dd className="min-w-0">
                {open.job !== null ? (
                  <a href={`#/agents/${open.job.agent}`} className={link}>
                    {agentName}
                  </a>
                ) : (
                  <span className="text-muted-foreground">None yet</span>
                )}
              </dd>
              <dt className="text-muted-foreground">VM</dt>
              <dd className="min-w-0">
                {open.job !== null && open.job.vm !== null ? (
                  <a href={`#/vms/${encodeURIComponent(open.job.vm)}`} className={link}>
                    {open.job.vm}
                  </a>
                ) : (
                  <span className="text-muted-foreground">None yet</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Opened by</dt>
              <dd className="min-w-0">
                {author !== "" ? (
                  <a href={`https://github.com/${author}`} target="_blank" rel="noreferrer" className={link}>
                    {author}
                  </a>
                ) : (
                  <span className="text-muted-foreground">Unknown</span>
                )}
              </dd>
            </dl>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
