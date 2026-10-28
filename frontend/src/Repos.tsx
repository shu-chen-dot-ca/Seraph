/*
The Repos list: repos the agents and Explore picked, and ones the user added by hand with the box on the left of the
bar on top (out of select mode): paste a repo's GitHub link (or a link to any page in it) or type owner/name, then
Enter or Add. It is looked up on GitHub, added at once as one undo step, and a toast says so; one already in Repos,
or a link GitHub doesn't know, says why instead.

The table reads like the Explore page's: a column for each thing known about a repo, picked in the Columns dialog
(components/ui/columns-dialog.tsx), in the order picked. The main ones come first by default: outside PRs merged (of
those merged or closed), newcomers' first PRs merged (New merged; hover for merged, closed and still open), how
newcomers fare (welcomed, OK, turned away: their first PRs mostly closed, or left waiting: mostly still open after a
month), the AI policy, and reply speed (how fast a maintainer first answers an outside PR;
bots, AI reviewers and other outsiders don't count). Then its type and fit, stars, review tone, PRs, issues and commits
a month and the trend, new contributors (people whose first PR there was recent, as "16 in 6 days": the days its 100
newest PRs cover; people who contributed before don't count; it sorts by new contributors a day), maintainers, PRs no maintainer answered, its issues in the Issues list, and more
(TABLE_COLUMNS; github_searcher/repo_signals.py, kept fresh by the backend). There is no overall score: the numbers
are shown as they are. What used to be tags under a row are columns too. Values are plain text in the page's own color: green,
amber or red only where a value means something (the same rules as the Explore page). No lines between columns. Name
comes first and takes the room left over, the note under it, so the other columns sit on the right. Every column is as
wide as its widest cell (header included) over the whole list, not only the rows on screen: a hidden copy of every
row's cells (the sizer at the bottom) measures them (lib/column-widths.ts). A table wider than the page scrolls
sideways, the header with it, and the header stays on top while the rows scroll. The columns are remembered in this
browser. Rows have no arrow: the first column is for the boxes (see below).

Sorting is by any number of fields at once (SORT_FIELDS): a click on a column header (the Activity column sorts by
commits a month), or on a field's arrow in the All fields panel (every field, shown as a column or not). Each click on
a field goes one step:
- down: adds it to the sort, the best or the most first (fastest replies, most merged, warmest reviews, most open to
  AI, A to Z for text),
- up: turned round,
- off: takes it out of the sort (with none left, back to the list's own order).
Which field counts first goes from left to right: the shown columns in their order, then Track, then the fields not
shown as columns (in the All fields panel's order), Name last of all. A field only orders the repos the ones before it
leave the same. Every header the list sorts by turns blue with its arrow. Repos without a value for a field go last either way. What Claude judges (AI policy, review tone, what reviewers ask for,
fit) is always one of a fixed set, so it ranks in a fixed order (*_RANK below). For the AI policy: AI welcome best
(green), then No AI policy (a lighter green), AI: disclose, AI: unclear, and No AI last (red); the Explore and Tracked
pages rank it the same. The sort is remembered in this browser.

Rows have no buttons of their own. Hovering a row shows its box on the left; ticking it picks that repo and turns on
select mode, like Select (top right) does: Delete, Track and Untrack show on the left of the bar, Select stays lit (a
click on it ends select mode), every row shows its box, and a click picks the row instead of opening it. The box at
the top left of the table's header picks every row (checked when all are, a dash when some are); a click when all are
picked unpicks them. Rows are also picked like in a mail app (components/ui/row-selection.tsx): Ctrl-click, Shift-click,
dragging a rectangle, Ctrl+A, which turns on select mode too; a bar at the bottom says how many. Track tracks the
picked repos not tracked yet, Untrack stops tracking the tracked ones (each one undo step on the Tracked page); Delete
deletes them at once, as one undo step (it asks first; Enter confirms). Delete only takes a repo off the list; Explore
may find it again. Clearing the selection (Escape, the bar's x) ends select mode too.

The last column, always there, tracks the repo (the Tracked page then keeps an eye on its new issues) or stops tracking
it: Track or Untrack, with a spinner while the backend looks the repo up on GitHub.

Each row opens in place: the signals in full, then RepoTree (the README, with its files folded at the bottom). Only
the rows on screen are drawn (react-virtual measures each row, so open rows of any height work), plus every open row
wherever it is: its RepoTree keeps what it loaded and what is unfolded while you scroll away and back. Undo / redo are Ctrl+Z / Ctrl+Y
(when the cursor is not in a text field) and go through the backend, so they also undo what an agent or Explore changed.
*/

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Columns3, ExternalLink, Eye, EyeOff, ListFilter, Loader2, SquareCheck, Star, Trash2 } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import RepoTree from "@/RepoTree";
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
import { Button } from "@/components/ui/button";
import { ColumnsDialog } from "@/components/ui/columns-dialog";
import { ASK_LABEL, FIT_LEVELS, FitTag, NEWCOMER_LABEL, NewcomersTag, POLICY_LABEL, PolicyTag, TONE_LABEL, ToneTag } from "@/components/ui/repo-tags";
import { Input } from "@/components/ui/input";
import { RowSelection, SelectBox } from "@/components/ui/row-selection";
import { api, useLive, useLiveValue, useLoaded, type ListedRepo } from "@/live";
import { useColumnWidths } from "@/lib/column-widths";
import { cn, timeAgo } from "@/lib/utils";

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// Beginner issues shown in an open row; the rest are on GitHub.
const BEGINNER_SHOWN = 6;
const SORT_STORAGE = "repos-sort";

type SortKey =
  | "name"
  | "stars"
  | "listed"
  | "added"
  | "added_by"
  | "lane"
  | "fit"
  | "language"
  | "pushed"
  | "reply"
  | "merged"
  | "merge_time"
  | "outside_prs"
  | "stale"
  | "mergers"
  | "unclaimed"
  | "beginner"
  | "newcomer_tag"
  | "newcomers"
  | "newcomer_reply"
  | "newcomer_prs"
  | "returned"
  | "prs"
  | "prs_merged"
  | "issues"
  | "issues_closed"
  | "commits"
  | "commits_30d"
  | "trend"
  | "release"
  | "issue_replies"
  | "ai_policy"
  | "tone"
  | "asks"
  | "community"
  | "tracked";

type Sort = { key: SortKey; dir: "down" | "up" };

// Every field to sort by. better says which way down (the best first) goes: higher numbers first, lower numbers first,
// or A to Z for text. down and up are the two ways, in words.
const SORT_FIELDS: { key: SortKey; label: string; group: string; better: "higher" | "lower" | "text"; down: string; up: string }[] = [
  { key: "name", label: "Name", group: "Repo", better: "text", down: "A to Z", up: "Z to A" },
  { key: "stars", label: "Stars", group: "Repo", better: "higher", down: "Most stars first", up: "Fewest stars first" },
  { key: "listed", label: "Listed issues", group: "Repo", better: "higher", down: "Most issues in the Issues list first", up: "Fewest first" },
  { key: "added", label: "Added", group: "Repo", better: "higher", down: "Newest first", up: "Oldest first" },
  { key: "added_by", label: "Added by", group: "Repo", better: "text", down: "A to Z (agent, explore, user)", up: "Z to A" },
  { key: "lane", label: "Type", group: "Repo", better: "text", down: "A to Z", up: "Z to A" },
  { key: "fit", label: "Fit", group: "Repo", better: "higher", down: "Best fit first", up: "Weakest fit first" },
  { key: "language", label: "Language", group: "Repo", better: "text", down: "A to Z", up: "Z to A" },
  { key: "pushed", label: "Last push", group: "Repo", better: "higher", down: "Most recent first", up: "Longest ago first" },
  { key: "reply", label: "Reply speed", group: "Outside contributors", better: "lower", down: "Fastest first reply first", up: "Slowest first" },
  { key: "merged", label: "Outside PRs merged", group: "Outside contributors", better: "higher", down: "Most merged first", up: "Least merged first" },
  { key: "merge_time", label: "Time to merge", group: "Outside contributors", better: "lower", down: "Fastest merges first", up: "Slowest first" },
  { key: "outside_prs", label: "Outside PRs", group: "Outside contributors", better: "higher", down: "Most outside PRs first", up: "Fewest first" },
  { key: "stale", label: "Unanswered PRs", group: "Outside contributors", better: "lower", down: "Fewest unanswered PRs first", up: "Most first" },
  { key: "mergers", label: "Maintainers", group: "Outside contributors", better: "higher", down: "Most maintainers first", up: "Fewest first" },
  { key: "unclaimed", label: "Unclaimed beginner issues", group: "Outside contributors", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "beginner", label: "Beginner issues", group: "Outside contributors", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "newcomer_tag", label: "Welcomes newcomers", group: "Newcomers", better: "higher", down: "Most welcoming first", up: "Least welcoming first" },
  { key: "newcomers", label: "Newcomers merged", group: "Newcomers", better: "higher", down: "Most first PRs merged first", up: "Least first" },
  { key: "newcomer_reply", label: "Newcomer reply speed", group: "Newcomers", better: "lower", down: "Fastest first", up: "Slowest first" },
  { key: "newcomer_prs", label: "New contributors", group: "Newcomers", better: "higher", down: "Most new contributors a day first", up: "Fewest first" },
  { key: "returned", label: "Newcomers who came back", group: "Newcomers", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "prs", label: "PRs a month", group: "Activity", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "prs_merged", label: "PRs merged a month", group: "Activity", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "issues", label: "Issues a month", group: "Activity", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "issues_closed", label: "Issues closed a month", group: "Activity", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "commits", label: "Commits a month", group: "Activity", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "commits_30d", label: "Commits, last 30 days", group: "Activity", better: "higher", down: "Most first", up: "Fewest first" },
  { key: "trend", label: "Trend", group: "Activity", better: "higher", down: "Getting busier first", up: "Getting quieter first" },
  { key: "release", label: "Last release", group: "Activity", better: "higher", down: "Most recent first", up: "Longest ago first" },
  { key: "issue_replies", label: "Issues answered", group: "Activity", better: "higher", down: "Most new issues answered first", up: "Fewest first" },
  { key: "ai_policy", label: "AI policy", group: "Policy and reviews", better: "higher", down: "Most open to AI first", up: "Strictest first" },
  { key: "tone", label: "Review tone", group: "Policy and reviews", better: "higher", down: "Warmest first", up: "Curtest first" },
  { key: "asks", label: "Reviewer asks", group: "Policy and reviews", better: "lower", down: "Fewest asks first", up: "Most asks first" },
  { key: "community", label: "Community", group: "Policy and reviews", better: "higher", down: "Most (guide, code of conduct, Discussions, chat) first", up: "Fewest first" },
  { key: "tracked", label: "Tracked", group: "Repo", better: "higher", down: "Tracked first", up: "Not tracked first" },
];
const SORT_GROUPS = ["Repo", "Outside contributors", "Newcomers", "Activity", "Policy and reviews"];

// The fixed order of each judged or tagged value, best first being the highest. Values not listed (unknown) go last.
const POLICY_RANK: Record<string, number> = { welcome: 5, none: 4, disclose: 3, unclear: 2, no_ai: 1 };
const NEWCOMER_RANK: Record<string, number> = { welcomes: 5, ok: 4, few: 3, left_waiting: 2, turned_away: 1 };
const TONE_RANK: Record<string, number> = { warm: 4, neutral: 3, strict: 2, curt: 1 };
const TREND_RANK: Record<string, number> = { up: 3, flat: 2, down: 1 };

// Every column a row can show; the Columns dialog picks which, and their order. label is the header, name what the
// dialog calls it, sort the field a click on its header sorts by. Each is as wide as its widest cell. Name always comes
// first (NAME_COLUMN) and takes the room left over, never under NAME_MIN px; in select mode the boxes come before it.
type ColumnKey = SortKey | "activity";
type TableColumn = { key: ColumnKey; label: string; name: string; group: string; title: string; sort: SortKey };

const NAME_COLUMN: TableColumn = { key: "name", label: "Name", name: "Name", group: "Repo", title: "owner/name on GitHub", sort: "name" };

const TABLE_COLUMNS: TableColumn[] = [
  { key: "stars", label: "Stars", name: "Stars", group: "Repo", title: "Stars on GitHub", sort: "stars" },
  { key: "listed", label: "Issues", name: "Listed issues", group: "Repo", title: "Its issues in the Issues list", sort: "listed" },
  { key: "added", label: "Added", name: "Added", group: "Repo", title: "When it was added to the list", sort: "added" },
  { key: "added_by", label: "Added by", name: "Added by", group: "Repo", title: "Who added it: an agent, Explore or you", sort: "added_by" },
  { key: "lane", label: "Type", name: "Type", group: "Repo", title: "Its type: one of the types of repo in your Explore profile (set by Explore or the agent that added it)", sort: "lane" },
  { key: "fit", label: "Fit", name: "Fit", group: "Repo", title: "How well Claude thinks it fits your Explore profile", sort: "fit" },
  { key: "language", label: "Language", name: "Language", group: "Repo", title: "Its main language on GitHub", sort: "language" },
  { key: "pushed", label: "Pushed", name: "Last push", group: "Repo", title: "The last push to GitHub", sort: "pushed" },
  { key: "reply", label: "Reply", name: "Reply speed", group: "Outside contributors", title: "Median days until outside contributors' PRs get a first reply from a maintainer (bots and other outsiders don't count)", sort: "reply" },
  { key: "merged", label: "Merged", name: "Outside PRs merged", group: "Outside contributors", title: "Outside contributors' PRs merged, of those merged or closed", sort: "merged" },
  { key: "merge_time", label: "To merge", name: "Time to merge", group: "Outside contributors", title: "Median days until outside contributors' PRs are merged", sort: "merge_time" },
  { key: "outside_prs", label: "Outside PRs", name: "Outside PRs", group: "Outside contributors", title: "PRs outside contributors opened in the window (at most 90 days)", sort: "outside_prs" },
  { key: "stale", label: "Unanswered", name: "Unanswered PRs", group: "Outside contributors", title: "Outside contributors' PRs open over 30 days that no maintainer answered", sort: "stale" },
  { key: "mergers", label: "Maintainers", name: "Maintainers", group: "Outside contributors", title: "People who merged a PR in the last 30 days", sort: "mergers" },
  { key: "unclaimed", label: "Unclaimed", name: "Unclaimed beginner issues", group: "Outside contributors", title: "Open beginner issues nobody seems to have taken", sort: "unclaimed" },
  { key: "beginner", label: "Beginner", name: "Beginner issues", group: "Outside contributors", title: "Open beginner issues", sort: "beginner" },
  { key: "newcomer_tag", label: "Newcomers", name: "Newcomers (tag)", group: "Newcomers", title: "How newcomers' first PRs fare", sort: "newcomer_tag" },
  { key: "newcomers", label: "New merged", name: "Newcomers merged", group: "Newcomers", title: "Newcomers' first PRs merged, of those merged or closed", sort: "newcomers" },
  { key: "newcomer_reply", label: "New reply", name: "Newcomer reply speed", group: "Newcomers", title: "Median days until newcomers' first PRs get a first reply from a maintainer", sort: "newcomer_reply" },
  { key: "newcomer_prs", label: "New contributors", name: "New contributors", group: "Newcomers", title: "People whose first PR there came in the time shown: its 100 newest PRs, at most 90 days, among the 30 most recent outside authors. People who contributed before don't count, nor do maintainers or bots", sort: "newcomer_prs" },
  { key: "returned", label: "Came back", name: "Newcomers who came back", group: "Newcomers", title: "Newcomers who opened a second PR", sort: "returned" },
  { key: "activity", label: "Activity", name: "Activity (tag)", group: "Activity", title: "PRs, issues and commits a month (90-day average); sorts by commits a month", sort: "commits" },
  { key: "prs", label: "PRs/mo", name: "PRs a month", group: "Activity", title: "PRs opened a month, on average over 90 days", sort: "prs" },
  { key: "prs_merged", label: "Merged/mo", name: "PRs merged a month", group: "Activity", title: "PRs merged a month, on average over 90 days", sort: "prs_merged" },
  { key: "issues", label: "Issues/mo", name: "Issues a month", group: "Activity", title: "Issues opened a month, on average over 90 days", sort: "issues" },
  { key: "issues_closed", label: "Closed/mo", name: "Issues closed a month", group: "Activity", title: "Issues closed a month, on average over 90 days", sort: "issues_closed" },
  { key: "commits", label: "Commits/mo", name: "Commits a month", group: "Activity", title: "Commits a month, on average over 90 days", sort: "commits" },
  { key: "commits_30d", label: "Commits 30d", name: "Commits, last 30 days", group: "Activity", title: "Commits on the default branch in the last 30 days", sort: "commits_30d" },
  { key: "trend", label: "Trend", name: "Trend", group: "Activity", title: "The last 30 days against the 90-day average", sort: "trend" },
  { key: "release", label: "Release", name: "Last release", group: "Activity", title: "Its last GitHub release", sort: "release" },
  { key: "issue_replies", label: "Answered", name: "Issues answered", group: "Activity", title: "New issues a maintainer answered within a week", sort: "issue_replies" },
  { key: "ai_policy", label: "AI policy", name: "AI policy", group: "Policy and reviews", title: "What its contribution files say about AI", sort: "ai_policy" },
  { key: "tone", label: "Reviews", name: "Review tone", group: "Policy and reviews", title: "How maintainers' feedback on outside PRs feels", sort: "tone" },
  { key: "asks", label: "Asks", name: "Reviewer asks", group: "Policy and reviews", title: "How many things reviewers ask contributors for (tests, docs, a changelog entry...)", sort: "asks" },
  { key: "community", label: "Community", name: "Community", group: "Policy and reviews", title: "Contributing guide, code of conduct, GitHub Discussions and chat", sort: "community" },
];
// What a row shows until the Columns dialog changes it: the main ones first (outside PRs merged, newcomers' first PRs
// merged, how newcomers fare,
// the AI policy and how fast a maintainer replies), then much like the Explore page's columns, then the repo's issues
// in the Issues list.
const DEFAULT_COLUMNS: ColumnKey[] = [
  "merged",
  "newcomers",
  "newcomer_tag",
  "ai_policy",
  "reply",
  "lane",
  "fit",
  "stars",
  "tone",
  "prs",
  "issues",
  "commits",
  "trend",
  "newcomer_prs",
  "mergers",
  "stale",
  "listed",
];
// "-5": saved before the main columns came first (Score went, newcomers' merge rate joined them, new contributors took
// all recent PR authors' place); starting from the new defaults once shows them.
const COLUMNS_STORAGE = "repos-columns-5";
// The AI policy, newcomers and tone columns are tags (the Explore page's too): green for good news, amber for "have a
// look", red for bad, gray for the rest. Other values are plain text, colored only when it means something.
const POLICY_VARIANT: Record<string, "ok" | "fine" | "warn" | "bad"> = { welcome: "ok", none: "fine", no_ai: "bad" };
const NEWCOMER_VARIANT: Record<string, "ok" | "warn" | "bad"> = { welcomes: "ok", turned_away: "bad", left_waiting: "bad" };
const TONE_VARIANT: Record<string, "ok" | "warn" | "bad"> = { warm: "ok", strict: "warn", curt: "bad" };
const NAME_MIN = 160;
// The Track / Untrack column at the end, wide enough for its button.
const TRACK_WIDTH = 88;

// The sorts this browser used last, the ones still known. Storage can be blocked (private window): then it starts
// unsorted.
const savedSorts: Sort[] = [];
try {
  let saved = JSON.parse(localStorage.getItem(SORT_STORAGE) ?? "[]");
  // Saved when only one field could sort: that one alone.
  if (saved !== null && !Array.isArray(saved)) {
    saved = [saved];
  }
  if (Array.isArray(saved)) {
    for (const each of saved) {
      const known = each !== null && SORT_FIELDS.some((field) => field.key === each.key) && (each.dir === "down" || each.dir === "up");
      if (known && !savedSorts.some((other) => other.key === each.key)) {
        savedSorts.push({ key: each.key, dir: each.dir });
      }
    }
  }
} catch {
  // Storage blocked or broken: unsorted.
}

// The columns this browser showed last. Storage can be blocked: then the defaults.
let savedColumns: ColumnKey[] = DEFAULT_COLUMNS;
try {
  const saved = JSON.parse(localStorage.getItem(COLUMNS_STORAGE) ?? "{}");
  if (Array.isArray(saved?.shown)) {
    savedColumns = saved.shown.filter(
      (key: unknown, index: number, all: unknown[]) => all.indexOf(key) === index && TABLE_COLUMNS.some((column) => column.key === key),
    );
  }
} catch {
  savedColumns = DEFAULT_COLUMNS;
}

export default function Repos() {
  const repos = useLive("repos");
  const issues = useLive("issues");
  const tracked = useLive("tracked");
  // Tracked repos' names, without case, for each row's Track / Untrack and for sorting by it.
  const trackedNames = tracked.items.map((each) => each.full_name.toLowerCase());
  const loaded = useLoaded("repos");
  // "prestige=Prestige\nai=AI & harness": a string, so a busy Explore run doesn't redraw this page.
  const lanesText = useLiveValue((topics) => topics.explore.profile.lanes.map((lane) => `${lane.id}=${lane.label}`).join("\n"));
  const [open, setOpen] = useState<string[]>([]);
  // The fields the list sorts by, in any order: which counts first comes from the columns (priority below).
  const [sorts, setSorts] = useState<Sort[]>(savedSorts);
  const [allFields, setAllFields] = useState(false);
  const [shown, setShown] = useState<ColumnKey[]>(savedColumns);
  const [choosing, setChoosing] = useState(false);
  // The hidden copy of every row's cells, and the widths it gives each column, then each tag slot.
  const sizerRef = useRef<HTMLDivElement>(null);
  const sizes = useColumnWidths(sizerRef);
  // Selected repos, the last one clicked (where a shift-click range starts), and the bulk action waiting for its confirm.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  // Select mode: every row shows a box and a click picks it. Picking a row any other way shows the boxes too.
  const [selecting, setSelecting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Repos whose Track / Untrack is waiting for the backend.
  const [tracking, setTracking] = useState<string[]>([]);
  // The box on top that adds a repo by its GitHub link, and whether that waits for the backend.
  const [link, setLink] = useState("");
  const [addingLink, setAddingLink] = useState(false);
  const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // "3h ago" goes stale on its own: draw again every minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE, JSON.stringify(sorts));
    } catch {
      // Storage blocked: the sort just isn't kept.
    }
  }, [sorts]);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_STORAGE, JSON.stringify({ shown }));
    } catch {
      // Storage blocked: the columns just aren't kept.
    }
  }, [shown]);

  const laneLabels: Record<string, string> = {};
  for (const line of lanesText.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) {
      laneLabels[line.slice(0, at)] = line.slice(at + 1);
    }
  }

  // How many listed issues each repo has.
  const issueCounts: Record<string, number> = {};
  for (const issue of issues.items) {
    issueCounts[issue.repo] = (issueCounts[issue.repo] ?? 0) + 1;
  }

  // The value a repo sorts by: a number, or text for the text fields. null when it doesn't have it (yet).
  function sortValue(repo: ListedRepo, key: SortKey): number | string | null {
    const signals = repo.signals;
    if (key === "name") {
      return repo.full_name.toLowerCase();
    }
    if (key === "stars") {
      return repo.stars;
    }
    if (key === "listed") {
      return issueCounts[repo.full_name] ?? 0;
    }
    if (key === "added") {
      return new Date(repo.added_at).getTime();
    }
    if (key === "added_by") {
      return repo.added_by.toLowerCase();
    }
    if (key === "lane") {
      return repo.lane !== undefined ? (laneLabels[repo.lane] ?? repo.lane).toLowerCase() : null;
    }
    if (key === "fit") {
      return repo.fit ?? null;
    }
    if (key === "tracked") {
      return trackedNames.includes(repo.full_name.toLowerCase()) ? 1 : 0;
    }
    if (signals === null) {
      return null;
    }
    if (key === "language") {
      return signals.language !== null ? signals.language.toLowerCase() : null;
    }
    if (key === "pushed") {
      return new Date(signals.pushed_at).getTime();
    }
    if (key === "reply") {
      return signals.median_days_to_first_reply;
    }
    if (key === "merged") {
      return signals.outside_merge_rate;
    }
    if (key === "merge_time") {
      return signals.median_days_to_merge;
    }
    if (key === "outside_prs") {
      return signals.outside_prs_90d;
    }
    if (key === "stale") {
      return signals.stale_outside_prs;
    }
    if (key === "mergers") {
      return signals.active_mergers_30d;
    }
    if (key === "unclaimed") {
      return signals.unclaimed_beginner_issues;
    }
    if (key === "beginner") {
      return signals.beginner_issues.length;
    }
    if (key === "commits_30d") {
      return signals.commits_30d;
    }
    if (key === "ai_policy") {
      return signals.ai_policy !== null ? (POLICY_RANK[signals.ai_policy.tag] ?? null) : null;
    }
    const newcomers = signals.newcomers;
    if (key === "newcomer_tag") {
      return newcomers !== undefined ? (NEWCOMER_RANK[newcomers.tag] ?? null) : null;
    }
    if (key === "newcomers") {
      return newcomers?.merge_rate ?? null;
    }
    if (key === "newcomer_reply") {
      return newcomers?.median_days_to_first_reply ?? null;
    }
    if (key === "newcomer_prs") {
      // Per day, so a repo whose newest PRs cover a week compares fairly with one whose cover three months.
      if (newcomers === undefined || signals.pr_window_days === undefined) {
        return null;
      }
      return newcomers.prs / signals.pr_window_days;
    }
    if (key === "returned") {
      return newcomers?.returned ?? null;
    }
    const activity = signals.activity;
    if (key === "prs") {
      return activity?.prs_opened_month ?? null;
    }
    if (key === "prs_merged") {
      return activity?.prs_merged_month ?? null;
    }
    if (key === "issues") {
      return activity?.issues_opened_month ?? null;
    }
    if (key === "issues_closed") {
      return activity?.issues_closed_month ?? null;
    }
    if (key === "commits") {
      return activity?.commits_month ?? null;
    }
    if (key === "trend") {
      return activity !== undefined ? TREND_RANK[activity.trend] : null;
    }
    if (key === "issue_replies") {
      return activity?.issue_reply_rate ?? null;
    }
    if (key === "release") {
      return activity?.last_release_at ? new Date(activity.last_release_at).getTime() : null;
    }
    const atmosphere = signals.atmosphere ?? null;
    if (key === "tone") {
      return atmosphere !== null ? (TONE_RANK[atmosphere.tone] ?? null) : null;
    }
    if (key === "asks") {
      // Too little feedback to judge says nothing about how much reviewers ask for.
      return atmosphere !== null && atmosphere.tone !== "unknown" ? atmosphere.asks_for.length : null;
    }
    const community = signals.community;
    if (community === undefined) {
      return null;
    }
    let present = community.channels.length > 0 ? 1 : 0;
    for (const has of [community.contributing, community.code_of_conduct, community.discussions]) {
      present += has ? 1 : 0;
    }
    return present;
  }

  // Which sorted field counts first, from left to right: the shown columns in their order, then Track (the last
  // column), then the fields not shown (in the All fields panel's order), the name last.
  const priority: SortKey[] = [];
  for (const key of [...shown.map((each) => TABLE_COLUMNS.find((column) => column.key === each)!.sort), "tracked" as SortKey, ...SORT_FIELDS.map((field) => field.key)]) {
    if (key !== "name" && !priority.includes(key)) {
      priority.push(key);
    }
  }
  priority.push("name");
  const orderedSorts: Sort[] = [];
  for (const key of priority) {
    const sort = sorts.find((each) => each.key === key);
    if (sort !== undefined) {
      orderedSorts.push(sort);
    }
  }

  // A copy, since sorting changes the list in place.
  const rows = [...repos.items];
  if (orderedSorts.length > 0) {
    rows.sort((a, b) => {
      // The first sorted field that tells them apart decides; when none does, they keep the list's order.
      for (const sort of orderedSorts) {
        const field = SORT_FIELDS.find((each) => each.key === sort.key);
        const first = sortValue(a, sort.key);
        const second = sortValue(b, sort.key);
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
        // Low to high (A to Z for text), then turned round when down means higher first, and again for up.
        let order = typeof first === "string" && typeof second === "string" ? first.localeCompare(second) : Number(first) - Number(second);
        if (field?.better === "higher") {
          order = -order;
        }
        if (sort.dir === "up") {
          order = -order;
        }
        if (order !== 0) {
          return order;
        }
      }
      return 0;
    });
  }

  const openIndexes: number[] = [];
  rows.forEach((repo, index) => {
    if (open.includes(repo.full_name)) {
      openIndexes.push(index);
    }
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 10,
    getItemKey: (index) => rows[index].full_name,
    // The rows on screen, and every open row even far off screen, so it is never unmounted.
    rangeExtractor: (range) => {
      const indexes = new Set([...defaultRangeExtractor(range), ...openIndexes]);
      return [...indexes].sort((a, b) => a - b);
    },
  });

  // One click, one step: add the field to the sort (the best first), turn it round, then take it out.
  function clickSort(key: SortKey) {
    const sort = sorts.find((each) => each.key === key);
    if (sort === undefined) {
      setSorts([...sorts, { key, dir: "down" }]);
    } else if (sort.dir === "down") {
      setSorts(sorts.map((each) => (each.key === key ? { key, dir: "up" } : each)));
    } else {
      setSorts(sorts.filter((each) => each.key !== key));
    }
  }

  async function undo() {
    try {
      await api("/api/repos/undo", { method: "POST" });
    } catch (err) {
      toast.error(`Undo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function redo() {
    try {
      await api("/api/repos/redo", { method: "POST" });
    } catch (err) {
      toast.error(`Redo failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Add the repo the box on top names (a GitHub link or owner/name). The box empties once it is in.
  async function addLink() {
    setAddingLink(true);
    try {
      const answer = await api<{ added: string[] }>("/api/repos/add", { method: "POST", body: { name: link.trim() } });
      setLink("");
      toast.success(`Added ${answer.added[0]} to Repos`);
    } catch (err) {
      toast.error(`Could not add it: ${err instanceof Error ? err.message : err}`);
    } finally {
      setAddingLink(false);
    }
  }

  // Track a repo, or stop tracking it. GitHub spells names its own way, so they are compared without case.
  async function toggleTracked(name: string) {
    const item = tracked.items.find((each) => each.full_name.toLowerCase() === name.toLowerCase());
    setTracking((current) => [...current, name]);
    try {
      if (item !== undefined) {
        await api("/api/tracked/remove", { method: "POST", body: { names: [item.full_name] } });
      } else {
        await api("/api/tracked", { method: "POST", body: { name } });
      }
    } catch (err) {
      toast.error(`Could not ${item !== undefined ? "stop tracking" : "track"} ${name}: ${err instanceof Error ? err.message : err}`);
    }
    setTracking((current) => current.filter((each) => each !== name));
  }

  // Track many picked repos at once, as one undo step on the Tracked page: no GitHub call, the Repos list knows them.
  async function trackMany(names: string[]) {
    try {
      await api("/api/tracked/from_repos", { method: "POST", body: { names } });
    } catch (err) {
      toast.error(`Could not track: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Stop tracking many picked repos at once, as one undo step on the Tracked page.
  async function untrackMany(names: string[]) {
    try {
      await api("/api/tracked/remove", { method: "POST", body: { names } });
    } catch (err) {
      toast.error(`Could not stop tracking: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(names: string[]) {
    try {
      await api("/api/repos/remove", { method: "POST", body: { names } });
      setSelected((current) => current.filter((name) => !names.includes(name)));
      setSelecting(false);
    } catch (err) {
      toast.error(`Could not delete: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Only repos still in the list count as selected (an undo, an agent or another tab may have taken some out).
  const rowNames = rows.map((repo) => repo.full_name);
  const listed = repos.items.map((repo) => repo.full_name);
  const chosen = selected.filter((name) => listed.includes(name));
  // The picked repos the bar's Track would add (the ones not tracked yet), and the ones Untrack would take off the
  // Tracked page, spelled as it has them.
  const untrackedChosen = chosen.filter((name) => !trackedNames.includes(name.toLowerCase()));
  const chosenLower = chosen.map((name) => name.toLowerCase());
  const trackedChosen = tracked.items.filter((each) => chosenLower.includes(each.full_name.toLowerCase())).map((each) => each.full_name);

  // A ctrl-click picks or unpicks one row; a shift-click does the same to every row shown from the last one clicked.
  function select(name: string, shift: boolean) {
    const on = !chosen.includes(name);
    let names = [name];
    if (shift && anchor !== null && rowNames.includes(anchor)) {
      const from = rowNames.indexOf(anchor);
      const to = rowNames.indexOf(name);
      names = rowNames.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !names.includes(each)), ...names] : chosen.filter((each) => !names.includes(each)));
    setAnchor(name);
  }

  // Clearing the selection (Escape, the bar's x, a click on the list's empty space) also ends select mode.
  function onSelect(names: string[]) {
    setSelected(names);
    if (names.length === 0) {
      setSelecting(false);
    }
  }
  const selectMode = selecting || chosen.length > 0;
  const allPicked = rowNames.length > 0 && rowNames.every((name) => chosen.includes(name));

  function toggle(name: string) {
    setOpen((current) => (current.includes(name) ? current.filter((n) => n !== name) : [...current, name]));
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
      if (key === "z" && !event.shiftKey && repos.can_undo) {
        event.preventDefault();
        undo();
      } else if ((key === "y" || (key === "z" && event.shiftKey)) && repos.can_redo) {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // A field's arrow: faint until the list sorts by that field, then lit and pointing the way it sorts. A click goes
  // one step: down (the best first), up, then off.
  function sortArrow(key: SortKey) {
    const field = SORT_FIELDS.find((each) => each.key === key)!;
    const dir = sorts.find((each) => each.key === key)?.dir ?? null;
    const next = dir === null ? field.down : dir === "down" ? field.up : "stop sorting";
    return (
      <span className="inline-flex shrink-0 items-center">
        <button
          type="button"
          className={cn("rounded-sm p-px hover:bg-accent hover:text-foreground", dir === null ? "text-muted-foreground/50" : "text-primary")}
          aria-label={`${field.label}: ${next}`}
          title={`${field.label}: ${next}`}
          onClick={(event) => {
            event.stopPropagation();
            clickSort(key);
          }}
        >
          {dir === "up" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
        </button>
      </span>
    );
  }

  // What a column shows for a repo. Text too long for the column is cut short, tags too.
  function cell(key: ColumnKey, repo: ListedRepo) {
    const signals = repo.signals;
    if (key === "stars") {
      return (
        <span className="inline-flex items-center gap-1">
          <Star className="size-3.5" />
          {COUNT.format(repo.stars)}
        </span>
      );
    }
    if (key === "listed") {
      const count = issueCounts[repo.full_name] ?? 0;
      return (
        <a
          href={`#/issues?repo=${encodeURIComponent(repo.full_name)}`}
          className={cn("hover:underline", count > 0 && "text-primary")}
          onClick={(event) => event.stopPropagation()}
        >
          {count} {count === 1 ? "issue" : "issues"}
        </a>
      );
    }
    if (key === "added") {
      return timeAgo(repo.added_at);
    }
    if (key === "added_by") {
      return repo.added_by;
    }
    if (key === "lane") {
      return repo.lane !== undefined ? (laneLabels[repo.lane] ?? repo.lane) : "–";
    }
    if (key === "fit") {
      if (repo.fit === undefined) {
        return "–";
      }
      const fit = repo.fit;
      const level = FIT_LEVELS.find((each) => fit >= each.from) ?? FIT_LEVELS[FIT_LEVELS.length - 1];
      return <Badge variant={level.variant}>{level.label}</Badge>;
    }
    if (signals === null) {
      return "–";
    }
    if (key === "language") {
      return signals.language ?? "–";
    }
    if (key === "pushed") {
      return timeAgo(signals.pushed_at);
    }
    if (key === "reply") {
      const days = signals.median_days_to_first_reply;
      if (days === null) {
        return "–";
      }
      return <span className={cn(days <= 2 && "text-ok", days > 7 && "text-warn")}>{days}d</span>;
    }
    if (key === "merged") {
      return signals.outside_merge_rate === null ? "–" : `${Math.round(signals.outside_merge_rate * 100)}%`;
    }
    if (key === "merge_time") {
      return signals.median_days_to_merge === null ? "–" : `${signals.median_days_to_merge}d`;
    }
    if (key === "outside_prs") {
      return signals.outside_prs_90d;
    }
    if (key === "stale") {
      return <span className={cn(signals.stale_outside_prs >= 5 && "text-warn")}>{signals.stale_outside_prs}</span>;
    }
    if (key === "mergers") {
      return <span className={cn(signals.active_mergers_30d <= 1 && "text-warn")}>{signals.active_mergers_30d}</span>;
    }
    if (key === "unclaimed") {
      return signals.unclaimed_beginner_issues;
    }
    if (key === "beginner") {
      return signals.beginner_issues.length;
    }
    if (key === "commits_30d") {
      return <span className={cn(signals.commits_30d === 0 && "text-warn")}>{signals.commits_30d}</span>;
    }
    if (key === "ai_policy") {
      if (signals.ai_policy === null) {
        return "–";
      }
      const policy = signals.ai_policy;
      return (
        <Badge variant={POLICY_VARIANT[policy.tag] ?? "secondary"} title={policy.quote !== "" ? `"${policy.quote}" (${policy.file})` : undefined}>
          {POLICY_LABEL[policy.tag] ?? policy.tag}
        </Badge>
      );
    }
    const newcomers = signals.newcomers;
    if (key === "newcomer_tag") {
      if (newcomers === undefined) {
        return "–";
      }
      return (
        <Badge variant={NEWCOMER_VARIANT[newcomers.tag] ?? "secondary"} title={`${newcomers.prs} newcomers' first PRs: ${newcomers.merged} merged, ${newcomers.closed} closed unmerged`}>
          {NEWCOMER_LABEL[newcomers.tag] ?? newcomers.tag}
        </Badge>
      );
    }
    if (key === "newcomers") {
      if (newcomers === undefined || newcomers.merge_rate === null) {
        return "–";
      }
      return (
        <span
          className={cn(newcomers.tag === "welcomes" && "text-ok", (newcomers.tag === "turned_away" || newcomers.tag === "left_waiting") && "text-destructive")}
          title={`${newcomers.prs} newcomers' first PRs: ${newcomers.merged} merged, ${newcomers.closed} closed unmerged, ${newcomers.prs - newcomers.merged - newcomers.closed} still open`}
        >
          {Math.round(newcomers.merge_rate * 100)}%
        </span>
      );
    }
    if (key === "newcomer_reply") {
      const days = newcomers?.median_days_to_first_reply ?? null;
      return days === null ? "–" : `${days}d`;
    }
    if (key === "newcomer_prs") {
      if (newcomers === undefined || signals.pr_window_days === undefined) {
        return "–";
      }
      return `${newcomers.prs} in ${signals.pr_window_days} day${signals.pr_window_days === 1 ? "" : "s"}`;
    }
    if (key === "returned") {
      return newcomers?.returned ?? "–";
    }
    const activity = signals.activity;
    if (key === "activity") {
      if (activity === undefined) {
        return "–";
      }
      const arrow = activity.trend === "up" ? " ↑" : activity.trend === "down" ? " ↓" : "";
      return `${COUNT.format(activity.prs_opened_month)} PRs · ${COUNT.format(activity.issues_opened_month)} issues · ${COUNT.format(activity.commits_month)} commits /mo${arrow}`;
    }
    if (key === "prs") {
      return activity !== undefined ? COUNT.format(activity.prs_opened_month) : "–";
    }
    if (key === "prs_merged") {
      return activity !== undefined ? COUNT.format(activity.prs_merged_month) : "–";
    }
    if (key === "issues") {
      return activity !== undefined ? COUNT.format(activity.issues_opened_month) : "–";
    }
    if (key === "issues_closed") {
      return activity !== undefined ? COUNT.format(activity.issues_closed_month) : "–";
    }
    if (key === "commits") {
      return activity !== undefined ? COUNT.format(activity.commits_month) : "–";
    }
    if (key === "trend") {
      if (activity === undefined) {
        return "–";
      }
      if (activity.trend === "up") {
        return <span className="text-ok">↑ busier</span>;
      }
      return activity.trend === "down" ? "↓ quieter" : "steady";
    }
    if (key === "release") {
      return activity?.last_release_at ? timeAgo(activity.last_release_at) : "–";
    }
    if (key === "issue_replies") {
      const rate = activity?.issue_reply_rate ?? null;
      return rate === null ? "–" : `${Math.round(rate * 100)}%`;
    }
    const atmosphere = signals.atmosphere ?? null;
    if (key === "tone") {
      if (atmosphere === null) {
        return "–";
      }
      return (
        <Badge variant={TONE_VARIANT[atmosphere.tone] ?? "secondary"} title={atmosphere.summary}>
          {TONE_LABEL[atmosphere.tone] ?? atmosphere.tone}
        </Badge>
      );
    }
    if (key === "asks") {
      if (atmosphere === null || atmosphere.tone === "unknown") {
        return "–";
      }
      return <span title={atmosphere.asks_for.map((ask) => ASK_LABEL[ask] ?? ask).join(", ")}>{atmosphere.asks_for.length}</span>;
    }
    const community = signals.community;
    if (key === "community" && community !== undefined) {
      const parts = [
        community.contributing ? "Contributing guide" : "",
        community.code_of_conduct ? "Code of conduct" : "",
        community.discussions ? "Discussions" : "",
        ...community.channels,
      ].filter((part) => part !== "");
      return parts.length > 0 ? <span title={parts.join(" · ")}>{parts.join(" · ")}</span> : "None";
    }
    return "–";
  }

  // The columns shown, how wide the sizer made each (max-content until it has measured), and the grid the header and
  // the rows share: the boxes (always there, so a row's box can show on hover without the row moving), name (the room left over), the columns, then Track / Untrack. tableWidth
  // is the least they need, padding and gaps (16px, like the Explore page) too.
  const shownColumns = shown.map((key) => TABLE_COLUMNS.find((column) => column.key === key)!);
  const measured = sizes.length === shownColumns.length;
  let tableWidth = 24 + NAME_MIN + 16 * shownColumns.length + 32 + TRACK_WIDTH + 16;
  const columnTracks: string[] = [];
  for (let index = 0; index < shownColumns.length; index++) {
    columnTracks.push(measured ? `${sizes[index]}px` : "max-content");
    tableWidth += measured ? sizes[index] : 0;
  }
  const template = `16px minmax(${NAME_MIN}px,1fr) ${columnTracks.join(" ")} ${TRACK_WIDTH}px`;

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1">
        {/* Out of select mode: a box to add a repo by its GitHub link (Enter or Add). */}
        {!selectMode && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              addLink();
            }}
          >
            <Input
              className="h-6 w-72"
              placeholder="Paste a GitHub link or owner/name"
              value={link}
              disabled={addingLink}
              onChange={(event) => setLink(event.target.value)}
            />
            <Button type="submit" variant="outline" size="xs" disabled={addingLink || link.trim() === ""}>
              {addingLink && <Loader2 className="animate-spin" />} Add
            </Button>
          </form>
        )}
        {/* What to do with the picked repos, on the left while in select mode. */}
        {selectMode && (
          <>
            <Button variant="ghost" size="xs" disabled={chosen.length === 0} title="Delete the picked repos" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={untrackedChosen.length === 0}
              title={untrackedChosen.length === 0 ? "Pick repos not tracked yet" : `Track the ${untrackedChosen.length} picked repos not tracked yet`}
              onClick={() => trackMany(untrackedChosen)}
            >
              <Eye /> Track
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={trackedChosen.length === 0}
              title={trackedChosen.length === 0 ? "Pick repos that are tracked" : `Stop tracking the ${trackedChosen.length} picked repos that are tracked`}
              onClick={() => untrackMany(trackedChosen)}
            >
              <EyeOff /> Untrack
            </Button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant={selectMode ? "secondary" : "ghost"} size="xs"
            disabled={!selectMode && rowNames.length === 0}
            title={selectMode ? "Stop selecting (Esc)" : "Pick rows: every row shows its box, and a click picks it"}
            onClick={() => (selectMode ? onSelect([]) : setSelecting(true))}
          >
            <SquareCheck /> Select
          </Button>
          <Button variant={allFields ? "secondary" : "ghost"} size="xs" onClick={() => setAllFields(!allFields)}>
            <ListFilter /> All fields
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setChoosing(true)}>
            <Columns3 /> Columns
          </Button>
        </span>
      </div>

      {allFields && (
        <div className="grid shrink-0 grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-x-6 gap-y-3 border-b bg-muted/20 px-3 py-2">
          {SORT_GROUPS.map((group) => (
            <div key={group}>
              <div className="mb-0.5 text-xs font-medium text-muted-foreground">{group}</div>
              {SORT_FIELDS.filter((field) => field.group === group).map((field) => (
                <div key={field.key} className="flex h-6 items-center justify-between gap-2">
                  <span className={cn("truncate", sorts.some((each) => each.key === field.key) && "text-primary")}>{field.label}</span>
                  {sortArrow(field.key)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: tableWidth }}>
          <div className="sticky top-0 z-10 border-b bg-background select-none">
            <div className="grid h-7 gap-x-4 bg-muted/40 px-3 text-xs font-medium" style={{ gridTemplateColumns: template }}>
              {/* Top left: picks every repo shown, or none when all are; a dash when only some are. */}
              <button
                type="button"
                className="flex items-center"
                aria-label={allPicked ? "Unselect all" : "Select all"}
                title={allPicked ? "Unselect all" : "Select all (Ctrl+A)"}
                disabled={rowNames.length === 0}
                onClick={() => (allPicked ? onSelect([]) : setSelected([...new Set([...chosen, ...rowNames])]))}
              >
                <SelectBox checked={allPicked} partial={chosen.length > 0} />
              </button>
              <span className="flex min-w-0 items-center">
                <button
                  type="button"
                  className={cn("flex min-w-0 items-center gap-0.5 hover:text-primary", sorts.some((each) => each.key === "name") && "text-primary")}
                  title={NAME_COLUMN.title}
                  onClick={() => clickSort("name")}
                >
                  <span className="truncate">{NAME_COLUMN.label}</span>
                  {sorts.find((each) => each.key === "name")?.dir === "down" && <ArrowDown className="size-3 shrink-0" />}
                  {sorts.find((each) => each.key === "name")?.dir === "up" && <ArrowUp className="size-3 shrink-0" />}
                </button>
              </span>
              {shownColumns.map((column) => (
                <span key={column.key} className="flex min-w-0 items-center">
                  {/* A click sorts by it, one step a click: best first, the other way round, off. */}
                  <button
                    type="button"
                    className={cn("flex min-w-0 items-center gap-0.5 hover:text-primary", sorts.some((each) => each.key === column.sort) && "text-primary")}
                    title={column.title}
                    onClick={() => clickSort(column.sort)}
                  >
                    <span className="truncate">{column.label}</span>
                    {sorts.find((each) => each.key === column.sort)?.dir === "down" && <ArrowDown className="size-3 shrink-0" />}
                  {sorts.find((each) => each.key === column.sort)?.dir === "up" && <ArrowUp className="size-3 shrink-0" />}
                  </button>
                </span>
              ))}
              <span className="flex min-w-0 items-center justify-end">
                <button
                  type="button"
                  className={cn("flex min-w-0 items-center gap-0.5 hover:text-primary", sorts.some((each) => each.key === "tracked") && "text-primary")}
                  title="Tracked first, then the other way round, then off"
                  onClick={() => clickSort("tracked")}
                >
                  <span className="truncate">Track</span>
                  {sorts.find((each) => each.key === "tracked")?.dir === "down" && <ArrowDown className="size-3 shrink-0" />}
                  {sorts.find((each) => each.key === "tracked")?.dir === "up" && <ArrowUp className="size-3 shrink-0" />}
                </button>
              </span>
            </div>
          </div>
          {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
          {loaded && repos.items.length === 0 && (
            <div className="px-3 py-2 text-muted-foreground">
              No repos yet. Run <a href="#/explore" className="text-primary hover:underline">Explore</a>, or agents add repos here while they search.
            </div>
          )}

          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const repo = rows[item.index];
              const isOpen = open.includes(repo.full_name);
              const signals = repo.signals;
              const newcomers = signals?.newcomers;
              const activity = signals?.activity;
              const community = signals?.community;
              const atmosphere = signals?.atmosphere ?? null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 w-full border-b"
                  style={{ top: item.start }}
                >
                  <div
                    data-select-id={repo.full_name}
                    className={cn("group cursor-pointer px-3 hover:bg-accent/50", isOpen && "bg-accent/40", chosen.includes(repo.full_name) && "bg-selected hover:bg-selected")}
                    onClick={(event) => {
                      // In select mode a click picks the row; otherwise Ctrl / Shift-click picks it and a plain click opens it.
                      if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) {
                        select(repo.full_name, event.shiftKey);
                      } else {
                        toggle(repo.full_name);
                      }
                    }}
                  >
                    <div className="grid gap-x-4" style={{ gridTemplateColumns: template }}>
                      {/* Out of select mode only on hover. Ticking it picks the repo, which turns select mode on. */}
                      <button
                        type="button"
                        className={cn("flex h-7 items-center", !selectMode && "invisible group-hover:visible")}
                        aria-label={`Select ${repo.full_name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          select(repo.full_name, event.shiftKey);
                        }}
                      >
                        <SelectBox checked={chosen.includes(repo.full_name)} />
                      </button>
                      <div className="flex h-7 min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">{repo.full_name}</span>
                          <a
                            href={repo.html_url}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-primary hover:text-foreground"
                            aria-label={`Open ${repo.full_name} on GitHub`}
                            title="Open on GitHub in a new tab"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                          {signals === null && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Fetching from GitHub" />}
                      </div>
                      {shownColumns.map((column) => (
                        <span key={column.key} className="block h-7 min-w-0 truncate leading-7 whitespace-nowrap tabular-nums">
                          {cell(column.key, repo)}
                        </span>
                      ))}
                      <span className="flex h-7 items-center justify-end">
                        <Button
                          variant={trackedNames.includes(repo.full_name.toLowerCase()) ? "ghost" : "outline"}
                          size="xs"
                          disabled={tracking.includes(repo.full_name)}
                          title={
                            trackedNames.includes(repo.full_name.toLowerCase())
                              ? "Stop tracking it on the Tracked page"
                              : "Track it: the Tracked page keeps an eye on its new issues"
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleTracked(repo.full_name);
                          }}
                        >
                          {tracking.includes(repo.full_name) ? (
                            <Loader2 className="animate-spin" />
                          ) : trackedNames.includes(repo.full_name.toLowerCase()) ? (
                            <EyeOff />
                          ) : (
                            <Eye />
                          )}
                          {trackedNames.includes(repo.full_name.toLowerCase()) ? "Untrack" : "Track"}
                        </Button>
                      </span>
                      {repo.note !== "" && (
                        <div className="min-w-0 truncate pb-1.5" style={{ gridColumn: "2 / -1" }} title={repo.note}>
                          {repo.note}
                        </div>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t bg-muted/30">
                      {signals !== null && (
                        <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-1 border-b px-9 py-3">
                          <span className="text-muted-foreground">Outside PRs</span>
                          <span>
                            {signals.outside_prs_90d} opened in {signals.pr_window_days ?? 90} days · {signals.outside_merged_90d} merged ·{" "}
                            {signals.outside_closed_90d} closed unmerged
                            {signals.outside_merge_rate !== null && (
                              <span className="text-muted-foreground"> · {Math.round(signals.outside_merge_rate * 100)}% merged</span>
                            )}
                          </span>

                          <span className="text-muted-foreground">Speed</span>
                          <span>
                            {signals.median_days_to_first_reply === null ? "No replies to go on" : `First reply in ${signals.median_days_to_first_reply} days`}
                            {signals.median_days_to_merge !== null && ` · merged in ${signals.median_days_to_merge} days`}
                            <span className="text-muted-foreground"> (medians)</span>
                          </span>

                          <span className="text-muted-foreground">Stale PRs</span>
                          <span className={signals.stale_outside_prs >= 5 ? "text-warn" : undefined}>
                            {signals.stale_outside_prs} open over 30 days that nobody answered
                          </span>

                          <span className="text-muted-foreground">Maintainers</span>
                          <span className={signals.active_mergers_30d <= 1 ? "text-warn" : undefined}>
                            {signals.active_mergers_30d} {signals.active_mergers_30d === 1 ? "person" : "people"} merged PRs this month
                          </span>

                          {newcomers !== undefined && (
                            <>
                              <span className="text-muted-foreground">Newcomers</span>
                              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <NewcomersTag tag={newcomers.tag} />
                                <span>
                                  {newcomers.prs} first PRs in {signals.pr_window_days ?? 90} days · {newcomers.merged} merged · {newcomers.closed} closed unmerged
                                  {newcomers.median_days_to_first_reply !== null && ` · first reply in ${newcomers.median_days_to_first_reply} days`}
                                  {newcomers.returned > 0 && ` · ${newcomers.returned} came back for a second PR`}
                                </span>
                              </span>
                            </>
                          )}

                          {activity !== undefined && (
                            <>
                              <span className="text-muted-foreground">Activity</span>
                              <span>
                                A month: {COUNT.format(activity.prs_opened_month)} PRs opened, {COUNT.format(activity.prs_merged_month)} merged ·{" "}
                                {COUNT.format(activity.issues_opened_month)} issues opened, {COUNT.format(activity.issues_closed_month)} closed ·{" "}
                                {COUNT.format(activity.commits_month)} commits
                                <span className="text-muted-foreground">
                                  {" "}
                                  (90-day average
                                  {activity.trend === "up" ? "; the last 30 days were busier" : activity.trend === "down" ? "; the last 30 days were quieter" : ""})
                                </span>
                                <span className="block text-muted-foreground">
                                  {activity.last_release_at !== null ? `Last release ${activity.last_release} ${timeAgo(activity.last_release_at)}` : "No GitHub releases"}
                                  {activity.issue_reply_rate !== null &&
                                    ` · ${Math.round(activity.issue_reply_rate * 100)}% of new issues answered by a maintainer within a week`}
                                </span>
                              </span>
                            </>
                          )}

                          {atmosphere !== null && (
                            <>
                              <span className="text-muted-foreground">Atmosphere</span>
                              <span className="flex min-w-0 flex-col gap-1">
                                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                  <ToneTag tone={atmosphere.tone} />
                                  <span>{atmosphere.summary}</span>
                                </span>
                                {atmosphere.asks_for.length > 0 && (
                                  <span className="text-muted-foreground">
                                    Reviewers ask for: {atmosphere.asks_for.map((ask) => ASK_LABEL[ask] ?? ask).join(", ")}
                                  </span>
                                )}
                                <span className="text-xs text-muted-foreground">
                                  From maintainers' feedback on {atmosphere.prs} recent PRs, read {timeAgo(atmosphere.judged_at)}
                                </span>
                              </span>
                            </>
                          )}

                          {community !== undefined && (
                            <>
                              <span className="text-muted-foreground">Community</span>
                              <span className={cn(!community.contributing && !community.code_of_conduct && !community.discussions && community.channels.length === 0 && "text-muted-foreground")}>
                                {[
                                  community.contributing ? "Contributing guide" : "",
                                  community.code_of_conduct ? "Code of conduct" : "",
                                  community.discussions ? "GitHub Discussions" : "",
                                  ...community.channels,
                                ]
                                  .filter((part) => part !== "")
                                  .join(" · ") || "No contributing guide, code of conduct or chat found"}
                              </span>
                            </>
                          )}

                          <span className="text-muted-foreground">AI policy</span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <PolicyTag tag={signals.ai_policy.tag} />
                            {signals.ai_policy.quote !== "" && (
                              <span className="min-w-0">
                                "{signals.ai_policy.quote}" <span className="text-muted-foreground">({signals.ai_policy.file})</span>
                              </span>
                            )}
                          </span>

                          {repo.fit !== undefined && (
                            <>
                              <span className="text-muted-foreground">Fit</span>
                              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <FitTag fit={repo.fit} />
                                <span>
                                  for your profile
                                  {repo.lane !== undefined && <span className="text-muted-foreground"> · found for {laneLabels[repo.lane] ?? repo.lane}</span>}
                                </span>
                              </span>
                            </>
                          )}

                          <span className="text-muted-foreground">Beginner issues</span>
                          <span>
                            {signals.unclaimed_beginner_issues} look unclaimed of {signals.beginner_issues.length} open
                            {signals.beginner_issues.length > 0 && (
                              <span className="mt-1 block space-y-0.5">
                                {signals.beginner_issues.slice(0, BEGINNER_SHOWN).map((issue) => {
                                  const taken = issue.assignees > 0 || issue.cross_references > 0;
                                  return (
                                    <a
                                      key={issue.number}
                                      href={`https://github.com/${repo.full_name}/issues/${issue.number}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="group flex min-w-0 items-center gap-2"
                                      title={issue.labels.join(", ")}
                                    >
                                      <span className="shrink-0 text-muted-foreground tabular-nums">#{issue.number}</span>
                                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <span className={cn("truncate group-hover:underline", taken && "text-muted-foreground")}>{issue.title}</span>
                                        {taken && <Badge variant="warn">maybe taken</Badge>}
                                      </span>
                                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(issue.created_at)}</span>
                                    </a>
                                  );
                                })}
                              </span>
                            )}
                          </span>

                          <span className="col-span-2 flex items-center gap-3 text-xs text-muted-foreground">
                            From GitHub {timeAgo(signals.fetched_at)}
                            <a href={repo.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">
                              GitHub <ExternalLink className="size-3" />
                            </a>
                          </span>
                        </div>
                      )}
                      <RepoTree repo={repo} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* Hidden: every row's cells at their own width in max-content columns, so useColumnWidths can read how wide each
          column has to be for its widest cell. The header labels count too. */}
      <div
        ref={sizerRef}
        aria-hidden
        className="invisible absolute top-0 left-0 -z-10 grid h-0 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${shownColumns.length}, max-content)` }}
      >
        {/* With the arrow a sorted header shows, so it always fits. */}
        {shownColumns.map((column) => (
          <span key={column.key} className="flex items-center gap-0.5 text-xs font-medium">
            {column.label} <ArrowDown className="size-3" />
          </span>
        ))}
        {rows.map((repo) => (
          <Fragment key={repo.full_name}>
            {shownColumns.map((column) => (
              <span key={column.key} className="whitespace-nowrap tabular-nums">
                {cell(column.key, repo)}
              </span>
            ))}
          </Fragment>
        ))}
      </div>

      {/* Only the count and Select all: Track and Delete are in the bar on top. */}
      <RowSelection listRef={scrollRef} ids={rowNames} selected={chosen} onSelect={onSelect} />

      <ColumnsDialog
        open={choosing}
        onOpenChange={setChoosing}
        columns={TABLE_COLUMNS}
        groups={SORT_GROUPS}
        shown={shown}
        defaults={DEFAULT_COLUMNS}
        fixed="Name"
        onChange={(next) => setShown(next as ColumnKey[])}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {chosen.length} {chosen.length === 1 ? "repo" : "repos"}?
            </AlertDialogTitle>
            <AlertDialogDescription>They leave the list; Explore may find them again. Undo brings them back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove(chosen)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
