/*
The Explore page: the user runs a search for repos they don't have yet, watches them arrive, and stops it when they like.

A run (github_searcher/explore.py) ends by itself after finding "Find" repos (up to 3 digits, numbers only; empty for no
limit), or when its searches are used up. Workers is how many candidates it checks at the same time. Filters opens a
pop-up (ExploreFiltersDialog) with every tag a repo can get: a click includes one, the next excludes it, the next
lets it be. In a row with included tags, only repos with one of them are kept; a row with none keeps any, and an
excluded tag always skips a repo. The bar doesn't list the
picked ones, the pop-up is where to check them. They are remembered in this browser; while a run goes the pop-up
shows the run's own and can't change them. It searches for
each of the user's types of repo (ExploreProfileDialog; a "lane" in the code), keeping each near its share of the
finds, and skips what is already in Repos, Tracked or the found list. Nothing is blocked: a repo removed from the
found list or from Repos may be found again by a later run.
It doesn't start from fame: its searches run most recently updated first, not most stars first, and the default star
range is a few hundred to 15k (the user's profile can say otherwise). Before Claude reads anything, it skips a repo
where a PR would likely go nowhere: no outside PR merged in 90 days, most outside PRs closed unmerged, or newcomers
turned away (their first PRs mostly closed unmerged) or left waiting (mostly still open, neither merged nor closed,
after a month). A slow first reply alone (over a week) doesn't skip a repo. The Skipped line says how many went for each.
Claude judges each candidate in two steps. First a quick look at its README: is it a code project, which type, how well
it fits. Only one that isn't a weak fit (and that the Fit filters keep) gets the closer look, so no time goes into a
repo that clearly doesn't match: Claude reads its open issues, the comments on them and its recent outside PRs on
GitHub (it may hand batches of them to reader agents that read in parallel and report back), then settles the fit and
writes the note with what it saw. That takes longer, so a candidate may show as being checked for a minute or two.

Every repo that qualifies joins the found list right away, newest first: a table with a field for each thing known
about it. Each row has two lines of fields, so it isn't too long, and the header two lines of names to match: each
column holds a first-line field over a second-line one. The first line (FIRST_LINE) is how outside contributors fare,
the main ones first: outside PRs merged (of those merged or closed), newcomers' first PRs merged (the same, for people
who never opened a PR there before; hover for how many were merged, closed and still open), how newcomers fare, its AI
policy, and how fast a maintainer first replies to an outside PR (bots, AI reviewers and other outsiders don't count);
then who reviews outside PRs (Reviewed by: Agent only when most get a review or comment only from an AI
reviewer, a bot like CodeRabbit or Copilot; Agent and human; Human only when only maintainers do; Few reviews when
too few to tell; hover for the counts; CI and other bots don't count), how many outside PRs no maintainer answered and
how many maintainers it has. The second line
(SECOND_LINE) is the repo itself and how busy it is: stars, its type (the one Claude classified it under), fit, PRs,
issues and commits a month and the trend, how many new contributors it had lately (people whose first PR there was
recent, shown as "16 in 6 days": the days its 100 newest PRs cover; people who contributed before don't count; it
sorts by new contributors a day), and when it was found. Its note goes under both, from the name on. There is no
overall score: the numbers are shown as they are. Every column is as wide as its widest cell (one CSS grid for the
whole table, each row a subgrid), and the text is in the page's own color, not gray: green, amber or red only where a
value means something (the color rules in index.css). A click on a field's name in the header adds it to the sort,
best first (A to Z for text); again the other way round; again takes it out. Many fields sort at once, in the order
they come: the first line from left to right, then the second (say AI policy, then Fit), and newest first among what
is still the same; Repo (the name) last of all. Each sorted name is blue with an arrow. With none, it is back to newest
first. A click on a row opens that repo in a pop-up: on top its name (the icon next to it goes to GitHub), its note,
Approve and Remove; below, scrolling, its README, then its files folded at the bottom (RepoTree). The X, Esc or a
click outside closes it; so do Approve and Remove there, and the repo leaving the list any other way.
The user decides on each: Approve puts it in Repos, Remove takes it off the found list (the two buttons at the end of
its row, and on top of its pop-up). For many at once, like on the Repos page: hovering a row shows its box on the
left, and ticking it picks that repo and turns on select mode, like Select (top right) does: Select stays lit (a click
on it ends select mode), every row shows its box, and a click picks the row instead of opening its pop-up. The box at
the top left of the table's header
picks every row (checked when all are, a dash when some are); a click when all are picked unpicks them. Rows are also picked like in a mail
app (components/ui/row-selection.tsx): Ctrl-click, Shift-click, dragging a rectangle, Ctrl+A. A bar at the bottom then
approves or removes them at once (removing asks first; Enter confirms). Either takes the rows away at once, before the
backend answers (they come back if it refuses), and ends select mode; so does clearing the selection (Escape, the
bar's x). What isn't decided stays in the list, through later runs and restarts.

One bar on top: the run controls on the left, then GithubLimits (how much of each GitHub rate limit is left, over all
tokens, live), and Profile on the right.
Empty parts of the page show nothing (no "nothing yet" lines), so it stays quiet until there is something to see.

The page also shows what is being checked right now, then a folded section, closed until clicked: Skipped (why the
others were skipped, how many in all on the fold; a repo that failed counts as an error there, the errors themselves
aren't shown). It shows only when it has something. The clock ticks every second while a run goes.
*/

import { ArrowDown, ArrowUp, Check, ExternalLink, ListFilter, Loader2, Play, Settings2, Square, SquareCheck, Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import ExploreFiltersDialog, { FILTERS, type Filters } from "@/ExploreFiltersDialog";
import ExploreProfileDialog from "@/ExploreProfileDialog";
import GithubLimits from "@/GithubLimits";
import RepoTree from "@/RepoTree";
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
import { Input } from "@/components/ui/input";
import { FIT_LEVELS, NEWCOMER_LABEL, POLICY_LABEL, ReviewersTag } from "@/components/ui/repo-tags";
import { RowSelection, SelectBox } from "@/components/ui/row-selection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { api, useLive, useLoaded, type ExploreFound } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const WORKERS = [1, 2, 4, 6, 8, 12, 16];
const STATUS_LABEL: Record<string, string> = { running: "Running", done: "Done", stopped: "Stopped", failed: "Failed" };
const FILTERS_STORAGE = "explore-filters";

// The filters picked last time in this browser, the ones still known (an old list from before include and exclude is
// dropped).
const savedFilters: Filters = {};
try {
  const saved = JSON.parse(localStorage.getItem(FILTERS_STORAGE) ?? "{}");
  if (saved !== null && typeof saved === "object" && !Array.isArray(saved)) {
    for (const each of FILTERS) {
      if (saved[each.key] === "include" || saved[each.key] === "exclude") {
        savedFilters[each.key] = saved[each.key];
      }
    }
  }
} catch {
  // Storage blocked or broken: no filters.
}

// The found list's columns after Repo (the name, which takes the room left over), each sorted by a click on its header.
// better says which way the first click sorts: higher numbers first, lower numbers first, or A to Z.
type FoundKey =
  | "name"
  | "type"
  | "stars"
  | "fit"
  | "merged"
  | "new_merged"
  | "policy"
  | "newcomers"
  | "reply"
  | "reviewers"
  | "prs"
  | "issues"
  | "commits"
  | "trend"
  | "new_contributors"
  | "maintainers"
  | "unanswered"
  | "found";

type FoundColumn = { key: FoundKey; label: string; title: string; better: "higher" | "lower" | "text" };

// Each row has two lines, so it isn't too long. The first: how outside contributors fare, the main ones first
// (outside PRs merged, newcomers' first PRs merged, how newcomers fare, the AI policy and how fast a maintainer
// replies).
const FIRST_LINE: FoundColumn[] = [
  { key: "merged", label: "Merged", title: "Outside contributors' PRs merged, of those merged or closed", better: "higher" },
  { key: "new_merged", label: "New merged", title: "Newcomers' first PRs merged, of those merged or closed (a newcomer: someone who never opened a PR there before)", better: "higher" },
  { key: "newcomers", label: "Newcomers", title: "How newcomers' first PRs fare", better: "higher" },
  { key: "policy", label: "AI policy", title: "What its contribution files say about AI", better: "higher" },
  { key: "reply", label: "Reply", title: "Median days until outside contributors' PRs get a first reply from a maintainer (bots and other outsiders don't count)", better: "lower" },
  { key: "reviewers", label: "Reviewed by", title: "Who reviews outside PRs: only an AI reviewer (a bot like CodeRabbit or Copilot), both, or only maintainers; human only first", better: "higher" },
  { key: "unanswered", label: "Unanswered", title: "Outside contributors' PRs open over 30 days that no maintainer answered", better: "lower" },
  { key: "maintainers", label: "Maintainers", title: "People who merged a PR in the last 30 days (bots not counted)", better: "higher" },
];
// The second, under the first: the repo itself and how busy it is.
const SECOND_LINE: FoundColumn[] = [
  { key: "stars", label: "Stars", title: "Stars on GitHub", better: "higher" },
  { key: "type", label: "Type", title: "The type of repo Claude put it under, from your Explore profile", better: "text" },
  { key: "fit", label: "Fit", title: "How well Claude thinks it fits your Explore profile", better: "higher" },
  { key: "prs", label: "PRs/mo", title: "PRs opened a month, on average over 90 days", better: "higher" },
  { key: "issues", label: "Issues/mo", title: "Issues opened a month, on average over 90 days", better: "higher" },
  { key: "commits", label: "Commits/mo", title: "Commits a month, on average over 90 days", better: "higher" },
  { key: "trend", label: "Trend", title: "The last 30 days against the 90-day average", better: "higher" },
  { key: "new_contributors", label: "New contributors", title: "People whose first PR there came in the time shown: its 100 newest PRs, at most 90 days, among the 30 most recent outside authors. People who contributed before don't count, nor do maintainers or bots", better: "higher" },
  { key: "found", label: "Found", title: "When it was found", better: "higher" },
];
// Every column in sort order (the first line from left to right, then the second), and the table's columns between
// Repo and the buttons: each holds a first-line field over a second-line one.
const FOUND_COLUMNS = [...FIRST_LINE, ...SECOND_LINE];
const SLOTS = Array.from({ length: Math.max(FIRST_LINE.length, SECOND_LINE.length) }, (_, index) => index);

// The order of each judged value, best first being the highest. Values not listed (unknown) go last.
const POLICY_RANK: Record<string, number> = { welcome: 5, none: 4, disclose: 3, unclear: 2, no_ai: 1 };
const NEWCOMER_RANK: Record<string, number> = { welcomes: 5, ok: 4, few: 3, left_waiting: 2, turned_away: 1 };
const TREND_RANK: Record<string, number> = { up: 3, flat: 2, down: 1 };
const REVIEWER_RANK: Record<string, number> = { human: 3, both: 2, agent: 1 };

// The AI policy and newcomers columns are tags: green for good news, amber for "have a look", red for bad, gray
// for the rest.
const POLICY_VARIANT: Record<string, "ok" | "fine" | "warn" | "bad"> = { welcome: "ok", none: "fine", no_ai: "bad" };
const NEWCOMER_VARIANT: Record<string, "ok" | "warn" | "bad"> = { welcomes: "ok", turned_away: "bad", left_waiting: "bad" };

export default function Explore() {
  const explore = useLive("explore");
  const loaded = useLoaded("explore");
  const [count, setCount] = useState("20");
  const [workers, setWorkers] = useState("6");
  const [filters, setFilters] = useState<Filters>(savedFilters);
  const [pickingFilters, setPickingFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // The found list's order: by these fields, in FOUND_COLUMNS' order, the name last (none: newest
  // first); best is the way a column's first click sorts, or not.
  const [sorts, setSorts] = useState<{ key: FoundKey; best: boolean }[]>([]);
  // The repo open in the pop-up (null: none), and the ones approved or removed here that the live feed still lists
  // (hidden meanwhile).
  const [openName, setOpenName] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string[]>([]);
  // Selected found repos, and the last one clicked (where a shift-click range starts).
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  // Select mode: every row shows a box and a click picks it. Picking a row any other way shows the boxes too.
  const [selecting, setSelecting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [, setTick] = useState(0);
  const run = explore.run;
  const running = run !== null && run.status === "running";

  useEffect(() => {
    try {
      localStorage.setItem(FILTERS_STORAGE, JSON.stringify(filters));
    } catch {
      // Storage blocked: the filters just aren't kept.
    }
  }, [filters]);

  // The elapsed time, every second while a run goes.
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // What the live feed no longer lists isn't leaving anymore, and its pop-up closes (so it doesn't open again by itself
  // if a later run finds it again).
  useEffect(() => {
    setLeaving((current) => current.filter((name) => explore.found.some((each) => each.name === name)));
    setOpenName((current) => (explore.found.some((each) => each.name === current) ? current : null));
  }, [explore.found]);

  const laneLabels: Record<string, string> = {};
  for (const lane of explore.profile.lanes) {
    laneLabels[lane.id] = lane.label;
  }

  const countNumber = count.trim() === "" ? null : Number(count);
  // The box takes digits only, at most 3, so only 0 is left to refuse.
  const countValid = countNumber === null || countNumber >= 1;

  let elapsed = "";
  if (run !== null) {
    const end = run.ended_at !== null ? new Date(run.ended_at).getTime() : Date.now();
    const seconds = Math.max(0, Math.floor((end - new Date(run.started_at).getTime()) / 1000));
    elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  async function start() {
    if (!countValid || busy) {
      return;
    }
    setBusy(true);
    try {
      await api("/api/explore/start", { method: "POST", body: { count: countNumber, workers: Number(workers), filters } });
    } catch (err) {
      toast.error(`Could not start: ${err instanceof Error ? err.message : err}`);
    }
    setBusy(false);
  }

  async function stop() {
    try {
      await api("/api/explore/stop", { method: "POST" });
    } catch (err) {
      toast.error(`Could not stop: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function approve(names: string[]) {
    setLeaving((current) => [...current, ...names]);
    setSelected((current) => current.filter((name) => !names.includes(name)));
    setSelecting(false);
    try {
      const result = await api<{ added: string[] }>("/api/explore/approve", { method: "POST", body: { names } });
      if (names.length > 1) {
        toast.success(`${result.added.length} added to Repos`);
      }
    } catch (err) {
      setLeaving((current) => current.filter((name) => !names.includes(name)));
      toast.error(`Could not approve: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(names: string[]) {
    setLeaving((current) => [...current, ...names]);
    setSelected((current) => current.filter((name) => !names.includes(name)));
    setSelecting(false);
    try {
      await api("/api/explore/remove", { method: "POST", body: { names } });
    } catch (err) {
      setLeaving((current) => current.filter((name) => !names.includes(name)));
      toast.error(`Could not remove: ${err instanceof Error ? err.message : err}`);
    }
  }

  // The value a found repo sorts by in a column: a number, or text. null when it hasn't one (it goes last).
  function foundValue(each: ExploreFound, key: FoundKey): number | string | null {
    if (key === "name") {
      return each.name.toLowerCase();
    }
    if (key === "type") {
      return (laneLabels[each.lane] ?? each.lane).toLowerCase();
    }
    if (key === "stars") {
      return each.stars;
    }
    if (key === "fit") {
      return each.fit;
    }
    if (key === "merged") {
      return each.merged ?? null;
    }
    if (key === "new_merged") {
      return each.newcomer_stats?.merge_rate ?? null;
    }
    if (key === "reply") {
      return each.reply ?? null;
    }
    if (key === "policy") {
      return POLICY_RANK[each.ai_policy] ?? null;
    }
    if (key === "newcomers") {
      return each.newcomers !== undefined ? (NEWCOMER_RANK[each.newcomers] ?? null) : null;
    }
    if (key === "reviewers") {
      return each.reviewers ? (REVIEWER_RANK[each.reviewers.tag] ?? null) : null;
    }
    if (key === "prs") {
      return each.prs_month ?? null;
    }
    if (key === "issues") {
      return each.issues_month ?? null;
    }
    if (key === "commits") {
      return each.commits_month ?? null;
    }
    if (key === "trend") {
      return each.trend !== undefined ? (TREND_RANK[each.trend] ?? null) : null;
    }
    if (key === "new_contributors") {
      // Per day, so a repo whose newest PRs cover a week compares fairly with one whose cover three months.
      if (typeof each.window_days !== "number" || each.newcomer_stats === undefined || each.newcomer_stats === null) {
        return null;
      }
      return each.newcomer_stats.prs / each.window_days;
    }
    if (key === "maintainers") {
      return each.maintainers ?? null;
    }
    if (key === "unanswered") {
      return each.unanswered ?? null;
    }
    return new Date(each.found_at).getTime();
  }

  // What a column shows for a found repo: plain text, green / amber / red only when it means something.
  function foundCell(each: ExploreFound, key: FoundKey) {
    if (key === "type") {
      return laneLabels[each.lane] ?? each.lane;
    }
    if (key === "stars") {
      return (
        <span className="inline-flex items-center gap-1">
          <Star className="size-3.5" />
          {STARS.format(each.stars)}
        </span>
      );
    }
    if (key === "fit") {
      const level = FIT_LEVELS.find((one) => each.fit >= one.from) ?? FIT_LEVELS[FIT_LEVELS.length - 1];
      return <Badge variant={level.variant}>{level.label}</Badge>;
    }
    if (key === "merged") {
      return typeof each.merged === "number" ? `${Math.round(each.merged * 100)}%` : "–";
    }
    if (key === "new_merged") {
      const stats = each.newcomer_stats;
      if (stats === undefined || stats === null || stats.merge_rate === null) {
        return "–";
      }
      const open = stats.prs - stats.merged - stats.closed;
      return (
        <span
          className={cn(stats.tag === "welcomes" && "text-ok", (stats.tag === "turned_away" || stats.tag === "left_waiting") && "text-destructive")}
          title={`${stats.prs} newcomers' first PRs: ${stats.merged} merged, ${stats.closed} closed unmerged, ${open} still open`}
        >
          {Math.round(stats.merge_rate * 100)}%
        </span>
      );
    }
    if (key === "reply") {
      if (typeof each.reply !== "number") {
        return "–";
      }
      return <span className={cn(each.reply <= 2 && "text-ok", each.reply > 7 && "text-warn")}>{each.reply}d</span>;
    }
    if (key === "policy") {
      return <Badge variant={POLICY_VARIANT[each.ai_policy] ?? "secondary"}>{POLICY_LABEL[each.ai_policy] ?? each.ai_policy}</Badge>;
    }
    if (key === "newcomers") {
      if (each.newcomers === undefined) {
        return "–";
      }
      return <Badge variant={NEWCOMER_VARIANT[each.newcomers] ?? "secondary"}>{NEWCOMER_LABEL[each.newcomers] ?? each.newcomers}</Badge>;
    }
    if (key === "reviewers") {
      return each.reviewers ? <ReviewersTag reviewers={each.reviewers} /> : "–";
    }
    if (key === "prs") {
      return each.prs_month !== undefined ? STARS.format(each.prs_month) : "–";
    }
    if (key === "issues") {
      return each.issues_month !== undefined ? STARS.format(each.issues_month) : "–";
    }
    if (key === "commits") {
      return each.commits_month !== undefined ? STARS.format(each.commits_month) : "–";
    }
    if (key === "trend") {
      if (each.trend === "up") {
        return <span className="text-ok">↑ busier</span>;
      }
      return each.trend === "down" ? "↓ quieter" : "steady";
    }
    if (key === "new_contributors") {
      if (typeof each.window_days !== "number" || each.newcomer_stats === undefined || each.newcomer_stats === null) {
        return "–";
      }
      return `${each.newcomer_stats.prs} in ${each.window_days} day${each.window_days === 1 ? "" : "s"}`;
    }
    if (key === "maintainers") {
      if (typeof each.maintainers !== "number") {
        return "–";
      }
      return <span className={cn(each.maintainers <= 1 && "text-warn")}>{each.maintainers}</span>;
    }
    if (key === "unanswered") {
      if (typeof each.unanswered !== "number") {
        return "–";
      }
      return <span className={cn(each.unanswered >= 5 && "text-warn")}>{each.unanswered}</span>;
    }
    return timeAgo(each.found_at);
  }

  const found = explore.found.filter((each) => !leaving.includes(each.name)).reverse();
  if (sorts.length > 0) {
    found.sort((a, b) => {
      // The first sorted field (in FOUND_COLUMNS' order) that tells them apart decides; when none does, they stay newest first (a stable sort).
      for (const key of [...FOUND_COLUMNS.map((column) => column.key), "name"]) {
        const sort = sorts.find((each) => each.key === key);
        if (sort === undefined) {
          continue;
        }
        const better = sort.key === "name" ? "text" : FOUND_COLUMNS.find((column) => column.key === sort.key)!.better;
        const first = foundValue(a, sort.key);
        const second = foundValue(b, sort.key);
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
        if (better === "higher") {
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
  function clickSort(key: FoundKey) {
    const sort = sorts.find((each) => each.key === key);
    if (sort === undefined) {
      setSorts([...sorts, { key, best: true }]);
    } else if (sort.best) {
      setSorts(sorts.map((each) => (each.key === key ? { key, best: false } : each)));
    } else {
      setSorts(sorts.filter((each) => each.key !== key));
    }
  }

  // A sorted header's arrow.
  function sortMark(key: FoundKey) {
    const sort = sorts.find((each) => each.key === key);
    if (sort === undefined) {
      return null;
    }
    return sort.best ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />;
  }

  // Only what is still in the list counts as selected (a decision elsewhere, or another tab, may have taken some out).
  const foundNames = found.map((each) => each.name);
  const chosen = selected.filter((name) => foundNames.includes(name));
  // The repo in the pop-up, while it is still in the list: approved or removed here, or gone elsewhere, it closes.
  const openRepo = found.find((each) => each.name === openName) ?? null;

  // Clearing the selection (Escape, the bar's x, a click on the list's empty space) also ends select mode.
  function onSelect(names: string[]) {
    setSelected(names);
    if (names.length === 0) {
      setSelecting(false);
    }
  }
  const selectMode = selecting || chosen.length > 0;
  const allPicked = foundNames.length > 0 && foundNames.every((name) => chosen.includes(name));

  // A click in select mode, or a ctrl-click, picks or unpicks one row; a shift-click does the same to every row from
  // the last one clicked.
  function select(name: string, shift: boolean) {
    const on = !chosen.includes(name);
    let names = [name];
    if (shift && anchor !== null && foundNames.includes(anchor)) {
      const from = foundNames.indexOf(anchor);
      const to = foundNames.indexOf(name);
      names = foundNames.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !names.includes(each)), ...names] : chosen.filter((each) => !names.includes(each)));
    setAnchor(name);
  }

  const skipped = run !== null ? Object.entries(run.skipped).sort((a, b) => b[1] - a[1]) : [];
  let skippedTotal = 0;
  for (const [, number] of skipped) {
    skippedTotal += number;
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-6 gap-y-1.5 border-b px-3 py-1">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <span className="text-muted-foreground">Find</span>
          <Input
            className="w-16"
            inputMode="numeric"
            placeholder="any"
            maxLength={3}
            value={count}
            aria-invalid={!countValid}
            disabled={running}
            onChange={(event) => setCount(event.target.value.replace(/\D/g, "").slice(0, 3))}
          />
          <span className="text-muted-foreground">repos</span>
          <span className="ml-2 text-muted-foreground">Workers</span>
          <Select value={workers} onValueChange={setWorkers} disabled={running}>
            <SelectTrigger className="w-16">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {WORKERS.map((each) => (
                <SelectItem key={each} value={String(each)}>
                  {each}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="ghost" onClick={() => setPickingFilters(true)}>
            <ListFilter /> Filters
          </Button>
          {running ? (
            <Button type="button" variant="outline" onClick={stop}>
              <Square /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!countValid || busy || !loaded}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />} Start
            </Button>
          )}
        </form>
        <GithubLimits />
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant={selectMode ? "secondary" : "ghost"}
            disabled={!selectMode && foundNames.length === 0}
            title={selectMode ? "Stop selecting (Esc)" : "Pick rows: every row shows its box, and a click picks it"}
            onClick={() => (selectMode ? onSelect([]) : setSelecting(true))}
          >
            <SquareCheck /> Select
          </Button>
          <Button variant="ghost" onClick={() => setEditing(true)} disabled={!loaded}>
            <Settings2 /> Profile
          </Button>
        </span>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {/* One grid for the whole table, its columns as wide as their widest cell; the header and each row are subgrids
            of it, so they line up. w-max lets it grow past the page (it scrolls sideways); min-w-full fills the page
            otherwise, Repo taking the room left over. The note spans the row without widening it. */}
        {found.length > 0 && (
          <div
            className="grid w-max min-w-full gap-x-4 border-b"
            style={{ gridTemplateColumns: `16px minmax(160px,1fr) repeat(${SLOTS.length}, max-content) max-content` }}
          >
            <div className="col-span-full grid grid-cols-subgrid items-center bg-muted/40 px-3 py-0.5 text-xs font-medium">
              {/* Top left: picks every repo shown, or none when all are; a dash when only some are. */}
              <button
                type="button"
                className="flex h-5 items-center self-start"
                aria-label={allPicked ? "Unselect all" : "Select all"}
                title={allPicked ? "Unselect all" : "Select all (Ctrl+A)"}
                disabled={foundNames.length === 0}
                onClick={() => (allPicked ? onSelect([]) : setSelected(foundNames))}
              >
                <SelectBox checked={allPicked} partial={chosen.length > 0} />
              </button>
              <button
                type="button"
                className={cn("flex h-5 items-center gap-0.5 self-start hover:text-primary", sorts.some((each) => each.key === "name") && "text-primary")}
                title="A to Z"
                onClick={() => clickSort("name")}
              >
                Repo
                {sortMark("name")}
              </button>
              {/* Two lines, like the rows: each column's first-line field over its second-line one. */}
              {SLOTS.map((index) => (
                <span key={index} className="flex flex-col">
                  {[FIRST_LINE[index], SECOND_LINE[index]].map((column, line) =>
                    column === undefined ? (
                      <span key={line} className="h-5" />
                    ) : (
                      <button
                        key={column.key}
                        type="button"
                        className={cn("flex h-5 items-center gap-0.5 hover:text-primary", sorts.some((each) => each.key === column.key) && "text-primary")}
                        title={column.title}
                        onClick={() => clickSort(column.key)}
                      >
                        {column.label}
                        {sortMark(column.key)}
                      </button>
                    ),
                  )}
                </span>
              ))}
              <span />
            </div>
            {found.map((each) => (
              <div
                key={each.name}
                data-select-id={each.name}
                className={cn(
                  "group col-span-full grid cursor-pointer grid-cols-subgrid border-t px-3 py-2 hover:bg-accent/50",
                  chosen.includes(each.name) && "bg-selected hover:bg-selected",
                )}
                onClick={(event) => {
                  // Its links and buttons do their own thing.
                  if ((event.target as HTMLElement).closest("a, button") !== null) {
                    return;
                  }
                  // In select mode a click picks the row; otherwise Ctrl / Shift-click picks it and a plain click opens
                  // its pop-up.
                  if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) {
                    select(each.name, event.shiftKey);
                  } else {
                    setOpenName(each.name);
                  }
                }}
              >
                {/* Always there, so it can show on hover without the row moving. Ticking it picks the repo, which
                    turns select mode on. */}
                <button
                  type="button"
                  className={cn("flex h-7 items-center", !selectMode && "invisible group-hover:visible")}
                  aria-label={`Select ${each.name}`}
                  onClick={(event) => select(each.name, event.shiftKey)}
                >
                  <SelectBox checked={chosen.includes(each.name)} />
                </button>
                {/* The name opens the pop-up like the rest of the row; only the icon goes to GitHub, in a new tab. */}
                <span className="flex h-7 min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium" title={each.description}>
                    {each.name}
                  </span>
                  <a
                    href={each.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-primary hover:text-foreground"
                    aria-label={`Open ${each.name} on GitHub`}
                    title="Open on GitHub in a new tab"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                </span>
                {SLOTS.map((index) => (
                  <span key={index} className="flex h-7 items-center whitespace-nowrap tabular-nums">
                    {FIRST_LINE[index] !== undefined && foundCell(each, FIRST_LINE[index].key)}
                  </span>
                ))}
                <span className="flex h-7 items-center gap-1">
                  <Button variant="outline" size="xs" title="Add it to Repos" onClick={() => approve([each.name])}>
                    <Check /> Approve
                  </Button>
                  <Button variant="ghost" size="xs" title="Take it off the found list" onClick={() => remove([each.name])}>
                    <X /> Remove
                  </Button>
                </span>
                {/* The second line, under the first one's columns: nothing under the box and the name. */}
                <span />
                <span />
                {SLOTS.map((index) => (
                  <span key={index} className="flex h-6 items-center whitespace-nowrap tabular-nums">
                    {SECOND_LINE[index] !== undefined && foundCell(each, SECOND_LINE[index].key)}
                  </span>
                ))}
                <span />
                {/* Under the name, to the end of the row. */}
                <div className="w-0 min-w-full truncate pt-0.5" style={{ gridColumn: "2 / -1" }} title={each.note}>
                  {each.note}
                </div>
              </div>
            ))}
          </div>
        )}

        {run !== null && (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b px-3 py-2">
              <span className="flex items-center gap-1.5 font-medium">
                <StatusDot tone={running ? "green" : run.status === "failed" ? "red" : "gray"} />
                {STATUS_LABEL[run.status]}
              </span>
              <span className="tabular-nums">
                {run.found}
                {run.count !== null && ` of ${run.count}`} found
              </span>
              <span className="text-muted-foreground tabular-nums">
                {elapsed}
                {run.minutes !== null && ` of ${run.minutes}:00`}
              </span>
              {Object.entries(run.lanes).map(([id, lane]) => (
                <span key={id} className="text-muted-foreground">
                  {lane.label} <span className="text-foreground tabular-nums">{lane.found}</span>
                  {lane.exhausted && lane.share > 0 && " (searches used up)"}
                </span>
              ))}
              <span className="text-muted-foreground tabular-nums">{run.looked_at} looked at</span>
              {!running && run.end_reason !== "" && <span className="text-muted-foreground">{run.end_reason}</span>}
            </div>

            {run.checking.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
                <span className="mr-1 text-muted-foreground">Checking</span>
                {run.checking.map((each) => (
                  <Badge key={each.name} variant="secondary" title={`For ${laneLabels[each.lane] ?? each.lane}, since ${timeAgo(each.since)}`}>
                    <Loader2 className="animate-spin" />
                    {each.name}
                  </Badge>
                ))}
              </div>
            )}

            {skipped.length > 0 && (
              <details className="border-b px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Skipped ({skippedTotal})</summary>
                <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                  {skipped.map(([reason, number]) => (
                    <span key={reason}>
                      <span className="tabular-nums">{number}</span> <span className="text-muted-foreground">{reason.charAt(0).toLowerCase() + reason.slice(1)}</span>
                    </span>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

      </div>

      <RowSelection listRef={listRef} ids={foundNames} selected={chosen} onSelect={onSelect}>
        <Button size="xs" variant="ghost" onClick={() => approve(chosen)}>
          <Check /> Approve
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)}>
          <X /> Remove
        </Button>
      </RowSelection>

      {editing && <ExploreProfileDialog profile={explore.profile} onClose={() => setEditing(false)} />}
      {/* While a run goes the pop-up shows the run's own filters, and they can't be changed. */}
      {pickingFilters && (
        <ExploreFiltersDialog
          filters={running ? run.filters : filters}
          locked={running}
          onChange={setFilters}
          onClose={() => setPickingFilters(false)}
        />
      )}

      {/* The open repo: its name, note and the row's buttons on top, then RepoTree (its README, then its files), which
          scrolls. Out here, not in its row, so a click in the pop-up doesn't reach the row's own click. Approve and
          Remove close it first, so it doesn't open again if the backend refuses and the row comes back. */}
      <Dialog
        open={openRepo !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenName(null);
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          {openRepo !== null && (
            <>
              <div className="shrink-0 space-y-1 border-b pt-3 pr-10 pb-2 pl-4">
                <div className="flex items-center gap-1.5">
                  <DialogTitle className="min-w-0 truncate leading-normal">{openRepo.name}</DialogTitle>
                  <a
                    href={openRepo.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-primary hover:text-foreground"
                    aria-label={`Open ${openRepo.name} on GitHub`}
                    title="Open on GitHub in a new tab"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      title="Add it to Repos"
                      onClick={() => {
                        setOpenName(null);
                        approve([openRepo.name]);
                      }}
                    >
                      <Check /> Approve
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Take it off the found list"
                      onClick={() => {
                        setOpenName(null);
                        remove([openRepo.name]);
                      }}
                    >
                      <X /> Remove
                    </Button>
                  </span>
                </div>
                {openRepo.note !== "" && <div>{openRepo.note}</div>}
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <RepoTree key={openRepo.name} repo={{ full_name: openRepo.name, description: openRepo.description, html_url: openRepo.html_url }} />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {chosen.length} {chosen.length === 1 ? "repo" : "repos"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They leave the found list. Nothing is blocked: a later run may find them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(chosen)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
