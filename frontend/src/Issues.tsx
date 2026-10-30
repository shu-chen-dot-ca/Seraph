/*
The Issues list: issues the agents picked, and what is being done about each one.

An issue's status comes from its latest job: no job = New, else queued / working / waiting on you / done
(a cancelled latest job counts as New again, so it can be reassigned). The bar on top has no tabs or filters, only
Active and the buttons; a link from another page may still show one repo's issues (#/issues?repo=owner/name, the
Repos page's link), then a chip with the repo's name and an X to show them all again.

Each row shows what helps decide whether an issue is worth fixing, from its facts (github_searcher/issue_facts.py,
kept fresh by the backend; Refresh on top fetches them all now, then has Claude read every open issue and its comments
again, to see if it is still free or anything changed; it spins until both are done, minutes for many, then says
which ones were free and aren't anymore): repo stars,
when it was opened, its last activity, when Claude last read it and updated its tags (Checked), comments,
and amber words when someone is assigned or a PR is open for it. The list is a table like the Repos and Explore
pages': #, Title (taking the room left over), then ISSUE_COLUMNS, every column as wide as its widest cell over the
rows shown (a hidden copy of them, the sizer at the bottom, measures them: lib/column-widths.ts), the text in the
page's own color (green / amber / red only where it means something). A click on a header adds that column to the
sort, the best first (most, newest, hardest, in progress; A to Z for text); again the other way round; again takes it
out. Many columns sort at once, Free first: then each sorted column to its right, to the end, then from the left (#,
Title, Repo) up to Free; with none, it is the list's order. Every sorted header is
blue with an arrow. A table wider than the page scrolls sideways, the header
with it. Times re-render every minute.

Marked (next to Free) says what the maintainers marked the issue with on GitHub, from its labels (only maintainers can
label an issue), each spelled however the repo spells it: Good first issue (green: good first issue, first-timers,
beginner, starter, newcomer), Help wanted (green: help wanted, contributions or PRs welcome, up for grabs, accepting
PRs) and Confirmed (accepted, confirmed, approved, triaged); "–" when none, and hovering shows all its labels. Sorted,
good first issue counts most, then help wanted, then confirmed, and one marked more ways goes higher.
GitHub's labels aren't shown otherwise: each issue carries the app's own tags instead, the same as on the Tracked page
(github_searcher/issue_tags.py, made by Claude in the background), each in its own column and sorted like the others:
Free (a newcomer can start now) or Assigned (someone is on it: an assignee, a claim, the author doing it), or
Self-assigned (blue: you are on it, your GitHub account from the GitHub tab's Account page is an assignee or has an
open PR for it; not counted as Assigned), or Closed (muted, whatever its tags say, when the issue is closed on GitHub;
it sorts last), its Kind, and
a Level: how hard the fix is for our agent in its sandbox VM, decided by fixed rules from eight yes / no checks Claude
answers (we can do it at all, it is free of politics, the goal is clear, it runs in our VM, its effect is easy to see,
easy to prove fixed, general programming knowledge is enough, the change stays local). Out of scope (grey): we don't
take it, whatever the rest says. Either our agent can't do it yet: it can't end as a pull request to this repo (the
project wants a new, separate repository, like a plugin or driver), or it only shows on macOS, Windows, a phone or
special hardware. Or it touches politics, in the issue or in what the repo is for: the app only does non-political
work, nothing politically sensitive or activist, and nothing that goes against another country's laws, such as
China's. Its Assign is greyed out.
easy: all yes, so the agent can vibe code it, see it and prove it in the VM; hard: it can't run in our VM, the change
ripples, or two or more are no; medium: one is no. The reason on hover ends with which checks failed. A level is kept once given: it changes only when the issue changes on GitHub. Tag again (in the issue's pop-up) has Claude read it again now.

A click on a row opens that issue in a pop-up (#/issues?open=<issue id>, keeping repo= when one repo's issues are
shown; the links from the Sidebar, Tracked and Jobs pages and Active open it the same way, also one the rows don't
show); the X, Esc or a click outside it closes it, back to the list. On its top: the repo, the # (to GitHub), how many
comments, the title (struck through and marked closed when it is), and the row's own buttons: Assign, the arrow to
GitHub and Remove (greyed out like the row's X; removing it closes the pop-up). Below, scrolling: the tags and why with
Tag again, the facts in full (author and role, last comment and who wrote it, assignees, linked PRs, the repo's last
push), the agent's note, the issue body and its comments below it, each with who wrote it and when (fetched from
GitHub each time it opens, so new comments show; the last one fetched shows meanwhile; the first 40 comments, past
that a line says how many more are on GitHub), and every job for the issue with its progress (steps and the agent's
headline), links to its agent, VM and drafts, and Cancel while it is in progress.
A job in progress shows in the row as a small progress bar with its step.
Assign (in the row and the pop-up; greyed out when the issue is out of scope) opens AssignDialog on top; the arrow button next to it (and the #) opens the issue on GitHub in a new tab.
Only the rows on screen are drawn, so thousands of issues stay fast. Undo / redo like the Repos page.
Many rows are picked like on the Repos page. Hovering a row shows its box on the left; ticking it picks that issue and
turns on select mode, like Select (on the right of the bar on top) does: Select stays lit (a click on it ends select
mode), every row shows its box, and a click picks the row instead of opening it. The box at the top left of the table's
header picks every row shown (checked when all are, a dash when some are); a click when all are picked unpicks them. Rows are also picked like in a mail app
(components/ui/row-selection.tsx): Ctrl-click, Shift-click, dragging a rectangle, Ctrl+A, which turns on select mode
too. A bar at the bottom then removes them at once, as one undo step (it asks first; Enter confirms). Clearing the
selection (Escape, the bar's x) ends select mode too.
Active (first in the bar on top) drops down every issue an agent is on now (its latest job queued, working or waiting
on you), whatever the repo: waiting on you first, then working, then queued. Each shows its title, the agent's
headline under it, the agent, and the same progress bar as the Status column; a click opens that issue in its pop-up
(like a link from the Jobs page). The sidebar lists the same issues under Issues.
Remove closed and assigned (in the bar on top) takes out every issue that is closed on GitHub or that someone else is
on (assigned on GitHub, or tagged Assigned; Self-assigned ones stay) in one go, whatever the repo, except ones an agent
here has a job for (its latest not cancelled); it asks first too, and is one undo step.
Nothing removes an issue an agent is working on (a job on it queued, working or waiting on you): its X is greyed
out, the bar at the bottom and Remove closed and assigned leave it out (the bottom bar's question says how many stay), and
undo / redo keep it too (the backend checks, for agents as well). Cancel its job first to remove it.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { Activity, ArrowDown, ArrowUp, ChevronDown, ExternalLink, Loader2, RefreshCw, Redo2, SquareCheck, Tags, Undo2, UserPlus, UserX, X } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import AssignDialog from "@/AssignDialog";
import { Badge } from "@/components/ui/badge";
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
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { JobProgressBar, JobSteps } from "@/components/ui/job-progress";
import { Markdown } from "@/components/ui/markdown";
import { RowSelection, SelectBox } from "@/components/ui/row-selection";
import { JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useLive, useLoaded, type GithubAccountStatus, type IssueItem, type Job, type Thread } from "@/live";
import { useColumnWidths } from "@/lib/column-widths";
import { cn, timeAgo } from "@/lib/utils";

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// GitHub's author association, said plainly. Owners, members and collaborators are the maintainers.
const ROLE: Record<string, string> = {
  OWNER: "owner",
  MEMBER: "maintainer",
  COLLABORATOR: "collaborator",
  CONTRIBUTOR: "contributor",
  FIRST_TIME_CONTRIBUTOR: "first-time contributor",
  FIRST_TIMER: "first-timer",
  MANNEQUIN: "",
  NONE: "",
  BOT: "bot",
};
const MAINTAINERS = ["OWNER", "MEMBER", "COLLABORATOR"];

type SortKey = "number" | "title" | "repo" | "free" | "marked" | "level" | "kind" | "stars" | "opened" | "active" | "read" | "comments" | "status" | "agent";

// The table's columns: # and Title (which takes the room left over), then the rest. All but Title are measured by the
// sizer. better says which way the first click on a header sorts: higher first, or A to Z.
type IssueColumn = { key: SortKey; label: string; title: string; better: "higher" | "text" };
const NUMBER_COLUMN: IssueColumn = { key: "number", label: "#", title: "Its number on GitHub, newest first", better: "higher" };
const TITLE_COLUMN: IssueColumn = { key: "title", label: "Title", title: "A to Z", better: "text" };
const ISSUE_COLUMNS: IssueColumn[] = [
  { key: "repo", label: "Repo", title: "The repo it is in", better: "text" },
  { key: "free", label: "Free", title: "Free first (a newcomer can start now), then self-assigned (you are on it), then not ready yet, then assigned, then closed", better: "higher" },
  { key: "marked", label: "Marked", title: "What the maintainers marked it with on GitHub: good first issue, help wanted (they want an outside PR) or confirmed. Hover for all its labels", better: "higher" },
  { key: "level", label: "Level", title: "How hard the fix is for our agent in its VM, by fixed rules: easy (it can write it, see it and prove it there), medium or hard; out of scope when we don't take it (our agent can't do it yet, or it touches politics)", better: "higher" },
  { key: "kind", label: "Kind", title: "Bug, docs, feature or question: A to Z", better: "text" },
  { key: "stars", label: "Stars", title: "The repo's stars", better: "higher" },
  { key: "opened", label: "Opened", title: "When the issue was opened on GitHub", better: "higher" },
  { key: "active", label: "Updated", title: "Its last change on GitHub: a comment, a label, an edit…", better: "higher" },
  { key: "read", label: "Checked", title: "When Claude last read it and its comments and updated its tags (Free, Level, Kind)", better: "higher" },
  { key: "comments", label: "Comments", title: "Comments", better: "higher" },
  { key: "status", label: "Status", title: "What is being done about it (its latest job): in progress first", better: "higher" },
  { key: "agent", label: "Agent", title: "The agent on its latest job", better: "text" },
];
const TITLE_MIN = 200;
// Assign and Remove at the end of each row.
const ACTIONS_WIDTH = 130;

// The order of a latest job's status, in progress first being the highest. No job (or a cancelled one) is New.
const STATUS_RANK: Record<string, number> = { waiting_on_user: 5, working: 4, queued: 3, new: 2, done: 1 };

// GitHub labels only maintainers can put on an issue, by what they say, for the Marked column. Every repo spells them
// its own way ("good first issue", "good-first-issue", "Good First Issue 👋", "help wanted", "status: accepted").
// Confirmed has word edges so "unconfirmed" and "untriaged" don't count.
const GOOD_FIRST = /good.?first|first.?timer|beginner|starter|newcomer/i;
const HELP_WANTED = /help.?wanted|contributions?.?welcome|prs?.?welcome|pull.?requests?.?welcome|up.?for.?grabs|accepting.?prs/i;
const CONFIRMED = /\b(accepted|confirmed|approved|triaged)\b/i;

// Free first when sorted (the same as on the Tracked page).
const FREE_RANK: Record<string, number> = { free: 4, selfAssigned: 3, waiting: 2, assigned: 1, closed: 0 };
// Difficulty levels: their order for sorting, their color (a soft Badge variant, like LeetCode's green / amber / red;
// grey when out of scope) and their name.
const LEVEL_RANK: Record<string, number> = { easy: 1, medium: 2, hard: 3, "out of scope": 4 };
const LEVEL_COLOR: Record<string, string> = { easy: "text-ok", medium: "text-warn", hard: "text-destructive", "out of scope": "text-muted-foreground" };
const LEVEL_VARIANT: Record<string, "ok" | "warn" | "bad" | "secondary"> = {
  easy: "ok",
  medium: "warn",
  hard: "bad",
  "out of scope": "secondary",
};
const LEVEL_LABEL: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard", "out of scope": "Out of scope" };
const OUT_OF_SCOPE = "Out of scope, so it can't be assigned (its Level says why)";

// open: the issue shown in the pop-up (#/issues?open=owner/name%23n), null when none is.
export default function Issues(props: { repo: string | null; open: string | null }) {
  const issues = useLive("issues");
  const repos = useLive("repos");
  const jobs = useLive("jobs");
  const agents = useLive("agents");
  const loaded = useLoaded("issues");
  // Each issue's text and comments, by id, as last fetched from GitHub for its pop-up.
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<IssueItem | null>(null);
  // Selected issues, the last one clicked (where a shift-click range starts), and whether removing them waits for a confirm.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  // Select mode: every row shows a box and a click picks it. Picking a row any other way shows the boxes too.
  const [selecting, setSelecting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRemoveClosedAndAssigned, setConfirmRemoveClosedAndAssigned] = useState(false);
  // Your GitHub account (the GitHub tab's Account page), to tell Self-assigned from Assigned.
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  // The list's order: as listed (none), or by these columns, from left to right as the table shows them, Title and #
  // last; best is the way a column's first click sorts, or not.
  const [sorts, setSorts] = useState<{ key: SortKey; best: boolean }[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // Issues Claude is reading again (Tag again).
  const [retagging, setRetagging] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The hidden copy of every shown row's cells (but the title's), and the widths it gives each column.
  const sizerRef = useRef<HTMLDivElement>(null);
  const sizes = useColumnWidths(sizerRef);

  // Who the GitHub account is: at first, and again when Account on the GitHub tab connects or disconnects one.
  useEffect(() => {
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then(setAccount)
        .catch(() => setAccount({ connected: false }));
    }
    load();
    window.addEventListener("github-account", load);
    return () => window.removeEventListener("github-account", load);
  }, []);

  // "3h ago" goes stale on its own: draw again every minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Latest job and all jobs of each issue, and agent names for the links.
  const latestJob: Record<string, Job> = {};
  const issueJobs: Record<string, Job[]> = {};
  for (const job of jobs) {
    if (job.issue === null) {
      continue;
    }
    issueJobs[job.issue] = [...(issueJobs[job.issue] ?? []), job];
    const current = latestJob[job.issue];
    if (current === undefined || job.created_at > current.created_at) {
      latestJob[job.issue] = job;
    }
  }
  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }
  const repoStars: Record<string, number> = {};
  for (const repo of repos.items) {
    repoStars[repo.full_name] = repo.stars;
  }

  // Issues an agent is working on: a job on it queued, working or waiting on you. Nothing here removes them (the
  // backend keeps them anyway).
  const workingIds: string[] = [];
  for (const job of jobs) {
    if (job.issue !== null && (job.status === "queued" || job.status === "working" || job.status === "waiting_on_user")) {
      workingIds.push(job.issue);
    }
  }

  // Issues you are on yourself: your GitHub account is an assignee, or has an open PR for it. They are Self-assigned,
  // not Assigned.
  const myLogin = (account?.login ?? "").toLowerCase();
  const selfAssignedIds: string[] = [];
  for (const issue of issues.items) {
    const assignees = issue.facts?.assignees ?? [];
    const pulls = issue.facts?.linked_prs ?? [];
    const isAssignee = assignees.some((name) => name.toLowerCase() === myLogin);
    const hasOpenPR = pulls.some((pull) => pull.state === "OPEN" && pull.author.toLowerCase() === myLogin);
    if (myLogin !== "" && (isAssignee || hasOpenPR)) {
      selfAssignedIds.push(issue.id);
    }
  }

  // Issues closed on GitHub, or someone else is on (assigned on GitHub, or tagged Assigned, but not Self-assigned),
  // that no agent here works on: no job, or the latest cancelled. Remove closed and assigned takes them all out.
  const closedAndAssignedIds = issues.items
    .filter((issue) => {
      const job = latestJob[issue.id];
      const isClosed = (issue.facts?.state ?? issue.state) === "CLOSED";
      const isAssigned = (issue.facts?.assignees.length ?? 0) > 0 || issue.tags?.status === "assigned";
      const isOthers = isAssigned && !selfAssignedIds.includes(issue.id);
      return (isClosed || isOthers) && (job === undefined || job.status === "cancelled") && !workingIds.includes(issue.id);
    })
    .map((issue) => issue.id);

  // Issues an agent is on now, for the Active menu: waiting on you first, then working, then queued; the latest
  // change first within each.
  const active = issues.items.filter((issue) => {
    const job = latestJob[issue.id];
    return job !== undefined && (job.status === "queued" || job.status === "working" || job.status === "waiting_on_user");
  });
  active.sort((a, b) => {
    const first = latestJob[a.id];
    const second = latestJob[b.id];
    if (first.status !== second.status) {
      return STATUS_RANK[second.status] - STATUS_RANK[first.status];
    }
    return second.updated_at.localeCompare(first.updated_at);
  });

  // Every issue, or one repo's when a link asked for it.
  const rows = issues.items.filter((issue) => props.repo === null || issue.repo === props.repo);

  // The value an issue sorts by in a column: a number, or text. null when it hasn't one (it goes last).
  function sortValue(issue: IssueItem, key: SortKey): number | string | null {
    const facts = issue.facts;
    const job = latestJob[issue.id];
    if (key === "number") {
      return issue.number;
    }
    if (key === "title") {
      return (facts?.title ?? issue.title).toLowerCase();
    }
    if (key === "repo") {
      return issue.repo.toLowerCase();
    }
    if (key === "free") {
      if ((facts?.state ?? issue.state) === "CLOSED") {
        return FREE_RANK.closed;
      }
      if (selfAssignedIds.includes(issue.id)) {
        return FREE_RANK.selfAssigned;
      }
      if (facts && facts.assignees.length > 0) {
        return FREE_RANK.assigned;
      }
      return issue.tags ? FREE_RANK[issue.tags.status] : null;
    }
    if (key === "marked") {
      // Good first issue counts most, then help wanted, then confirmed; an issue marked more than one way adds them up.
      const labels = facts?.labels ?? issue.labels;
      let rank = 0;
      if (labels.some((label) => GOOD_FIRST.test(label))) {
        rank += 4;
      }
      if (labels.some((label) => HELP_WANTED.test(label))) {
        rank += 2;
      }
      if (labels.some((label) => CONFIRMED.test(label))) {
        rank += 1;
      }
      return rank;
    }
    if (key === "level") {
      return issue.tags?.level ? (LEVEL_RANK[issue.tags.level] ?? null) : null;
    }
    if (key === "kind") {
      return issue.tags?.kind ?? null;
    }
    if (key === "stars") {
      return facts?.repo_stars ?? repoStars[issue.repo] ?? null;
    }
    if (key === "comments") {
      return facts?.comments ?? issue.comments;
    }
    if (key === "status") {
      return job === undefined || job.status === "cancelled" ? STATUS_RANK.new : (STATUS_RANK[job.status] ?? null);
    }
    if (key === "agent") {
      return job !== undefined ? (agentNames[job.agent] ?? job.agent).toLowerCase() : null;
    }
    if (key === "read") {
      return issue.tags ? new Date(issue.tags.judged_at).getTime() : null;
    }
    if (facts === null || facts === undefined) {
      return null;
    }
    return new Date(key === "opened" ? facts.created_at : facts.updated_at).getTime();
  }
  // The sort's order of columns: Free first, then each column to its right to the end, then from the left (#, Title,
  // Repo) up to Free.
  const allColumns = [NUMBER_COLUMN, TITLE_COLUMN, ...ISSUE_COLUMNS];
  const freeIndex = allColumns.findIndex((column) => column.key === "free");
  const sortOrder = [...allColumns.slice(freeIndex), ...allColumns.slice(0, freeIndex)];
  if (sorts.length > 0) {
    rows.sort((a, b) => {
      // The first sorted column in that order that tells them apart decides; when none does, the list's order stays.
      for (const column of sortOrder) {
        const sort = sorts.find((each) => each.key === column.key);
        if (sort === undefined) {
          continue;
        }
        const first = sortValue(a, column.key);
        const second = sortValue(b, column.key);
        if (first === second) {
          continue;
        }
        // Missing values go last, whichever way.
        if (first === null) {
          return 1;
        }
        if (second === null) {
          return -1;
        }
        // Low to high (A to Z for text), turned round when the best is the highest, and again for the other way.
        let order = typeof first === "string" && typeof second === "string" ? first.localeCompare(second) : Number(first) - Number(second);
        if (column.better === "higher") {
          order = -order;
        }
        if (order !== 0) {
          return sort.best ? order : -order;
        }
      }
      return 0;
    });
  }

  // A click adds a column to the sort (the best first), the next turns it round, the next takes it out.
  function clickSort(key: SortKey) {
    const sort = sorts.find((each) => each.key === key);
    if (sort === undefined) {
      setSorts([...sorts, { key, best: true }]);
    } else if (sort.best) {
      setSorts(sorts.map((each) => (each.key === key ? { key, best: false } : each)));
    } else {
      setSorts(sorts.filter((each) => each.key !== key));
    }
  }

  // A column's header: its label, and an arrow the way it sorts when it does.
  function sortHeader(column: IssueColumn) {
    const sort = sorts.find((each) => each.key === column.key);
    return (
      <button
        key={column.key}
        type="button"
        className={cn("flex min-w-0 items-center gap-0.5 hover:text-primary", sort !== undefined && "text-primary")}
        title={column.title}
        onClick={() => clickSort(column.key)}
      >
        <span className="truncate">{column.label}</span>
        {sort !== undefined && (sort.best ? <ArrowDown className="size-3 shrink-0" /> : <ArrowUp className="size-3 shrink-0" />)}
      </button>
    );
  }

  // What a measured column shows for an issue, in the page's own color: green / amber / red only where it means something.
  function issueCell(issue: IssueItem, key: SortKey) {
    const facts = issue.facts ?? null;
    const job = latestJob[issue.id];
    const thread = threads[issue.id];
    if (key === "number") {
      return (
        <a href={issue.html_url} target="_blank" rel="noreferrer" className="hover:underline" title="Open on GitHub" onClick={(event) => event.stopPropagation()}>
          #{issue.number}
        </a>
      );
    }
    if (key === "repo") {
      return issue.repo;
    }
    if (key === "free") {
      // – is not ready yet; … is not tagged yet. A closed issue says Closed, whatever its tags say.
      const state = facts !== null ? facts.state : issue.state;
      if (state === "CLOSED") {
        return (
          <span className="text-muted-foreground" title="Closed on GitHub">
            Closed
          </span>
        );
      }
      if (selfAssignedIds.includes(issue.id)) {
        return (
          <span className="text-primary" title="You are on it: your GitHub account is assigned, or has an open PR for it">
            Self-assigned
          </span>
        );
      }
      const isAssigned = (facts !== null && facts.assignees.length > 0) || issue.tags?.status === "assigned";
      if (isAssigned) {
        return (
          <span className="text-warn" title={facts !== null && facts.assignees.length > 0 ? `Assigned to ${facts.assignees.join(", ")}` : issue.tags?.reason}>
            Assigned
          </span>
        );
      }
      if (!issue.tags) {
        return <span title="Being tagged">…</span>;
      }
      if (issue.tags.status === "free") {
        return (
          <span className="text-ok" title={issue.tags.reason}>
            Free
          </span>
        );
      }
      return <span title={issue.tags.reason}>–</span>;
    }
    if (key === "marked") {
      const labels = facts !== null ? facts.labels : issue.labels;
      const goodFirst = labels.some((label) => GOOD_FIRST.test(label));
      const helpWanted = labels.some((label) => HELP_WANTED.test(label));
      const confirmed = labels.some((label) => CONFIRMED.test(label));
      const allLabels = labels.length > 0 ? `Its labels: ${labels.join(", ")}` : "No labels";
      if (!goodFirst && !helpWanted && !confirmed) {
        return <span title={allLabels}>–</span>;
      }
      return (
        <span className="whitespace-nowrap" title={allLabels}>
          {goodFirst && <span className="text-ok">Good first issue</span>}
          {goodFirst && (helpWanted || confirmed) && " · "}
          {helpWanted && <span className="text-ok">Help wanted</span>}
          {helpWanted && confirmed && " · "}
          {confirmed && "Confirmed"}
        </span>
      );
    }
    if (key === "kind") {
      if (!issue.tags?.kind) {
        return <span title={issue.tags ? issue.tags.reason : "Being tagged"}>{issue.tags ? "–" : "…"}</span>;
      }
      return (
        <span className="capitalize" title={issue.tags.reason}>
          {issue.tags.kind}
        </span>
      );
    }
    if (key === "level") {
      if (!issue.tags?.level) {
        return <span title={issue.tags ? issue.tags.reason : "Being tagged"}>{issue.tags ? "–" : "…"}</span>;
      }
      return (
        <span className={LEVEL_COLOR[issue.tags.level]} title={issue.tags.reason}>
          {LEVEL_LABEL[issue.tags.level]}
        </span>
      );
    }
    if (key === "stars") {
      const stars = facts !== null ? facts.repo_stars : repoStars[issue.repo];
      return stars !== undefined ? STARS.format(stars) : "–";
    }
    if (key === "opened") {
      return facts !== null ? <span title={new Date(facts.created_at).toLocaleString()}>{timeAgo(facts.created_at)}</span> : "–";
    }
    if (key === "active") {
      return facts !== null ? <span title={new Date(facts.updated_at).toLocaleString()}>{timeAgo(facts.updated_at)}</span> : "–";
    }
    if (key === "read") {
      return issue.tags ? <span title={new Date(issue.tags.judged_at).toLocaleString()}>{timeAgo(issue.tags.judged_at)}</span> : "–";
    }
    if (key === "comments") {
      return facts !== null ? facts.comments : thread !== undefined ? thread.comments.length : issue.comments;
    }
    if (key === "status") {
      if (job !== undefined && (job.status === "queued" || job.status === "working" || job.status === "waiting_on_user")) {
        return <JobProgressBar job={job} />;
      }
      return (
        <span className="flex items-center gap-1.5">
          <StatusDot tone={job === undefined ? "gray" : JOB_TONE[job.status]} />
          {job === undefined ? "New" : (JOB_LABEL[job.status] ?? job.status)}
        </span>
      );
    }
    if (key === "agent" && job !== undefined) {
      return (
        <a href={`#/agents/${job.agent}`} className="hover:underline" onClick={(event) => event.stopPropagation()}>
          {agentNames[job.agent] ?? job.agent}
        </a>
      );
    }
    return "";
  }

  // The columns' widths from the sizer (max-content until it has measured), and the grid the header and the rows
  // share: the boxes (always there, so a row's box can show on hover without the row moving), #, Title (the room left
  // over), the rest, then Assign / Remove. tableWidth is the least they need.
  const measured = sizes.length === ISSUE_COLUMNS.length + 1;
  let tableWidth = 24 + 16 + TITLE_MIN + ACTIONS_WIDTH + 16 * (ISSUE_COLUMNS.length + 3);
  const tracks: string[] = [];
  for (let index = 0; index < ISSUE_COLUMNS.length + 1; index++) {
    tracks.push(measured ? `${sizes[index]}px` : "max-content");
    tableWidth += measured ? sizes[index] : 0;
  }
  const template = `16px ${tracks[0]} minmax(${TITLE_MIN}px,1fr) ${tracks.slice(1).join(" ")} ${ACTIONS_WIDTH}px`;

  // Claude reads one issue again now, a few seconds to a minute; the new tags arrive through the live feed.
  async function tagAgain(id: string) {
    setRetagging((current) => [...current, id]);
    try {
      const result = await api<{ tagged: number; failed: string[] }>("/api/tags/refresh", { method: "POST", body: { ids: [id] } });
      if (result.failed.length > 0) {
        toast.error(`Could not tag ${id} again; the backend tries again later.`);
      }
    } catch (err) {
      toast.error(`Could not tag ${id} again: ${err instanceof Error ? err.message : err}`);
    }
    setRetagging((current) => current.filter((each) => each !== id));
  }

  // Refresh: every issue's facts from GitHub (seconds), then Claude reads every open one and its comments again (still
  // free? claimed? changed?), a few minutes for many; the pop-up's Tag again spins meanwhile.
  async function refreshAll() {
    const ids = issues.items.filter((issue) => (issue.facts?.state ?? issue.state) !== "CLOSED").map((issue) => issue.id);
    setRefreshing(true);
    try {
      const result = await api<{ refreshed: number; failed: string[] }>("/api/issues/refresh", { method: "POST" });
      if (result.failed.length > 0) {
        toast.error(`Could not refresh ${result.failed.join(", ")}`);
      }
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : err}`);
    }
    setRetagging((current) => [...current, ...ids]);
    try {
      const result = await api<{ tagged: number; failed: string[]; taken: string[] }>("/api/tags/refresh", { method: "POST", body: { ids } });
      if (result.failed.length > 0) {
        toast.error(`Could not read ${result.failed.length} of them again; the backend tries again later.`);
      }
      // The rows show it too: Free turns to Assigned or –, the reason on hover.
      if (result.taken.length > 0) {
        toast.warning(`No longer free: ${result.taken.join(", ")}`);
      } else {
        toast.success(`Read ${result.tagged} issues again; none that was free got taken.`);
      }
    } catch (err) {
      toast.error(`Could not read the issues again: ${err instanceof Error ? err.message : err}`);
    }
    setRetagging((current) => current.filter((each) => !ids.includes(each)));
    setRefreshing(false);
  }

  // Every row is one line, 28px high (h-7).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (index) => rows[index].id,
  });

  async function undo() {
    try {
      await api("/api/issues/undo", { method: "POST" });
    } catch (err) {
      toast.error(`Undo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function redo() {
    try {
      await api("/api/issues/redo", { method: "POST" });
    } catch (err) {
      toast.error(`Redo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(ids: string[]) {
    try {
      await api("/api/issues/remove", { method: "POST", body: { ids } });
      setSelected((current) => current.filter((id) => !ids.includes(id)));
      setSelecting(false);
    } catch (err) {
      toast.error(`Could not remove: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Only issues still in the list count as selected (an undo, an agent or another tab may have taken some out).
  const rowIds = rows.map((issue) => issue.id);
  const listedIds = issues.items.map((issue) => issue.id);
  const chosen = selected.filter((id) => listedIds.includes(id));
  // The picked ones the bottom bar may remove: not the ones an agent is working on.
  const removable = chosen.filter((id) => !workingIds.includes(id));

  // A ctrl-click picks or unpicks one row; a shift-click does the same to every row shown from the last one clicked.
  function select(id: string, shift: boolean) {
    const on = !chosen.includes(id);
    let ids = [id];
    if (shift && anchor !== null && rowIds.includes(anchor)) {
      const from = rowIds.indexOf(anchor);
      const to = rowIds.indexOf(id);
      ids = rowIds.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !ids.includes(each)), ...ids] : chosen.filter((each) => !ids.includes(each)));
    setAnchor(id);
  }

  // Clearing the selection (Escape, the bar's x, a click on the list's empty space) also ends select mode.
  function onSelect(next: string[]) {
    setSelected(next);
    if (next.length === 0) {
      setSelecting(false);
    }
  }
  const selectMode = selecting || chosen.length > 0;
  const allPicked = rowIds.length > 0 && rowIds.every((id) => chosen.includes(id));

  async function cancelJob(job: Job) {
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not cancel ${job.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Each time an issue opens in the pop-up, its text and comments come from GitHub again, so new comments show; the
  // ones fetched before show meanwhile.
  useEffect(() => {
    const id = props.open;
    if (id === null) {
      return;
    }
    setThreadErrors((current) => ({ ...current, [id]: "" }));
    api<Thread>(`/api/issues/thread?id=${encodeURIComponent(id)}`)
      .then((thread) => setThreads((current) => ({ ...current, [id]: thread })))
      .catch((err) => setThreadErrors((current) => ({ ...current, [id]: err instanceof Error ? err.message : String(err) })));
  }, [props.open]);

  // The page's address with no issue open: the list, of one repo when it shows one.
  const listHash = props.repo !== null ? `#/issues?repo=${encodeURIComponent(props.repo)}` : "#/issues";

  // The issue open in the pop-up, looked up in all issues (a link may open one the rows don't show), and what it shows.
  const shown = issues.items.find((issue) => issue.id === props.open);
  const shownFacts = shown?.facts ?? null;
  const shownTags = shown?.tags ?? null;
  const shownThread = props.open !== null ? threads[props.open] : undefined;
  const shownError = props.open !== null ? (threadErrors[props.open] ?? "") : "";
  const shownComments = shownFacts !== null ? shownFacts.comments : shownThread !== undefined ? shownThread.comments.length : (shown?.comments ?? 0);
  const shownState = shownFacts !== null ? shownFacts.state : shown?.state;
  const shownSelfAssigned = shown !== undefined && selfAssignedIds.includes(shown.id);
  const shownAssigned = ((shownFacts !== null && shownFacts.assignees.length > 0) || shownTags?.status === "assigned") && !shownSelfAssigned;
  const shownJobs = props.open !== null ? [...(issueJobs[props.open] ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z), unless typing in a field or a dialog is open.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || assigning !== null) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey && issues.can_undo) {
        event.preventDefault();
        undo();
      } else if ((key === "y" || (key === "z" && event.shiftKey)) && issues.can_redo) {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        {/* Not modal: its links open an issue's pop-up as it closes, and a modal menu could leave the page unclickable. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" title="Every issue an agent is on now, and how far it got">
              <Activity /> Active <span className={cn("text-xs tabular-nums", active.length > 0 ? "text-primary" : "text-muted-foreground")}>{active.length}</span>
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[36rem] max-w-[calc(100vw-2rem)]">
            {active.length === 0 && <div className="px-2 py-1 text-muted-foreground">No agent is on an issue now.</div>}
            {active.map((issue) => {
              const job = latestJob[issue.id];
              return (
                <DropdownMenuItem key={issue.id} asChild>
                  <a href={`#/issues?open=${encodeURIComponent(issue.id)}`} className="grid grid-cols-[minmax(0,1fr)_96px_180px] gap-3">
                    <span className="min-w-0">
                      <span className="block truncate">{issue.facts?.title ?? issue.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">{job.headline !== "" ? `${issue.id} · ${job.headline}` : issue.id}</span>
                    </span>
                    <span className="truncate">{agentNames[job.agent] ?? job.agent}</span>
                    <JobProgressBar job={job} />
                  </a>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Only after a link to one repo's issues (the Repos page's); the X shows them all again. */}
        {props.repo !== null && (
          <span className="flex items-center gap-1 rounded-md border border-primary pl-2 text-primary">
            {props.repo}
            <Button variant="ghost" size="icon-xs" aria-label="Show every repo's issues" title="Show every repo's issues" onClick={() => (window.location.hash = "#/issues")}>
              <X />
            </Button>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant={selectMode ? "secondary" : "ghost"} size="sm"
            disabled={!selectMode && rowIds.length === 0}
            title={selectMode ? "Stop selecting (Esc)" : "Pick rows: every row shows its box, and a click picks it"}
            onClick={() => (selectMode ? onSelect([]) : setSelecting(true))}
          >
            <SquareCheck /> Select
          </Button>
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" disabled={refreshing} onClick={refreshAll}>
              <RefreshCw className={cn(refreshing && "animate-spin")} /> Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent>Get every issue from GitHub again and have Claude read every open one and its comments again: still free, or did anything change? A few minutes for many.</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" disabled={closedAndAssignedIds.length === 0} onClick={() => setConfirmRemoveClosedAndAssigned(true)}>
              <UserX /> Remove closed and assigned
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove every issue that is closed on GitHub or someone else is on: assigned on GitHub, or a claim Claude found in the comments. Self-assigned ones and ones your agents have a job for stay.</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" disabled={!issues.can_undo} onClick={undo} aria-label="Undo">
              <Undo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" disabled={!issues.can_redo} onClick={redo} aria-label="Redo">
              <Redo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: tableWidth }}>
          <div className="sticky top-0 z-10 border-b bg-background select-none">
            <div className="grid h-7 items-center gap-x-4 bg-muted/40 px-3 text-xs font-medium" style={{ gridTemplateColumns: template }}>
              {/* Top left: picks every issue shown, or none when all are; a dash when only some are. */}
              <button
                type="button"
                className="flex items-center"
                aria-label={allPicked ? "Unselect all" : "Select all"}
                title={allPicked ? "Unselect all" : "Select all (Ctrl+A)"}
                disabled={rowIds.length === 0}
                onClick={() => (allPicked ? onSelect([]) : setSelected([...new Set([...chosen, ...rowIds])]))}
              >
                <SelectBox checked={allPicked} partial={rowIds.some((id) => chosen.includes(id))} />
              </button>
              {sortHeader(NUMBER_COLUMN)}
              {sortHeader(TITLE_COLUMN)}
              {ISSUE_COLUMNS.map((column) => sortHeader(column))}
              <span />
            </div>
          </div>
          {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
          {loaded && issues.items.length === 0 && (
            <div className="px-3 py-2 text-muted-foreground">No issues yet. Agents add good first issues here while they search.</div>
          )}
          {loaded && issues.items.length > 0 && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">No issue matches.</div>}

          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const issue = rows[item.index];
              const facts = issue.facts ?? null;
              const state = facts !== null ? facts.state : issue.state;
              const openPRs = facts !== null ? facts.linked_prs.filter((pull) => pull.state === "OPEN") : [];
              const mergedPRs = facts !== null ? facts.linked_prs.filter((pull) => pull.state === "MERGED") : [];
              return (
                <div
                  key={item.key}
                  data-select-id={issue.id}
                  className={cn(
                    "group absolute left-0 grid h-7 w-full cursor-pointer items-center gap-x-4 border-b px-3 hover:bg-accent/50",
                    issue.id === props.open && "bg-accent/40",
                    chosen.includes(issue.id) && "bg-selected hover:bg-selected",
                  )}
                  style={{ top: item.start, gridTemplateColumns: template }}
                  onClick={(event) => {
                    // In select mode a click picks the row; otherwise Ctrl / Shift-click picks it and a plain click opens it in the pop-up.
                    if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) {
                      select(issue.id, event.shiftKey);
                    } else if (props.repo !== null) {
                      window.location.hash = `${listHash}&open=${encodeURIComponent(issue.id)}`;
                    } else {
                      window.location.hash = `#/issues?open=${encodeURIComponent(issue.id)}`;
                    }
                  }}
                >
                  {/* Out of select mode only on hover. Ticking it picks the issue, which turns select mode on. */}
                  <button
                    type="button"
                    className={cn("flex items-center", !selectMode && "invisible group-hover:visible")}
                    aria-label={`Select ${issue.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      select(issue.id, event.shiftKey);
                    }}
                  >
                    <SelectBox checked={chosen.includes(issue.id)} />
                  </button>
                  <span className="whitespace-nowrap tabular-nums">{issueCell(issue, "number")}</span>
                  {/* The title, then what to know before taking it: closed, PRs open or merged for it (the tags have their columns). */}
                  <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                    <span className={cn("truncate", state === "CLOSED" && "line-through")}>{facts !== null ? facts.title : issue.title}</span>
                    {state === "CLOSED" && <Badge variant="secondary">closed</Badge>}
                    {/* Each PR linked to it on GitHub; the open ones first, at most three. */}
                    {[...openPRs, ...mergedPRs].slice(0, 3).map((pull) => (
                      <Badge key={pull.url} asChild variant={pull.state === "OPEN" ? "warn" : "secondary"}>
                        <a href={pull.url} target="_blank" rel="noreferrer" title={`Open on GitHub: by ${pull.author}`} onClick={(event) => event.stopPropagation()}>
                          PR #{pull.number} {pull.state === "OPEN" ? "open" : "merged"}
                        </a>
                      </Badge>
                    ))}
                    {openPRs.length + mergedPRs.length > 3 && <Badge variant="secondary">+{openPRs.length + mergedPRs.length - 3}</Badge>}
                  </span>
                  {ISSUE_COLUMNS.map((column) => (
                    <span key={column.key} className="min-w-0 truncate whitespace-nowrap tabular-nums">
                      {issueCell(issue, column.key)}
                    </span>
                  ))}
                  <span className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      title={issue.tags?.level === "out of scope" ? OUT_OF_SCOPE : "Give this issue to an agent"}
                      disabled={issue.tags?.level === "out of scope"}
                      onClick={(event) => {
                        event.stopPropagation();
                        setAssigning(issue);
                      }}
                    >
                      <UserPlus /> Assign
                    </Button>
                    <Button variant="ghost" size="icon-xs" asChild>
                      <a href={issue.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${issue.id} on GitHub`} title="Open on GitHub" onClick={(event) => event.stopPropagation()}>
                        <ExternalLink />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${issue.id}`}
                      title={workingIds.includes(issue.id) ? "An agent is working on it: cancel its job first to remove it" : "Remove from the list"}
                      disabled={workingIds.includes(issue.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        remove([issue.id]);
                      }}
                    >
                      <X />
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Hidden: every shown row's cells (but the title's) at their own width in max-content columns, so useColumnWidths
          can read how wide each column has to be for its widest cell. The header labels count too, with room for the
          arrow a sorted one shows. */}
      <div
        ref={sizerRef}
        aria-hidden
        className="invisible absolute top-0 left-0 -z-10 grid h-0 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${ISSUE_COLUMNS.length + 1}, max-content)` }}
      >
        {[NUMBER_COLUMN, ...ISSUE_COLUMNS].map((column) => (
          <span key={column.key} className="flex items-center gap-0.5 text-xs font-medium">
            {column.label}
            <ArrowDown className="size-3" />
          </span>
        ))}
        {rows.map((issue) => (
          <Fragment key={issue.id}>
            {[NUMBER_COLUMN, ...ISSUE_COLUMNS].map((column) => (
              <span key={column.key} className="whitespace-nowrap tabular-nums">
                {issueCell(issue, column.key)}
              </span>
            ))}
          </Fragment>
        ))}
      </div>

      <RowSelection listRef={scrollRef} ids={rowIds} selected={chosen} onSelect={onSelect}>
        <Button
          size="xs"
          variant="ghost"
          disabled={removable.length === 0}
          title={removable.length === 0 ? "Agents are working on all of them: cancel their jobs first to remove them" : undefined}
          onClick={() => setConfirmRemove(true)}
        >
          <X /> Remove
        </Button>
      </RowSelection>

      {assigning !== null && <AssignDialog key={assigning.id} issue={assigning} onClose={() => setAssigning(null)} />}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removable.length} {removable.length === 1 ? "issue" : "issues"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They leave the Issues list; their jobs stay. Undo brings them back.
              {chosen.length > removable.length &&
                ` ${chosen.length - removable.length} of the picked ${chosen.length - removable.length === 1 ? "one stays" : "ones stay"}: an agent is working on ${chosen.length - removable.length === 1 ? "it" : "them"}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(removable)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRemoveClosedAndAssigned} onOpenChange={setConfirmRemoveClosedAndAssigned}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {closedAndAssignedIds.length} closed and assigned {closedAndAssignedIds.length === 1 ? "issue" : "issues"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They are closed on GitHub, or someone else is on them: assigned on GitHub, or a claim Claude found in the comments. Self-assigned ones and ones your agents have a job for stay. Undo brings them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(closedAndAssignedIds)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The open issue in full (props.open). The X, Esc or a click outside goes back to the list. */}
      <Dialog
        open={props.open !== null}
        onOpenChange={(open) => {
          if (!open) {
            window.location.hash = listHash;
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          {shown === undefined && props.open !== null && (
            <div className="flex flex-1 items-center justify-center">
              <DialogTitle className="font-normal text-muted-foreground">{loaded ? `There is no issue ${props.open}.` : "Loading…"}</DialogTitle>
            </div>
          )}
          {shown !== undefined && (
            <>
              {/* On top: where it is, how many comments, the title, and the row's own buttons (clear of the pop-up's X). */}
              <div className="shrink-0 space-y-2 border-b pt-3 pr-10 pb-3 pl-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span className="text-foreground">{shown.repo}</span>
                  <span className="tabular-nums">{issueCell(shown, "number")}</span>
                  <span>
                    {shownComments} {shownComments === 1 ? "comment" : "comments"}
                  </span>
                  <span className="ml-auto flex items-center gap-0.5 text-foreground">
                    <Button
                      variant="ghost"
                      size="xs"
                      title={shownTags?.level === "out of scope" ? OUT_OF_SCOPE : "Give this issue to an agent"}
                      disabled={shownTags?.level === "out of scope"}
                      onClick={() => setAssigning(shown)}
                    >
                      <UserPlus /> Assign
                    </Button>
                    <Button variant="ghost" size="icon-xs" asChild>
                      <a href={shown.html_url} target="_blank" rel="noreferrer" aria-label={`Open ${shown.id} on GitHub`} title="Open on GitHub">
                        <ExternalLink />
                      </a>
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      title={workingIds.includes(shown.id) ? "An agent is working on it: cancel its job first to remove it" : "Remove from the list"}
                      disabled={workingIds.includes(shown.id)}
                      onClick={() => {
                        // It leaves the list, so the pop-up closes too.
                        window.location.hash = listHash;
                        remove([shown.id]);
                      }}
                    >
                      <X /> Remove
                    </Button>
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <DialogTitle className={cn("leading-normal", shownState === "CLOSED" && "line-through")}>{shownFacts !== null ? shownFacts.title : shown.title}</DialogTitle>
                  {shownState === "CLOSED" && <Badge variant="secondary">closed</Badge>}
                </div>
              </div>

              {/* Below, scrolling: the tags, the facts, the agent's note, the text and its comments, and the jobs. */}
              <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
                {shownTags !== null ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {shownSelfAssigned && <Badge>self-assigned</Badge>}
                    {shownAssigned && <Badge variant="warn">assigned</Badge>}
                    {!shownAssigned && !shownSelfAssigned && shownState !== "CLOSED" && shownTags.status === "free" && <Badge variant="ok">free</Badge>}
                    {shownTags.level !== null && (
                      <Badge variant={LEVEL_VARIANT[shownTags.level] ?? "secondary"}>{LEVEL_LABEL[shownTags.level]}</Badge>
                    )}
                    {shownTags.kind !== null && <Badge variant="secondary">{shownTags.kind}</Badge>}
                    <span>{shownTags.reason}</span>
                    <Button variant="ghost" size="xs" disabled={retagging.includes(shown.id)} title="Claude reads it and its comments again now" onClick={() => tagAgain(shown.id)}>
                      {retagging.includes(shown.id) ? <Loader2 className="animate-spin" /> : <Tags />} Tag again
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Reading it to tag it…
                  </div>
                )}

                {shownFacts === null && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Getting the facts from GitHub…
                  </div>
                )}
                {shownFacts !== null && (
                  <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <span className="text-muted-foreground">Opened</span>
                    <span>
                      {timeAgo(shownFacts.created_at)} by {shownFacts.author}
                      {ROLE[shownFacts.author_role] && (
                        <span className={MAINTAINERS.includes(shownFacts.author_role) ? "text-ok" : "text-muted-foreground"}> · {ROLE[shownFacts.author_role]}</span>
                      )}
                    </span>

                    <span className="text-muted-foreground">Last activity</span>
                    <span>{timeAgo(shownFacts.updated_at)}</span>

                    <span className="text-muted-foreground">Last comment</span>
                    <span>
                      {shownFacts.last_comment_at === null && <span className="text-muted-foreground">No comments yet</span>}
                      {shownFacts.last_comment_at !== null && (
                        <>
                          {timeAgo(shownFacts.last_comment_at)} by {shownFacts.last_comment_by}
                          {shownFacts.last_comment_role !== null && ROLE[shownFacts.last_comment_role] && (
                            <span className={MAINTAINERS.includes(shownFacts.last_comment_role) ? "text-ok" : "text-muted-foreground"}>
                              {" "}
                              · {ROLE[shownFacts.last_comment_role]}
                            </span>
                          )}
                          <span className="text-muted-foreground"> · {shownFacts.comments} in all</span>
                        </>
                      )}
                    </span>

                    <span className="text-muted-foreground">Interest</span>
                    <span>
                      {shownFacts.participants} {shownFacts.participants === 1 ? "person" : "people"} in the thread · {shownFacts.thumbs_up} thumbs up
                    </span>

                    <span className="text-muted-foreground">Assigned</span>
                    <span className={shownFacts.assignees.length > 0 ? "text-warn" : "text-muted-foreground"}>
                      {shownFacts.assignees.length > 0 ? shownFacts.assignees.join(", ") : "Nobody"}
                    </span>

                    <span className="text-muted-foreground">Linked PRs</span>
                    <span className="flex flex-wrap gap-x-3">
                      {shownFacts.linked_prs.length === 0 && <span className="text-muted-foreground">None</span>}
                      {shownFacts.linked_prs.map((pull) => (
                        <a
                          key={pull.url}
                          href={pull.url}
                          target="_blank"
                          rel="noreferrer"
                          className={cn("hover:underline", pull.state === "OPEN" ? "text-warn" : "text-muted-foreground")}
                        >
                          {pull.repo !== shown.repo && pull.repo}#{pull.number} {pull.state.toLowerCase()} by {pull.author}
                        </a>
                      ))}
                    </span>

                    <span className="text-muted-foreground">Repo</span>
                    <span>
                      {STARS.format(shownFacts.repo_stars)} stars · last push {timeAgo(shownFacts.repo_pushed_at)}
                    </span>

                    <span className="col-span-2 text-xs text-muted-foreground">From GitHub {timeAgo(shownFacts.fetched_at)}</span>
                  </div>
                )}

                {shown.note !== "" && (
                  <div className="border-l-2 border-muted-foreground/30 pl-3">
                    <div className="text-xs font-medium text-muted-foreground">Agent's note</div>
                    <div className="whitespace-pre-wrap">{shown.note}</div>
                  </div>
                )}

                {shownThread === undefined && shownError === "" && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Loading the issue…
                  </div>
                )}
                {shownError !== "" && <div className="text-destructive">Could not load the issue: {shownError}</div>}
                {shownThread !== undefined && (
                  <div className="border bg-background px-4 py-3">
                    <Markdown text={shownThread.body || "*No description.*"} repo={shown.repo} issueRefs />
                  </div>
                )}
                {/* The comments below the text, oldest first: claims like "can I take this?" and the answers. */}
                {shownThread !== undefined &&
                  shownThread.comments.map((comment, index) => (
                    <div key={index} className="border bg-background px-4 py-2">
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{comment.author}</span>
                        <span title={new Date(comment.at).toLocaleString()}>{timeAgo(comment.at)}</span>
                      </div>
                      <Markdown text={comment.body} repo={shown.repo} issueRefs />
                    </div>
                  ))}
                {shownThread !== undefined && shownComments > shownThread.comments.length && (
                  <a href={shown.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    {shownComments - shownThread.comments.length} more on GitHub <ExternalLink className="size-3" />
                  </a>
                )}

                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Jobs</div>
                  {shownJobs.length === 0 && <div className="text-muted-foreground">No jobs yet. Use Assign to give this issue to an agent.</div>}
                  {shownJobs.map((each) => (
                    <div key={each.id} className="border-b py-1 last:border-b-0">
                      <div className="flex h-6 items-center gap-3">
                        <span className="flex w-28 shrink-0 items-center gap-1.5">
                          <StatusDot tone={JOB_TONE[each.status]} />
                          {JOB_LABEL[each.status] ?? each.status}
                        </span>
                        <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{each.id}</span>
                        <a href={`#/agents/${each.agent}`} className="shrink-0 text-primary hover:underline">
                          {agentNames[each.agent] ?? each.agent}
                        </a>
                        {each.vm !== null && (
                          <a href={`#/vms/${each.vm}`} className="shrink-0 text-primary hover:underline">
                            {each.vm}
                          </a>
                        )}
                        {each.drafts.map((draft) => (
                          <a key={draft} href={`#/inbox/${draft}`} className="shrink-0 font-mono text-xs text-primary hover:underline">
                            {draft}
                          </a>
                        ))}
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(each.created_at).toLocaleString()}</span>
                        {(each.status === "queued" || each.status === "working" || each.status === "waiting_on_user") && (
                          <Button variant="ghost" size="xs" onClick={() => cancelJob(each)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                      {(each.status === "working" || each.status === "waiting_on_user" || each.step !== null) && (
                        <div className="space-y-1 py-1 pl-[124px]">
                          <JobSteps job={each} />
                          {each.headline !== "" && <div>{each.headline}</div>}
                        </div>
                      )}
                      {each.instructions !== "" && <div className="pl-[124px] whitespace-pre-wrap text-muted-foreground">Instructions: {each.instructions}</div>}
                      {each.notes !== "" && <div className="pl-[124px] whitespace-pre-wrap text-muted-foreground">{each.notes}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
