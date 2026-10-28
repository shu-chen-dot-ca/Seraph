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

Every repo that qualifies joins the found list right away, newest first: a table with a column for each thing known
about it (FOUND_COLUMNS): its AI policy, fit, how newcomers fare, its review tone, stars, its type (the one Claude
classified it under), PRs, issues and commits a month and the trend, how many contributors and maintainers it has, how many
outside PRs no maintainer answered, and when it was found; its note under the name. Every column is as wide as its widest
cell (one CSS grid for the whole table, each row a subgrid), and the text is in the page's own color, not gray: green,
amber or red only where a value means something (the color rules in index.css). A click on a header adds that column
to the sort, best first (A to Z for text); again the other way round; again takes it out. Many columns sort at once,
from left to right: the leftmost sorted column first, then the next among the same (say AI policy, then Fit), and
newest first among what is still the same; Repo (the name) last of all. Each sorted header is blue with an arrow. With none, it is back to newest
first. A click on a row opens it in place: its README, then its files folded at the
bottom (RepoTree), like on the Repos page.
The user decides on each: Approve puts it in Repos, Remove takes it off the found list (the two buttons at the end of
its row). For many at once, Select (top right) turns on select mode, like on the Repos page: it becomes Select all and
Cancel, every row shows a box, and a click picks the row instead of opening it. Rows are also picked like in a mail
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
import { Input } from "@/components/ui/input";
import { FIT_LEVELS, NEWCOMER_LABEL, POLICY_LABEL, TONE_LABEL } from "@/components/ui/repo-tags";
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
  | "policy"
  | "newcomers"
  | "tone"
  | "prs"
  | "issues"
  | "commits"
  | "trend"
  | "contributors"
  | "maintainers"
  | "unanswered"
  | "found";

const FOUND_COLUMNS: { key: FoundKey; label: string; title: string; better: "higher" | "lower" | "text" }[] = [
  { key: "policy", label: "AI policy", title: "What its contribution files say about AI", better: "higher" },
  { key: "fit", label: "Fit", title: "How well Claude thinks it fits your Explore profile", better: "higher" },
  { key: "newcomers", label: "Newcomers", title: "How newcomers' first PRs fare", better: "higher" },
  { key: "tone", label: "Reviews", title: "How maintainers' feedback on outside PRs feels", better: "higher" },
  { key: "stars", label: "Stars", title: "Stars on GitHub", better: "higher" },
  { key: "type", label: "Type", title: "The type of repo Claude put it under, from your Explore profile", better: "text" },
  { key: "prs", label: "PRs/mo", title: "PRs opened a month, on average over 90 days", better: "higher" },
  { key: "issues", label: "Issues/mo", title: "Issues opened a month, on average over 90 days", better: "higher" },
  { key: "commits", label: "Commits/mo", title: "Commits a month, on average over 90 days", better: "higher" },
  { key: "trend", label: "Trend", title: "The last 30 days against the 90-day average", better: "higher" },
  { key: "contributors", label: "Contributors", title: "People who opened a PR lately (the newest 100 PRs, at most 90 days; bots not counted)", better: "higher" },
  { key: "maintainers", label: "Maintainers", title: "People who merged a PR in the last 30 days (bots not counted)", better: "higher" },
  { key: "unanswered", label: "Unanswered", title: "Outside contributors' PRs open over 30 days that no maintainer answered", better: "lower" },
  { key: "found", label: "Found", title: "When it was found", better: "higher" },
];

// The order of each judged value, best first being the highest. Values not listed (unknown) go last.
const POLICY_RANK: Record<string, number> = { welcome: 5, none: 4, disclose: 3, unclear: 2, no_ai: 1 };
const NEWCOMER_RANK: Record<string, number> = { welcomes: 5, ok: 4, few: 3, left_waiting: 2, turned_away: 1 };
const TONE_RANK: Record<string, number> = { warm: 4, neutral: 3, strict: 2, curt: 1 };
const TREND_RANK: Record<string, number> = { up: 3, flat: 2, down: 1 };

// The AI policy, newcomers and tone columns are tags: green for good news, amber for "have a look", red for bad, gray
// for the rest.
const POLICY_VARIANT: Record<string, "ok" | "fine" | "warn" | "bad"> = { welcome: "ok", none: "fine", no_ai: "bad" };
const NEWCOMER_VARIANT: Record<string, "ok" | "warn" | "bad"> = { welcomes: "ok", turned_away: "bad", left_waiting: "bad" };
const TONE_VARIANT: Record<string, "ok" | "warn" | "bad"> = { warm: "ok", strict: "warn", curt: "bad" };

export default function Explore() {
  const explore = useLive("explore");
  const loaded = useLoaded("explore");
  const [count, setCount] = useState("20");
  const [workers, setWorkers] = useState("6");
  const [filters, setFilters] = useState<Filters>(savedFilters);
  const [pickingFilters, setPickingFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  // The found list's order: by these columns, from left to right as the table shows them, the name last (none: newest
  // first); best is the way a column's first click sorts, or not.
  const [sorts, setSorts] = useState<{ key: FoundKey; best: boolean }[]>([]);
  // Rows open in place, and the ones approved or removed here that the live feed still lists (hidden meanwhile).
  const [open, setOpen] = useState<string[]>([]);
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

  useEffect(() => {
    setLeaving((current) => current.filter((name) => explore.found.some((each) => each.name === name)));
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
    if (key === "policy") {
      return POLICY_RANK[each.ai_policy] ?? null;
    }
    if (key === "newcomers") {
      return each.newcomers !== undefined ? (NEWCOMER_RANK[each.newcomers] ?? null) : null;
    }
    if (key === "tone") {
      return each.tone !== undefined && each.tone !== null ? (TONE_RANK[each.tone] ?? null) : null;
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
    if (key === "contributors") {
      return each.contributors ?? null;
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
    if (key === "policy") {
      return <Badge variant={POLICY_VARIANT[each.ai_policy] ?? "secondary"}>{POLICY_LABEL[each.ai_policy] ?? each.ai_policy}</Badge>;
    }
    if (key === "newcomers") {
      if (each.newcomers === undefined) {
        return "–";
      }
      return <Badge variant={NEWCOMER_VARIANT[each.newcomers] ?? "secondary"}>{NEWCOMER_LABEL[each.newcomers] ?? each.newcomers}</Badge>;
    }
    if (key === "tone") {
      if (each.tone === undefined || each.tone === null) {
        return "–";
      }
      return (
        <Badge variant={TONE_VARIANT[each.tone] ?? "secondary"} title={each.atmosphere}>
          {TONE_LABEL[each.tone] ?? each.tone}
        </Badge>
      );
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
    if (key === "contributors") {
      return each.contributors ?? "–";
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
      // The leftmost sorted column that tells them apart decides; when none does, they stay newest first (a stable sort).
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

  function toggle(name: string) {
    setOpen((current) => (current.includes(name) ? current.filter((each) => each !== name) : [...current, name]));
  }

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
          {!selectMode && (
            <Button variant="ghost" onClick={() => setSelecting(true)} disabled={found.length === 0}>
              <SquareCheck /> Select
            </Button>
          )}
          {selectMode && (
            <>
              <Button variant="ghost" onClick={() => setSelected(allPicked ? [] : foundNames)}>
                {allPicked ? "Unselect all" : "Select all"}
              </Button>
              <Button variant="ghost" onClick={() => onSelect([])}>
                Cancel
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={() => setEditing(true)} disabled={!loaded}>
            <Settings2 /> Profile
          </Button>
        </span>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {/* One grid for the whole table, its columns as wide as their widest cell; the header and each row are subgrids
            of it, so they line up. w-max lets it grow past the page (it scrolls sideways); min-w-full fills the page
            otherwise, Repo taking the room left over. The note and the open repo span the row without widening it. */}
        {found.length > 0 && (
          <div
            className="grid w-max min-w-full gap-x-4 border-b"
            style={{ gridTemplateColumns: `${selectMode ? "16px " : ""}minmax(160px,1fr) repeat(${FOUND_COLUMNS.length}, max-content) max-content` }}
          >
            <div className="col-span-full grid h-7 grid-cols-subgrid items-center bg-muted/40 px-3 text-xs font-medium">
              {selectMode && <span />}
              <button
                type="button"
                className={cn("flex items-center gap-0.5 hover:text-primary", sorts.some((each) => each.key === "name") && "text-primary")}
                title="A to Z"
                onClick={() => clickSort("name")}
              >
                Repo
                {sortMark("name")}
              </button>
              {FOUND_COLUMNS.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className={cn("flex items-center gap-0.5 hover:text-primary", sorts.some((each) => each.key === column.key) && "text-primary")}
                  title={column.title}
                  onClick={() => clickSort(column.key)}
                >
                  {column.label}
                  {sortMark(column.key)}
                </button>
              ))}
              <span />
            </div>
            {found.map((each) => (
              <div key={each.name} className="col-span-full grid grid-cols-subgrid border-t">
                <div
                  data-select-id={each.name}
                  className={cn(
                    "col-span-full grid cursor-pointer grid-cols-subgrid px-3 hover:bg-accent/50",
                    open.includes(each.name) && "bg-accent/40",
                    chosen.includes(each.name) && "bg-selected hover:bg-selected",
                  )}
                  onClick={(event) => {
                    // Its links and buttons do their own thing.
                    if ((event.target as HTMLElement).closest("a, button") !== null) {
                      return;
                    }
                    // In select mode a click picks the row; otherwise Ctrl / Shift-click picks it and a plain click opens it.
                    if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) {
                      select(each.name, event.shiftKey);
                    } else {
                      toggle(each.name);
                    }
                  }}
                >
                  {selectMode && (
                    <span className="flex h-7 items-center">
                      <SelectBox checked={chosen.includes(each.name)} />
                    </span>
                  )}
                  {/* The name opens the row like the rest of it; only the icon goes to GitHub, in a new tab. */}
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
                  {FOUND_COLUMNS.map((column) => (
                    <span key={column.key} className="flex h-7 items-center whitespace-nowrap tabular-nums">
                      {foundCell(each, column.key)}
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
                  {/* Under the name, to the end of the row (always there, for the room under the row). */}
                  <div className="w-0 min-w-full truncate pb-1.5" style={{ gridColumn: `${selectMode ? 2 : 1} / -1` }} title={each.note}>
                    {each.note}
                  </div>
                </div>
                {open.includes(each.name) && (
                  <div className="col-span-full w-0 min-w-full border-t bg-muted/30">
                    <RepoTree repo={{ full_name: each.name, description: each.description, html_url: each.html_url }} />
                  </div>
                )}
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
