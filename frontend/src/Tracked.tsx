/*
The Tracked list: repos the user wants to keep an eye on for new issues. The user tracks them from the Repos page (its
Track column); agents can add and remove them too (their tracked_* tools), and undo / redo (Ctrl+Z / Ctrl+Y) works on
both, like Repos. The bar on top has Expand all (Collapse all when every row is open), Refresh all (Check now for
every repo) and Mark all as read (every issue new now isn't anymore; only ones found later are new).

The backend checks each repo's open issues every few minutes (github_searcher/tracked_issues.py): the newest
ones and every good first or help wanted one. An issue is new for three days after it was opened, assigned or not,
unless Mark all as read saw it; the row shows how many are new, the sidebar the total. Check now asks GitHub at once.

GitHub's labels aren't shown: each issue carries the app's own tags instead, the same as on the Issues page
(github_searcher/issue_tags.py, made by Claude in the background): Free or Assigned, Easy / Medium / Hard (how hard
the fix is for our agent in its VM, by fixed rules, the same as on the Issues page; kept until the issue changes), and
its kind, each in its own column, the reason on hover. Assigned on GitHub counts as Assigned at once, without waiting
for the tags. Tag again (on the repo's row) has Claude read all its unassigned issues again now.

The list is a table like the Explore page's: Name and its description under it, then TRACKED_COLUMNS: first the
repo's tags (its signals, the same as the Repos page's columns: AI policy, newcomers, reply speed, review tone,
activity, contributors, maintainers, unanswered PRs; hover a tag for what it means), then its issues' numbers. Every
column is as wide as its widest cell (one CSS grid, each row a subgrid) and all of them sit on the left, the room left
over going before the row's buttons. The text is in the page's own color (blue for new issues, green for free ones,
red for a failed check; the tags' own colors). A click on a header adds that column to the sort, the best first (the
most, the latest check, the fastest reply, the friendliest tag; A to Z for the name); again the other way round; again
takes it out. Many columns sort at once, Free first: then each sorted column to its right, to the end, then from the
left (Name, AI policy, ...) up to Free; with none, it is the list's order. Every sorted header is blue with an arrow.

Each row opens in place to its issues, newest first, with tabs Free (a newcomer can start on it now) / Assigned (someone is on it) / All (Free when there are free
ones). The issues are a table too, sorted the same way by clicks on its columns' headers (one order for every open
repo; Free first, then to its right to the end, then # and Title): ISSUE_HEADERS. A click on an issue opens it in full in a pop-up, its comments below (IssueDetailsDialog); its # and the
arrow button at the row's end open it on GitHub in a new tab. An issue goes into the Issues list with one click (its
repo into Repos too), or links there when it is in already. The list is short (repos the user picked), so every row is drawn; times re-render every minute.
Many rows are picked like in a mail app (components/ui/row-selection.tsx): Ctrl-click, Shift-click, dragging a rectangle,
Ctrl+A; a bar at the bottom then stops tracking them at once, as one undo step (it asks first; Enter confirms).
*/

import { ArrowDown, ArrowUp, CheckCheck, ChevronsDownUp, ChevronsUpDown, ExternalLink, Loader2, MessageSquare, Plus, RefreshCw, Star, Tags, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import IssueDetailsDialog from "@/IssueDetailsDialog";
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
import { NewcomersTag, PolicyTag, ToneTag } from "@/components/ui/repo-tags";
import { RowSelection } from "@/components/ui/row-selection";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type TrackedIssue, type TrackedRepo } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// The columns after Name, each sorted by a click on its header: the best first (the most, the latest; the least for
// lower: the fastest reply). First the repo's tags, from its signals (the same as the Repos page's columns).
type TrackedKey =
  | "name"
  | "ai_policy"
  | "newcomers"
  | "reply"
  | "reviews"
  | "activity"
  | "contributors"
  | "maintainers"
  | "unanswered"
  | "stars"
  | "new"
  | "free"
  | "easy"
  | "open"
  | "checked";
const TRACKED_COLUMNS: { key: TrackedKey; label: string; title: string; better?: "lower" }[] = [
  { key: "ai_policy", label: "AI policy", title: "What its contribution files say about AI: the most open first" },
  { key: "newcomers", label: "Newcomers", title: "How newcomers' first PRs fare: the most welcoming first" },
  { key: "reply", label: "Reply", title: "Median days until outside contributors' PRs get a first reply: the fastest first", better: "lower" },
  { key: "reviews", label: "Reviews", title: "How maintainers' feedback on outside PRs feels: the warmest first" },
  { key: "activity", label: "Activity", title: "PRs, issues and commits a month (90-day average); sorts by commits a month" },
  { key: "contributors", label: "Contributors", title: "People who opened a PR lately (the newest 100 PRs, at most 90 days; bots not counted)" },
  { key: "maintainers", label: "Maintainers", title: "People who merged a PR in the last 30 days" },
  { key: "unanswered", label: "Unanswered", title: "Outside contributors' PRs open over 30 days that nobody answered" },
  { key: "stars", label: "Stars", title: "Stars on GitHub" },
  { key: "new", label: "New", title: "Open issues opened in the last 3 days and not marked read, assigned or not" },
  { key: "free", label: "Free", title: "Open issues a newcomer can start on now: nobody is on it and the maintainers want it done" },
  { key: "easy", label: "Easy", title: "Free issues that are easy: our agent can write the fix, see it and prove it in its VM" },
  { key: "open", label: "Open", title: "Open issues its last check found" },
  { key: "checked", label: "Checked", title: "When the backend last asked GitHub" },
];
// The tags' order for sorting, the friendliest highest (the same as the Repos page's).
const POLICY_RANK: Record<string, number> = { welcome: 5, disclose: 4, none: 3, unclear: 2, no_ai: 1 };
const NEWCOMER_RANK: Record<string, number> = { welcomes: 4, ok: 3, few: 2, wait: 1 };
const TONE_RANK: Record<string, number> = { warm: 4, neutral: 3, strict: 2, curt: 1 };
// An open repo's issues: #, Title (the room left over), the tags (Free, Level, Kind), Opened, Updated, comments, then
// GitHub and Add.
const ISSUE_COLUMNS = "grid grid-cols-[56px_minmax(0,1fr)_72px_64px_72px_150px_80px_36px_120px] items-center gap-2";
type IssueKey = "number" | "title" | "free" | "level" | "kind" | "opened" | "updated" | "comments";
const ISSUE_HEADERS: { key: IssueKey; label: string; title: string }[] = [
  { key: "number", label: "#", title: "Its number on GitHub, newest first" },
  { key: "title", label: "Title", title: "A to Z" },
  { key: "free", label: "Free", title: "Free first (a newcomer can start now), then not ready yet, then assigned" },
  { key: "level", label: "Level", title: "How hard the fix is for our agent in its VM, by fixed rules: easy (it can write it, see it and prove it there), medium or hard; the hardest first" },
  { key: "kind", label: "Kind", title: "Bug, docs, feature or question: A to Z" },
  { key: "opened", label: "Opened", title: "When it was opened on GitHub, newest first" },
  { key: "updated", label: "Updated", title: "Its last change on GitHub: a comment, a label, an edit…; the latest first" },
  { key: "comments", label: "", title: "Comments, the most first" },
];
// The tags' order for sorting and their colors (the same as on the Issues page): levels like LeetCode's green / amber / red.
const FREE_RANK: Record<string, number> = { free: 3, waiting: 2, assigned: 1 };
const LEVEL_RANK: Record<string, number> = { easy: 1, medium: 2, hard: 3 };
const LEVEL_COLOR: Record<string, string> = { easy: "text-ok", medium: "text-warn", hard: "text-destructive" };

type IssueTab = "free" | "assigned" | "all";

export default function Tracked() {
  const tracked = useLive("tracked");
  const issues = useLive("issues");
  const loaded = useLoaded("tracked");
  const [open, setOpen] = useState<string[]>([]);
  const [tabs, setTabs] = useState<Record<string, IssueTab>>({});
  const [checking, setChecking] = useState<string[]>([]);
  const [retagging, setRetagging] = useState<string[]>([]);
  // The issue open in the pop-up, by repo and number, so it shows the live one (new tags arrive while it is open).
  const [details, setDetails] = useState<{ repo: string; number: number } | null>(null);
  // The open repos' issues' order: newest first (none), or by these columns, like the list's.
  const [issueSorts, setIssueSorts] = useState<{ key: IssueKey; best: boolean }[]>([]);
  // The list's order: as tracked (none), or by these columns, from left to right as the table shows them, Name last;
  // best is the way a column's first click sorts, or not.
  const [sorts, setSorts] = useState<{ key: TrackedKey; best: boolean }[]>([]);
  // Selected repos, the last one clicked (where a shift-click range starts), and whether removing them waits for a confirm.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [, setTick] = useState(0);

  // "3h ago" goes stale on its own: draw again every minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const inIssues = new Set(issues.items.map((issue) => issue.id));
  // An issue is new for three days after it was opened, assigned or not, unless Mark all as read saw it. How many of
  // each repo's are, and of all.
  const newSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const newCounts: Record<string, number> = {};
  let newTotal = 0;
  for (const repo of tracked.items) {
    const check = repo.check;
    const read = check !== null ? (check.read ?? []) : [];
    newCounts[repo.full_name] = check !== null ? check.issues.filter((issue) => new Date(issue.created_at).getTime() > newSince && !read.includes(issue.number)).length : 0;
    newTotal += newCounts[repo.full_name];
  }

  async function remove(names: string[]) {
    try {
      await api("/api/tracked/remove", { method: "POST", body: { names } });
      setSelected((current) => current.filter((name) => !names.includes(name)));
    } catch (err) {
      toast.error(`Could not stop tracking: ${err instanceof Error ? err.message : err}`);
    }
  }

  // The value a repo sorts by in a column: a number, or text for the name. null when it hasn't one (it goes last).
  function trackedValue(repo: TrackedRepo, key: TrackedKey): number | string | null {
    const check = repo.check;
    if (key === "name") {
      return repo.full_name.toLowerCase();
    }
    if (key === "stars") {
      return check !== null && check.stars !== null ? check.stars : repo.stars;
    }
    const signals = repo.signals;
    if (key === "ai_policy") {
      return signals !== null ? (POLICY_RANK[signals.ai_policy.tag] ?? null) : null;
    }
    if (key === "newcomers") {
      return signals !== null && signals.newcomers !== undefined ? (NEWCOMER_RANK[signals.newcomers.tag] ?? null) : null;
    }
    if (key === "reply") {
      return signals !== null ? signals.median_days_to_first_reply : null;
    }
    if (key === "reviews") {
      return signals !== null && signals.atmosphere ? (TONE_RANK[signals.atmosphere.tone] ?? null) : null;
    }
    if (key === "activity") {
      return signals !== null && signals.activity !== undefined ? signals.activity.commits_month : null;
    }
    if (key === "contributors") {
      return signals !== null ? (signals.active_contributors ?? null) : null;
    }
    if (key === "maintainers") {
      return signals !== null ? signals.active_mergers_30d : null;
    }
    if (key === "unanswered") {
      return signals !== null ? signals.stale_outside_prs : null;
    }
    if (check === null) {
      return null;
    }
    if (key === "new") {
      return newCounts[repo.full_name];
    }
    if (key === "free") {
      return check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free").length;
    }
    if (key === "easy") {
      return check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free" && issue.tags.level === "easy").length;
    }
    if (key === "open") {
      return check.issues.length;
    }
    return new Date(check.checked_at).getTime();
  }

  const rows = [...tracked.items];
  if (sorts.length > 0) {
    rows.sort((a, b) => {
      // Free first, then each column to its right to the end, then from the left (Name, AI policy, ...) up to Free. The
      // first sorted one that tells them apart decides; when none does, the list's order stays.
      const keys = ["name" as TrackedKey, ...TRACKED_COLUMNS.map((column) => column.key)];
      const freeIndex = keys.indexOf("free");
      for (const key of [...keys.slice(freeIndex), ...keys.slice(0, freeIndex)]) {
        const sort = sorts.find((each) => each.key === key);
        if (sort === undefined) {
          continue;
        }
        const first = trackedValue(a, key);
        const second = trackedValue(b, key);
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
        // The name A to Z; numbers the most first (the least for a lower column). Then turned round for the other way.
        let order = typeof first === "string" && typeof second === "string" ? first.localeCompare(second) : Number(second) - Number(first);
        if (TRACKED_COLUMNS.find((column) => column.key === key)?.better === "lower") {
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
  function clickSort(key: TrackedKey) {
    const sort = sorts.find((each) => each.key === key);
    if (sort === undefined) {
      setSorts([...sorts, { key, best: true }]);
    } else if (sort.best) {
      setSorts(sorts.map((each) => (each.key === key ? { key, best: false } : each)));
    } else {
      setSorts(sorts.filter((each) => each.key !== key));
    }
  }

  // An issue's value in a column: a number, or text. null when it hasn't one (it goes last).
  function issueValue(issue: TrackedIssue, key: IssueKey): number | string | null {
    const tags = issue.tags ?? null;
    if (key === "number") {
      return issue.number;
    }
    if (key === "title") {
      return issue.title.toLowerCase();
    }
    if (key === "free") {
      if (issue.assignees > 0) {
        return FREE_RANK.assigned;
      }
      return tags !== null ? FREE_RANK[tags.status] : null;
    }
    if (key === "level") {
      return tags !== null && tags.level !== null ? LEVEL_RANK[tags.level] : null;
    }
    if (key === "kind") {
      return tags !== null ? tags.kind : null;
    }
    if (key === "opened") {
      return new Date(issue.created_at).getTime();
    }
    if (key === "updated") {
      return issue.updated_at !== undefined ? new Date(issue.updated_at).getTime() : null;
    }
    return issue.comments;
  }

  // Like clickSort: added (the best first), turned round, taken out.
  function clickIssueSort(key: IssueKey) {
    const sort = issueSorts.find((each) => each.key === key);
    if (sort === undefined) {
      setIssueSorts([...issueSorts, { key, best: true }]);
    } else if (sort.best) {
      setIssueSorts(issueSorts.map((each) => (each.key === key ? { key, best: false } : each)));
    } else {
      setIssueSorts(issueSorts.filter((each) => each.key !== key));
    }
  }

  // Only repos still tracked count as selected (an undo, an agent or another tab may have taken some out).
  const names = rows.map((repo) => repo.full_name);
  const chosen = selected.filter((name) => names.includes(name));

  // A ctrl-click picks or unpicks one row; a shift-click does the same to every row from the last one clicked.
  function select(name: string, shift: boolean) {
    const on = !chosen.includes(name);
    let range = [name];
    if (shift && anchor !== null && names.includes(anchor)) {
      const from = names.indexOf(anchor);
      const to = names.indexOf(name);
      range = names.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !range.includes(each)), ...range] : chosen.filter((each) => !range.includes(each)));
    setAnchor(name);
  }

  async function checkNow(full_name: string) {
    setChecking((current) => [...current, full_name]);
    try {
      await api("/api/tracked/check", { method: "POST", body: { name: full_name } });
    } catch (err) {
      toast.error(`Could not check ${full_name}: ${err instanceof Error ? err.message : err}`);
    }
    setChecking((current) => current.filter((n) => n !== full_name));
  }

  // Check now for every tracked repo, all at once; each row's own button spins meanwhile.
  async function checkAll() {
    await Promise.all(names.map((name) => checkNow(name)));
  }

  async function markAllRead() {
    try {
      await api("/api/tracked/mark_read", { method: "POST" });
    } catch (err) {
      toast.error(`Could not mark them as read: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Claude reads the repo's unassigned issues again now (the assigned ones need no reading). A few minutes for many.
  async function tagAgain(repo: TrackedRepo) {
    if (repo.check === null) {
      return;
    }
    const ids = repo.check.issues.filter((issue) => issue.assignees === 0).map((issue) => `${repo.full_name}#${issue.number}`);
    setRetagging((current) => [...current, repo.full_name]);
    try {
      const result = await api<{ tagged: number; failed: string[] }>("/api/tags/refresh", { method: "POST", body: { ids } });
      if (result.failed.length > 0) {
        toast.error(`Could not tag ${result.failed.length} of its issues again; the backend tries again later.`);
      }
    } catch (err) {
      toast.error(`Could not tag ${repo.full_name}'s issues again: ${err instanceof Error ? err.message : err}`);
    }
    setRetagging((current) => current.filter((n) => n !== repo.full_name));
  }

  async function addIssue(repo: string, number: number) {
    try {
      await api("/api/tracked/add_issue", { method: "POST", body: { repo, number } });
    } catch (err) {
      toast.error(`Could not add ${repo}#${number}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function undo() {
    try {
      await api("/api/tracked/undo", { method: "POST" });
    } catch (err) {
      toast.error(`Undo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function redo() {
    try {
      await api("/api/tracked/redo", { method: "POST" });
    } catch (err) {
      toast.error(`Redo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  function toggle(full_name: string) {
    setOpen((current) => (current.includes(full_name) ? current.filter((n) => n !== full_name) : [...current, full_name]));
  }

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z), unless typing in a field. Re-registered every render, so it sees fresh state.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey && tracked.can_undo) {
        event.preventDefault();
        undo();
      } else if ((key === "y" || (key === "z" && event.shiftKey)) && tracked.can_redo) {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="relative flex h-full flex-col">
      {/* The same bar as on the other pages: Expand all / Collapse all, Refresh all and Mark all as read on the left. */}
      <div className="flex h-9 shrink-0 items-center border-b px-3">
        {names.length > 0 && (
          <span className="flex items-center gap-1">
            {names.every((name) => open.includes(name)) ? (
              <Button variant="ghost" size="xs" onClick={() => setOpen([])}>
                <ChevronsDownUp /> Collapse all
              </Button>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => setOpen(names)}>
                <ChevronsUpDown /> Expand all
              </Button>
            )}
            <Button variant="ghost" size="xs" disabled={checking.length > 0} title="Check every tracked repo on GitHub now" onClick={() => checkAll()}>
              <RefreshCw className={cn(checking.length > 0 && "animate-spin")} /> Refresh all
            </Button>
            <Button variant="ghost" size="xs" disabled={newTotal === 0} title="The issues new now aren't new anymore; only ones found later are" onClick={() => markAllRead()}>
              <CheckCheck /> Mark all as read
            </Button>
          </span>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && tracked.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">Nothing tracked yet. Track a repo from the Repos page to keep an eye on its new issues.</div>
        )}

        {/* One grid for the whole table, its columns as wide as their widest cell; the header and each row are subgrids
            of it, so they line up. w-max lets it grow past the page (it scrolls sideways); min-w-full fills the page
            otherwise, the room left over going before the buttons. The description and the open repo span the row without widening it. */}
        {rows.length > 0 && (
          <div
            className="grid w-max min-w-full gap-x-4 border-b"
            style={{ gridTemplateColumns: `minmax(160px,max-content) repeat(${TRACKED_COLUMNS.length}, max-content) minmax(0,1fr) max-content` }}
          >
            <div className="col-span-full grid h-7 grid-cols-subgrid items-center bg-muted/40 px-3 text-xs font-medium">
              {[{ key: "name" as TrackedKey, label: "Name", title: "A to Z" }, ...TRACKED_COLUMNS].map((column) => {
                const sort = sorts.find((each) => each.key === column.key);
                return (
                  <button
                    key={column.key}
                    type="button"
                    className={cn("flex items-center gap-0.5 hover:text-primary", sort !== undefined && "text-primary")}
                    title={column.title}
                    onClick={() => clickSort(column.key)}
                  >
                    {column.label}
                    {sort !== undefined && (sort.best ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                  </button>
                );
              })}
              <span />
              <span />
            </div>
            {rows.map((repo) => {
              const isOpen = open.includes(repo.full_name);
              const check = repo.check;
              const fresh = newCounts[repo.full_name];
              const signals = repo.signals;
              const free = check !== null ? check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free").length : 0;
              const assigned = check !== null ? check.issues.filter((issue) => issue.assignees > 0 || issue.tags?.status === "assigned").length : 0;
              const easy = check !== null ? check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free" && issue.tags.level === "easy").length : 0;
              const tab = tabs[repo.full_name] ?? (free > 0 ? "free" : "all");
              const shown =
                check === null
                  ? []
                  : check.issues.filter((issue) => {
                      if (tab === "free") {
                        return issue.assignees === 0 && issue.tags?.status === "free";
                      }
                      if (tab === "assigned") {
                        return issue.assignees > 0 || issue.tags?.status === "assigned";
                      }
                      return true;
                    });
              if (issueSorts.length > 0) {
                shown.sort((a, b) => {
                  // Free first, then each column to its right to the end, then # and Title. The first sorted one that
                  // tells them apart decides.
                  const keys = ISSUE_HEADERS.map((column) => column.key);
                  const freeIndex = keys.indexOf("free");
                  for (const key of [...keys.slice(freeIndex), ...keys.slice(0, freeIndex)]) {
                    const sort = issueSorts.find((each) => each.key === key);
                    if (sort === undefined) {
                      continue;
                    }
                    const first = issueValue(a, key);
                    const second = issueValue(b, key);
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
                    const order = typeof first === "string" && typeof second === "string" ? first.localeCompare(second) : Number(second) - Number(first);
                    if (order !== 0) {
                      return sort.best ? order : -order;
                    }
                  }
                  return 0;
                });
              }
              return (
                <div key={repo.full_name} className="col-span-full grid grid-cols-subgrid border-t">
                  <div
                    data-select-id={repo.full_name}
                    className={cn(
                      "col-span-full grid cursor-pointer grid-cols-subgrid px-3 hover:bg-accent/50",
                      isOpen && "bg-accent/40",
                      chosen.includes(repo.full_name) && "bg-selected hover:bg-selected",
                    )}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey || event.shiftKey) {
                        select(repo.full_name, event.shiftKey);
                      } else {
                        toggle(repo.full_name);
                      }
                    }}
                  >
                    <span className="flex h-7 min-w-0 items-center">
                      <span className="truncate font-medium">{repo.full_name}</span>
                    </span>
                    {/* The repo's tags, from its signals; – until they are fetched (seconds after it is tracked). */}
                    <span className="flex h-7 items-center">
                      {signals !== null ? <PolicyTag tag={signals.ai_policy.tag} quote={signals.ai_policy.quote} file={signals.ai_policy.file} /> : "–"}
                    </span>
                    <span className="flex h-7 items-center">
                      {signals !== null && signals.newcomers !== undefined ? (
                        <NewcomersTag
                          tag={signals.newcomers.tag}
                          detail={`${signals.newcomers.prs} first PRs: ${signals.newcomers.merged} merged, ${signals.newcomers.closed} closed unmerged`}
                        />
                      ) : (
                        "–"
                      )}
                    </span>
                    <span
                      className={cn(
                        "flex h-7 items-center tabular-nums",
                        signals !== null && signals.median_days_to_first_reply !== null && signals.median_days_to_first_reply <= 2 && "text-ok",
                        signals !== null && signals.median_days_to_first_reply !== null && signals.median_days_to_first_reply > 7 && "text-warn",
                      )}
                    >
                      {signals !== null && signals.median_days_to_first_reply !== null ? `${signals.median_days_to_first_reply}d` : "–"}
                    </span>
                    <span className="flex h-7 items-center">
                      {signals !== null && signals.atmosphere ? <ToneTag tone={signals.atmosphere.tone} summary={signals.atmosphere.summary} /> : "–"}
                    </span>
                    <span className="flex h-7 items-center whitespace-nowrap tabular-nums" title="A month on average over 90 days; the arrow: the last 30 days were busier or quieter">
                      {signals !== null && signals.activity !== undefined
                        ? `${COMPACT.format(signals.activity.prs_opened_month)} PRs · ${COMPACT.format(signals.activity.issues_opened_month)} issues · ${COMPACT.format(signals.activity.commits_month)} commits /mo${signals.activity.trend === "up" ? " ↑" : signals.activity.trend === "down" ? " ↓" : ""}`
                        : "–"}
                    </span>
                    <span className="flex h-7 items-center tabular-nums">{signals !== null ? (signals.active_contributors ?? "–") : "–"}</span>
                    <span className={cn("flex h-7 items-center tabular-nums", signals !== null && signals.active_mergers_30d <= 1 && "text-warn")}>
                      {signals !== null ? signals.active_mergers_30d : "–"}
                    </span>
                    <span className={cn("flex h-7 items-center tabular-nums", signals !== null && signals.stale_outside_prs >= 5 && "text-warn")}>
                      {signals !== null ? signals.stale_outside_prs : "–"}
                    </span>
                    <span className="flex h-7 items-center gap-1 tabular-nums">
                      <Star className="size-3.5" />
                      {COMPACT.format(check !== null && check.stars !== null ? check.stars : repo.stars)}
                    </span>
                    <span className={cn("flex h-7 items-center tabular-nums", fresh > 0 && "font-medium text-primary")}>{check !== null ? fresh : "–"}</span>
                    <span className={cn("flex h-7 items-center tabular-nums", free > 0 && "text-ok")}>{check !== null ? free : "–"}</span>
                    <span className={cn("flex h-7 items-center tabular-nums", easy > 0 && "text-ok")}>{check !== null ? easy : "–"}</span>
                    <span className="flex h-7 items-center tabular-nums">{check !== null ? check.issues.length : "–"}</span>
                    <span className="flex h-7 items-center gap-1 whitespace-nowrap tabular-nums">
                      {check === null && (
                        <>
                          <Loader2 className="size-3.5 animate-spin" /> checking
                        </>
                      )}
                      {check !== null && check.error !== null && (
                        <span className="text-destructive" title={check.error}>
                          failed
                        </span>
                      )}
                      {check !== null && check.error === null && <span title={new Date(check.checked_at).toLocaleString()}>{timeAgo(check.checked_at)}</span>}
                    </span>
                    <span />
                    <span className="flex h-7 items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Check ${repo.full_name} now`}
                        title="Check on GitHub now"
                        disabled={checking.includes(repo.full_name)}
                        onClick={() => checkNow(repo.full_name)}
                      >
                        <RefreshCw className={cn(checking.includes(repo.full_name) && "animate-spin")} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Tag ${repo.full_name}'s issues again`}
                        title="Tag again: Claude reads its unassigned issues and their comments again now"
                        disabled={check === null || retagging.includes(repo.full_name)}
                        onClick={() => tagAgain(repo)}
                      >
                        {retagging.includes(repo.full_name) ? <Loader2 className="animate-spin" /> : <Tags />}
                      </Button>
                      <Button variant="ghost" size="icon-xs" aria-label={`Stop tracking ${repo.full_name}`} title="Stop tracking" onClick={() => remove([repo.full_name])}>
                        <X />
                      </Button>
                    </span>
                    {(repo.note !== "" || repo.description !== "") && (
                      <div className="col-span-full w-0 min-w-full truncate pb-1.5" title={repo.note || repo.description}>
                        {repo.note || repo.description}
                      </div>
                    )}
                  </div>

                  {isOpen && (
                    <div className="col-span-full w-0 min-w-full border-t border-l-4 border-l-primary/50 bg-background px-3 py-1.5">
                      {/* Set apart from its repo's (gray) row: the page's own background with a blue bar on the left. */}
                      {check === null && (
                        <div className="flex items-center gap-2 py-1 text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" /> Getting its issues from GitHub…
                        </div>
                      )}
                      {check !== null && check.error !== null && <div className="py-1 text-destructive">The last check failed: {check.error}</div>}
                      {check !== null && (
                        <>
                          <Tabs value={tab} onValueChange={(value) => setTabs({ ...tabs, [repo.full_name]: value as IssueTab })} className="py-1">
                            <TabsList>
                              <TabsTrigger value="free" className="px-2.5">
                                Free <span className="text-xs text-muted-foreground tabular-nums">{free}</span>
                              </TabsTrigger>
                              <TabsTrigger value="assigned" className="px-2.5">
                                Assigned <span className="text-xs text-muted-foreground tabular-nums">{assigned}</span>
                              </TabsTrigger>
                              <TabsTrigger value="all" className="px-2.5">
                                All <span className="text-xs text-muted-foreground tabular-nums">{check.issues.length}</span>
                              </TabsTrigger>
                            </TabsList>
                          </Tabs>
                          {shown.length === 0 && (
                            <div className="py-1 text-muted-foreground">
                              {tab === "free" && "No issue a newcomer can start on now."}
                              {tab === "assigned" && "Nobody is assigned to any of its open issues."}
                              {tab === "all" && "No open issues."}
                            </div>
                          )}
                          {shown.length > 0 && (
                            <div className={cn(ISSUE_COLUMNS, "h-7 text-xs font-medium text-muted-foreground")}>
                              {ISSUE_HEADERS.map((column) => {
                                const sort = issueSorts.find((each) => each.key === column.key);
                                return (
                                  <button
                                    key={column.key}
                                    type="button"
                                    className={cn("flex items-center gap-0.5 hover:text-primary", sort !== undefined && "text-primary")}
                                    title={column.title}
                                    onClick={() => clickIssueSort(column.key)}
                                  >
                                    {column.key === "comments" ? <MessageSquare className="size-3.5" /> : column.label}
                                    {sort !== undefined && (sort.best ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                                  </button>
                                );
                              })}
                              <span />
                            </div>
                          )}
                          {shown.map((issue) => {
                            const id = `${repo.full_name}#${issue.number}`;
                            const isNew = new Date(issue.created_at).getTime() > newSince && !(check.read ?? []).includes(issue.number);
                            const tags = issue.tags ?? null;
                            const isAssigned = issue.assignees > 0 || tags?.status === "assigned";
                            return (
                              <div
                                key={issue.number}
                                className={cn(ISSUE_COLUMNS, "min-h-7 cursor-pointer border-t border-border/50 py-0.5 hover:bg-accent/50")}
                                onClick={() => setDetails({ repo: repo.full_name, number: issue.number })}
                              >
                                <a
                                  href={issue.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-muted-foreground tabular-nums hover:text-foreground hover:underline"
                                  title="Open on GitHub"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  #{issue.number}
                                </a>
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate" title={issue.title}>
                                    {issue.title}
                                  </span>
                                  {isNew && <Badge>new</Badge>}
                                </span>
                                {/* The app's tags, each in its column, the reason on hover; GitHub's own labels aren't shown.
                                    – is not ready yet (Free) or none (assigned on GitHub isn't read); … is not tagged yet. */}
                                <span
                                  className={cn("truncate", isAssigned && "text-warn", !isAssigned && tags?.status === "free" && "text-ok")}
                                  title={tags?.reason ?? (isAssigned ? "Assigned on GitHub" : "Claude hasn't tagged it yet")}
                                >
                                  {isAssigned ? "Assigned" : tags === null ? "…" : tags.status === "free" ? "Free" : "–"}
                                </span>
                                <span className={cn("truncate capitalize", tags !== null && tags.level !== null && LEVEL_COLOR[tags.level])} title={tags?.reason}>
                                  {tags !== null ? (tags.level ?? "–") : isAssigned ? "–" : "…"}
                                </span>
                                <span className="truncate capitalize" title={tags?.reason}>
                                  {tags !== null ? (tags.kind ?? "–") : isAssigned ? "–" : "…"}
                                </span>
                                <span className="truncate text-muted-foreground" title={new Date(issue.created_at).toLocaleString()}>
                                  {timeAgo(issue.created_at)} by {issue.author}
                                </span>
                                <span className="truncate text-muted-foreground" title={issue.updated_at !== undefined ? new Date(issue.updated_at).toLocaleString() : "Known after the next check"}>
                                  {issue.updated_at !== undefined ? timeAgo(issue.updated_at) : "–"}
                                </span>
                                <span className="flex items-center gap-1 text-muted-foreground tabular-nums" title="Comments">
                                  <MessageSquare className="size-3.5" />
                                  {issue.comments}
                                </span>
                                <span className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
                                  <Button variant="ghost" size="icon-xs" asChild>
                                    <a href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open ${id} on GitHub`} title="Open on GitHub">
                                      <ExternalLink />
                                    </a>
                                  </Button>
                                  {inIssues.has(id) ? (
                                    <a href={`#/issues?open=${encodeURIComponent(id)}`} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                                      In Issues
                                    </a>
                                  ) : (
                                    <Button variant="ghost" size="xs" title="Add to the Issues list" onClick={() => addIssue(repo.full_name, issue.number)}>
                                      <Plus /> Issues
                                    </Button>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <RowSelection listRef={listRef} ids={names} selected={chosen} onSelect={setSelected}>
        <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)}>
          <X /> Stop tracking
        </Button>
      </RowSelection>

      <IssueDetailsDialog
        repo={details !== null ? details.repo : ""}
        issue={details !== null ? (tracked.items.find((each) => each.full_name === details.repo)?.check?.issues.find((each) => each.number === details.number) ?? null) : null}
        onClose={() => setDetails(null)}
      />

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop tracking {chosen.length} {chosen.length === 1 ? "repo" : "repos"}?
            </AlertDialogTitle>
            <AlertDialogDescription>Their new issues aren't checked anymore. Undo brings them back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(chosen)}>
              Stop tracking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
