/*
The Tracked list: repos the user wants to keep an eye on for new issues. The user tracks them from the Repos page (its
Track column); agents can add and remove them too (their tracked_* tools), and undo / redo (Ctrl+Z / Ctrl+Y) works on
both, like Repos. The bar on top has Refresh all (Check now for every repo, then Claude reads every issue tagged Free
again and the page says which ones aren't free anymore: claimed in the comments, a PR came, ...; minutes for many),
Add to Issues and Mark all as read (every issue new now isn't anymore; only ones found later are new). Add to Issues
puts every free issue of the tracked repos into the Issues list (its repo into Repos too), each time it is pressed:
no assignee, tagged Free, not Out of scope, in a repo whose AI policy isn't No AI. Each issue only once: one removed
from the Issues list stays out, and a later press adds the ones found since (backend/tracked_api.py).

The backend checks each repo's open issues every few minutes (github_searcher/tracked_issues.py): the newest
ones and every good first or help wanted one. An issue is new for three days after it was opened, assigned or not,
unless Mark all as read saw it; the sidebar shows how many are new. Check now asks GitHub at once.

Each issue row shows Marked (next to Free), the same as on the Issues page, without opening the issue: what the
maintainers marked it with on GitHub, from its labels (only maintainers can label an issue), however the repo spells
them: Good first issue (green: good first issue, first-timers, beginner, starter, newcomer), Help wanted (green: help
wanted, contributions or PRs welcome, up for grabs, accepting PRs) and Confirmed (accepted, confirmed, approved,
triaged); "–" when none, and hovering shows all its labels. Sorted, good first issue counts most, then help wanted,
then confirmed, and one marked more ways goes higher.
GitHub's labels aren't shown otherwise: each issue carries the app's own tags instead, the same as on the Issues page
(github_searcher/issue_tags.py, made by Claude in the background): Free or Assigned, Easy / Medium / Hard (how hard
the fix is for our agent in its VM, by fixed rules, the same as on the Issues page; kept until the issue changes) or
Out of scope (grey: we don't take it, as our agent can't do it yet, like a plugin the project wants as its own
repository, or it touches politics: activist or politically sensitive, or against another country's laws), its Lines
(a rough guess of how many lines the fix adds and removes, tests included, shown as ~40) and its kind, each in its own column, the reason on hover. Assigned on GitHub counts as Assigned at once, without waiting
for the tags. Tag again (on the repo's row and in its pop-up) has Claude read all its unassigned issues again now.

The list is a table like the Explore page's: Name, then the repo's fields in two lines, so a row isn't too long, and
its description under them, from the name on. The header has two lines of names to match: each column holds a
first-line field over a second-line one. The first line (FIRST_LINE) is how outside contributors fare, from the repo's
signals (the same as the Repos page's columns): AI policy, newcomers and reply speed; hover a tag for what it means.
The second (SECOND_LINE): stars and its issues' numbers (Free, Easy). Every column is as wide as its widest cell (one
CSS grid, each row a subgrid) and all of them sit on the left, the room left over going before the row's buttons. The
text is in the page's own color (green for free issues; the tags' own colors). A click on a field's name in the
header adds it to the sort, the best first (the most, the fastest reply, the friendliest tag; A to Z for the name); again the other way round; again takes it out. Many fields sort at once, like on the Explore page:
in the order they come, the first line from left to right, then the second (say AI policy, then Free); Name last of
all, and the list's order among what is still the same. With none, it is the list's order. Every sorted name is blue
with an arrow.

A click on a row opens its issues in a pop-up, one repo at a time; the X, Esc or a click outside it closes it, back to
the list. Its top has the repo's name, its description, when it was last checked and the row's buttons with their
names: Check now, Tag again and Stop tracking (the pop-up closes when the repo stops being tracked, here or elsewhere).
Below, its issues, newest first, with tabs Free (a newcomer can start on it now) / Assigned (someone is on it) / All
(Free when there are free ones). The issues are a table too, sorted the same way by clicks on its columns' headers (one
order for every repo; from left to right like the list, # and Title last, newest first among what is still the same):
ISSUE_HEADERS (Checked: when Claude last read it and its comments and updated its tags). A click on an issue opens it
in full in a second pop-up on top, its comments below (IssueDetailsDialog); closing that one goes back to the repo's.
Its # and the arrow button at the row's end open it on GitHub in a new tab. An issue goes into the Issues list with one
click (its repo into Repos too), or links there when it is in already. The list is short (repos the user picked), so
every row is drawn; times re-render every minute.
Many rows are picked like on the Repos page. Hovering a row shows its box on the left; ticking it picks that repo and
turns on select mode, like Select (top right) does: Select stays lit (a click on it ends select mode), every row shows
its box, and a click picks the row instead of opening it. The box at the top left of the table's header picks every row
(checked when all are, a dash when some are); a click when all are picked unpicks them. Rows are also picked like in a mail app (components/ui/row-selection.tsx):
Ctrl-click, Shift-click, dragging a rectangle, Ctrl+A, which turns on select mode too. A bar at the bottom then stops
tracking them at once, as one undo step (it asks first; Enter confirms), or Tag opens the Tag pop-up (TagDialog.tsx,
the same as on the Repos page, with the same tags) and ends select mode. Clearing the selection (Escape, the
bar's x) ends select mode too. Deleting a repo on the Repos page stops tracking it too.

Tags group repos for the user, nothing more. A repo has the same tag here as on the Repos page (the Issues page groups
by it too): the Repos list's when the repo is in it, else the one it was given here; Tag sets it in both lists, and its
pop-up offers every tag the Repos page has. Every group has a header (its name and how many) over its repos in the
list's sort: the tags on top, A to Z, and No tag (the repos without one) at the bottom. A click on a header folds its
repos away or opens them again, remembered in this browser. Shift-click and Select all skip a folded tag's repos.
*/

import { ArrowDown, ArrowUp, CheckCheck, ChevronRight, ExternalLink, Loader2, MessageSquare, Plus, RefreshCw, SquareCheck, Star, Tag, Tags, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import IssueDetailsDialog from "@/IssueDetailsDialog";
import TagDialog from "@/TagDialog";
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
import { NewcomersTag, PolicyTag } from "@/components/ui/repo-tags";
import { RowSelection, SelectBox } from "@/components/ui/row-selection";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type RepoItem, type TrackedIssue, type TrackedRepo } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// The columns after Name, each sorted by a click on its header: the best first (the most, the latest; the least for
// lower: the fastest reply). First the repo's tags, from its signals (the same as the Repos page's columns).
type TrackedKey = "name" | "ai_policy" | "newcomers" | "reply" | "stars" | "free" | "easy";
type TrackedColumn = { key: TrackedKey; label: string; title: string; better?: "lower" };
// Each row has two lines, so it isn't too long. The first: how outside contributors fare.
const FIRST_LINE: TrackedColumn[] = [
  { key: "ai_policy", label: "AI policy", title: "What its contribution files say about AI: the most open first" },
  { key: "newcomers", label: "Newcomers", title: "How newcomers' first PRs fare: the most welcoming first" },
  { key: "reply", label: "Reply", title: "Median days until outside contributors' PRs get a first reply from a maintainer (bots and other outsiders don't count): the fastest first", better: "lower" },
];
// The second, under the first: stars and its issues' numbers.
const SECOND_LINE: TrackedColumn[] = [
  { key: "stars", label: "Stars", title: "Stars on GitHub" },
  { key: "free", label: "Free", title: "Open issues a newcomer can start on now: nobody is on it and the maintainers want it done" },
  { key: "easy", label: "Easy", title: "Free issues that are easy: our agent can write the fix, see it and prove it in its VM" },
];
// Every column in sort order (the first line from left to right, then the second), and the table's columns after
// Name: each holds a first-line field over a second-line one.
const TRACKED_COLUMNS = [...FIRST_LINE, ...SECOND_LINE];
const SLOTS = Array.from({ length: Math.max(FIRST_LINE.length, SECOND_LINE.length) }, (_, index) => index);
// The tags' order for sorting, the friendliest highest (the same as the Repos page's).
const POLICY_RANK: Record<string, number> = { welcome: 5, none: 4, disclose: 3, unclear: 2, no_ai: 1 };
const NEWCOMER_RANK: Record<string, number> = { welcomes: 5, ok: 4, few: 3, left_waiting: 2, turned_away: 1 };
// The pop-up's issues: #, Title (the room left over), the tags (Free, Marked, Level, Lines, Kind), Opened, Updated, Checked
// (Claude last read it), comments, then GitHub and Add.
const ISSUE_COLUMNS = "grid grid-cols-[56px_minmax(0,1fr)_72px_160px_64px_48px_72px_150px_80px_80px_36px_120px] items-center gap-2";
type IssueKey = "number" | "title" | "free" | "marked" | "level" | "lines" | "kind" | "opened" | "updated" | "read" | "comments";
const ISSUE_HEADERS: { key: IssueKey; label: string; title: string }[] = [
  { key: "number", label: "#", title: "Its number on GitHub, newest first" },
  { key: "title", label: "Title", title: "A to Z" },
  { key: "free", label: "Free", title: "Free first (a newcomer can start now), then not ready yet, then assigned" },
  { key: "marked", label: "Marked", title: "What the maintainers marked it with on GitHub: good first issue, help wanted (they want an outside PR) or confirmed; the most marked first. Hover for all its labels" },
  { key: "level", label: "Level", title: "How hard the fix is for our agent in its VM, by fixed rules: easy (it can write it, see it and prove it there), medium or hard; out of scope when we don't take it (our agent can't do it yet, or it touches politics); the hardest first" },
  { key: "lines", label: "Lines", title: "A rough guess of how many lines the fix adds and removes, tests included; the most first" },
  { key: "kind", label: "Kind", title: "Bug, docs, feature or question: A to Z" },
  { key: "opened", label: "Opened", title: "When it was opened on GitHub, newest first" },
  { key: "updated", label: "Updated", title: "Its last change on GitHub: a comment, a label, an edit…; the latest first" },
  { key: "read", label: "Checked", title: "When Claude last read it and its comments and updated its tags (Free, Level, Lines, Kind); the latest first" },
  { key: "comments", label: "", title: "Comments, the most first" },
];
// The tags' order for sorting and their colors (the same as on the Issues page): levels like LeetCode's green / amber / red.
const FREE_RANK: Record<string, number> = { free: 3, waiting: 2, assigned: 1 };
const LEVEL_RANK: Record<string, number> = { easy: 1, medium: 2, hard: 3, "out of scope": 4 };
const LEVEL_COLOR: Record<string, string> = { easy: "text-ok", medium: "text-warn", hard: "text-destructive", "out of scope": "text-muted-foreground" };
const LEVEL_LABEL: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard", "out of scope": "Out of scope" };
// GitHub labels only maintainers can put on an issue, by what they say, for the Marked column (the same as on the Issues
// page). Confirmed has word edges so "unconfirmed" and "untriaged" don't count.
const GOOD_FIRST = /good.?first|first.?timer|beginner|starter|newcomer/i;
const HELP_WANTED = /help.?wanted|contributions?.?welcome|prs?.?welcome|pull.?requests?.?welcome|up.?for.?grabs|accepting.?prs/i;
const CONFIRMED = /\b(accepted|confirmed|approved|triaged)\b/i;

type IssueTab = "free" | "assigned" | "all";

const FOLDED_STORAGE = "tracked-folded-tags";

// The tags this browser folded last ("" for No tag). Storage can be blocked: then every tag starts open.
let savedFolded: string[] = [];
try {
  const saved = JSON.parse(localStorage.getItem(FOLDED_STORAGE) ?? "[]");
  if (Array.isArray(saved)) {
    savedFolded = saved.filter((each: unknown) => typeof each === "string");
  }
} catch {
  savedFolded = [];
}

export default function Tracked() {
  const tracked = useLive("tracked");
  const issues = useLive("issues");
  const repos = useLive("repos");
  const loaded = useLoaded("tracked");
  // The repo whose issues are open in the pop-up, by name, or none.
  const [openName, setOpenName] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Record<string, IssueTab>>({});
  const [checking, setChecking] = useState<string[]>([]);
  const [retagging, setRetagging] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [addingFree, setAddingFree] = useState(false);
  // The issue open in the pop-up, by repo and number, so it shows the live one (new tags arrive while it is open).
  const [details, setDetails] = useState<{ repo: string; number: number } | null>(null);
  // The pop-up's issues' order, the same for every repo: newest first (none), or by these columns, like the list's.
  const [issueSorts, setIssueSorts] = useState<{ key: IssueKey; best: boolean }[]>([]);
  // The list's order: as tracked (none), or by these fields, in TRACKED_COLUMNS' order, Name last;
  // best is the way a column's first click sorts, or not.
  const [sorts, setSorts] = useState<{ key: TrackedKey; best: boolean }[]>([]);
  // Selected repos, the last one clicked (where a shift-click range starts), and whether removing them waits for a confirm.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  // Select mode: every row shows a box and a click picks it. Picking a row any other way shows the boxes too.
  const [selecting, setSelecting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Whether the Tag pop-up (TagDialog) is open, and the tags whose repos are folded away under their header.
  const [tagging, setTagging] = useState(false);
  const [folded, setFolded] = useState<string[]>(savedFolded);
  const [, setTick] = useState(0);

  // "3h ago" goes stale on its own: draw again every minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_STORAGE, JSON.stringify(folded));
    } catch {
      // Storage blocked: the folded tags just aren't kept.
    }
  }, [folded]);

  const inIssues = new Set(issues.items.map((issue) => issue.id));
  // An issue is new for three days after it was opened, assigned or not, unless Mark all as read saw it. How many of
  // all are.
  const newSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let newTotal = 0;
  for (const repo of tracked.items) {
    const check = repo.check;
    const read = check !== null ? (check.read ?? []) : [];
    if (check !== null) {
      newTotal += check.issues.filter((issue) => new Date(issue.created_at).getTime() > newSince && !read.includes(issue.number)).length;
    }
  }

  async function remove(names: string[]) {
    try {
      await api("/api/tracked/remove", { method: "POST", body: { names } });
      setSelected((current) => current.filter((name) => !names.includes(name)));
      setSelecting(false);
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
    if (check === null) {
      return null;
    }
    if (key === "free") {
      return check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free").length;
    }
    return check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free" && issue.tags.level === "easy").length;
  }

  const rows = [...tracked.items];
  if (sorts.length > 0) {
    rows.sort((a, b) => {
      // Like the Explore page: the first sorted field (in TRACKED_COLUMNS' order) that tells them apart decides, Name last; when none does, the
      // list's order stays (a stable sort).
      for (const key of [...TRACKED_COLUMNS.map((column) => column.key), "name" as TrackedKey]) {
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
    if (key === "marked") {
      // Good first issue counts most, then help wanted, then confirmed; an issue marked more than one way adds them up.
      let rank = 0;
      if (issue.labels.some((label) => GOOD_FIRST.test(label))) {
        rank += 4;
      }
      if (issue.labels.some((label) => HELP_WANTED.test(label))) {
        rank += 2;
      }
      if (issue.labels.some((label) => CONFIRMED.test(label))) {
        rank += 1;
      }
      return rank;
    }
    if (key === "level") {
      return tags !== null && tags.level !== null ? LEVEL_RANK[tags.level] : null;
    }
    if (key === "lines") {
      return tags !== null ? (tags.lines ?? null) : null;
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
    if (key === "read") {
      return tags !== null ? new Date(tags.judged_at).getTime() : null;
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

  // Each tracked repo's tag, the same as on the Repos and Issues pages: the Repos list's when the repo is in it (names
  // compared without case), else its own ("" when it has none).
  const repoTags: Record<string, string> = {};
  for (const repo of repos.items) {
    repoTags[repo.full_name.toLowerCase()] = repo.tag ?? "";
  }
  const tagOf: Record<string, string> = {};
  for (const repo of tracked.items) {
    tagOf[repo.full_name] = repoTags[repo.full_name.toLowerCase()] ?? repo.tag ?? "";
  }

  // The tags in use, A to Z.
  const tagNames: string[] = [];
  for (const repo of tracked.items) {
    if (tagOf[repo.full_name] !== "" && !tagNames.includes(tagOf[repo.full_name])) {
      tagNames.push(tagOf[repo.full_name]);
    }
  }
  tagNames.sort((a, b) => a.localeCompare(b));

  // The Tag pop-up's list: every tracked repo with its tag, then the Repos list's other repos, so it offers the same
  // tags as the Repos page and deleting one takes it off those too.
  const tagItems: RepoItem[] = tracked.items.map((repo) => ({ ...repo, tag: tagOf[repo.full_name] }));
  const trackedLower = tracked.items.map((repo) => repo.full_name.toLowerCase());
  for (const repo of repos.items) {
    if (!trackedLower.includes(repo.full_name.toLowerCase())) {
      tagItems.push(repo);
    }
  }

  // What the list draws: each tag's header (repo null) over its repos unless folded, the tags A to Z, then the repos
  // without a tag (tag "") last, under a No tag header.
  const lines: { tag: string; repo: TrackedRepo | null }[] = [];
  for (const tag of [...tagNames, ""]) {
    const tagRepos = rows.filter((repo) => tagOf[repo.full_name] === tag);
    if (tagRepos.length === 0) {
      continue;
    }
    lines.push({ tag, repo: null });
    const shownRepos = folded.includes(tag) ? [] : tagRepos;
    for (const repo of shownRepos) {
      lines.push({ tag, repo });
    }
  }

  // Only repos still tracked count as selected (an undo, an agent or another tab may have taken some out).
  const names = rows.map((repo) => repo.full_name);
  const chosen = selected.filter((name) => names.includes(name));
  // The rows drawn: a folded tag's repos can't be clicked, so Shift-click and Select all skip them.
  const shownNames: string[] = [];
  for (const line of lines) {
    if (line.repo !== null) {
      shownNames.push(line.repo.full_name);
    }
  }

  // A ctrl-click picks or unpicks one row; a shift-click does the same to every row from the last one clicked.
  function select(name: string, shift: boolean) {
    const on = !chosen.includes(name);
    let range = [name];
    if (shift && anchor !== null && shownNames.includes(anchor)) {
      const from = shownNames.indexOf(anchor);
      const to = shownNames.indexOf(name);
      range = shownNames.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !range.includes(each)), ...range] : chosen.filter((each) => !range.includes(each)));
    setAnchor(name);
  }

  // Clearing the selection (Escape, the bar's x, a click on the list's empty space) also ends select mode.
  function onSelect(next: string[]) {
    setSelected(next);
    if (next.length === 0) {
      setSelecting(false);
    }
  }
  const selectMode = selecting || chosen.length > 0;
  const allPicked = shownNames.length > 0 && shownNames.every((name) => chosen.includes(name));

  async function checkNow(full_name: string) {
    setChecking((current) => [...current, full_name]);
    try {
      await api("/api/tracked/check", { method: "POST", body: { name: full_name } });
    } catch (err) {
      toast.error(`Could not check ${full_name}: ${err instanceof Error ? err.message : err}`);
    }
    setChecking((current) => current.filter((n) => n !== full_name));
  }

  // Refresh all: Check now for every tracked repo, all at once (each row's own button spins meanwhile), then Claude reads
  // every issue tagged Free again (each row's Tag again spins meanwhile), so one taken since stops showing as Free.
  async function checkAll() {
    const free: string[] = [];
    for (const repo of tracked.items) {
      if (repo.check === null) {
        continue;
      }
      for (const issue of repo.check.issues) {
        if (issue.assignees === 0 && issue.tags?.status === "free") {
          free.push(`${repo.full_name}#${issue.number}`);
        }
      }
    }
    const freeRepos = names.filter((name) => free.some((id) => id.startsWith(`${name}#`)));
    setRefreshing(true);
    await Promise.all(names.map((name) => checkNow(name)));
    if (free.length > 0) {
      setRetagging((current) => [...current, ...freeRepos]);
      try {
        const result = await api<{ tagged: number; failed: string[]; taken: string[] }>("/api/tags/refresh", { method: "POST", body: { ids: free } });
        if (result.failed.length > 0) {
          toast.error(`Could not read ${result.failed.length} of them again; the backend tries again later.`);
        }
        // The rows show it too: Free turns to Assigned or –, the reason on hover.
        if (result.taken.length > 0) {
          toast.warning(`No longer free: ${result.taken.join(", ")}`);
        } else {
          toast.success(`Read ${result.tagged} free issues again; all still free.`);
        }
      } catch (err) {
        toast.error(`Could not read the free issues again: ${err instanceof Error ? err.message : err}`);
      }
      setRetagging((current) => current.filter((name) => !freeRepos.includes(name)));
    }
    setRefreshing(false);
  }

  // Add to Issues: every free issue of the tracked repos goes into the Issues list, each one once.
  async function addFree() {
    setAddingFree(true);
    try {
      const result = await api<{ added: string[] }>("/api/tracked/add_free", { method: "POST" });
      if (result.added.length === 0) {
        toast.success("No new free issues to add.");
      } else {
        toast.success(`Added ${result.added.length} free issue${result.added.length === 1 ? "" : "s"} to Issues.`);
      }
    } catch (err) {
      toast.error(`Could not add the free issues: ${err instanceof Error ? err.message : err}`);
    }
    setAddingFree(false);
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

  // The pop-up closes when its repo stops being tracked (here, by an undo, an agent or another tab), and stays closed
  // when it comes back.
  useEffect(() => {
    if (openName !== null && !tracked.items.some((repo) => repo.full_name === openName)) {
      setOpenName(null);
    }
  }, [openName, tracked.items]);

  // The repo open in the pop-up and its issues as the pop-up shows them: the tab picked (Free when it has free ones,
  // else All), sorted by the issue columns clicked.
  const openRepo = tracked.items.find((repo) => repo.full_name === openName);
  const openCheck = openRepo !== undefined ? openRepo.check : null;
  const openFree = openCheck !== null ? openCheck.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free").length : 0;
  const openAssigned = openCheck !== null ? openCheck.issues.filter((issue) => issue.assignees > 0 || issue.tags?.status === "assigned").length : 0;
  let tab: IssueTab = openFree > 0 ? "free" : "all";
  if (openName !== null && tabs[openName] !== undefined) {
    tab = tabs[openName];
  }
  const shown =
    openCheck === null
      ? []
      : openCheck.issues.filter((issue) => {
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
      // Like the list: the leftmost sorted column that tells them apart decides, # and Title last; when none does, they
      // stay newest first (a stable sort).
      const keys = ISSUE_HEADERS.map((column) => column.key).filter((key) => key !== "number" && key !== "title");
      for (const key of [...keys, "number" as IssueKey, "title" as IssueKey]) {
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
      {/* The same bar as on the other pages: Refresh all, Add to Issues and Mark all as read on the left. */}
      <div className="flex h-9 shrink-0 items-center border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1 max-md:gap-y-1">
        {names.length > 0 && (
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={refreshing || checking.length > 0}
              title="Check every tracked repo on GitHub now, then have Claude read every Free issue again: one taken since stops showing as Free"
              onClick={() => checkAll()}
            >
              <RefreshCw className={cn((refreshing || checking.length > 0) && "animate-spin")} /> Refresh all
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={addingFree}
              title="Put every free issue of these repos into the Issues list: no assignee, tagged Free, not Out of scope, not from a repo that says no AI. Each one once: one you removed from Issues stays out"
              onClick={() => addFree()}
            >
              {addingFree ? <Loader2 className="animate-spin" /> : <Plus />} Add to Issues
            </Button>
            <Button variant="ghost" size="xs" disabled={newTotal === 0} title="The issues new now aren't new anymore; only ones found later are" onClick={() => markAllRead()}>
              <CheckCheck /> Mark all as read
            </Button>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant={selectMode ? "secondary" : "ghost"} size="xs"
            disabled={!selectMode && names.length === 0}
            title={selectMode ? "Stop selecting (Esc)" : "Pick rows: every row shows its box, and a click picks it"}
            onClick={() => (selectMode ? onSelect([]) : setSelecting(true))}
          >
            <SquareCheck /> Select
          </Button>
        </span>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && tracked.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">Nothing tracked yet. Track a repo from the Repos page to keep an eye on its new issues.</div>
        )}

        {/* One grid for the whole table, its columns as wide as their widest cell; the header and each row are subgrids
            of it, so they line up. w-max lets it grow past the page (it scrolls sideways); min-w-full fills the page
            otherwise, the room left over going before the buttons. The description spans the row without widening it. */}
        {rows.length > 0 && (
          <div
            className="grid w-max min-w-full gap-x-4 border-b"
            style={{ gridTemplateColumns: `16px minmax(160px,max-content) repeat(${SLOTS.length}, max-content) minmax(0,1fr) max-content` }}
          >
            <div className="col-span-full grid grid-cols-subgrid items-center bg-muted/40 px-3 py-0.5 text-xs font-medium">
              {/* Top left: picks every repo shown, or none when all are; a dash when only some are. */}
              <button
                type="button"
                className="flex h-5 items-center self-start"
                aria-label={allPicked ? "Unselect all" : "Select all"}
                title={allPicked ? "Unselect all" : "Select all (Ctrl+A)"}
                disabled={shownNames.length === 0}
                onClick={() => (allPicked ? onSelect([]) : setSelected([...new Set([...chosen, ...shownNames])]))}
              >
                <SelectBox checked={allPicked} partial={chosen.length > 0} />
              </button>
              <button
                type="button"
                className={cn("flex h-5 items-center gap-0.5 self-start hover:text-primary", sorts.some((each) => each.key === "name") && "text-primary")}
                title="A to Z"
                onClick={() => clickSort("name")}
              >
                Name
                {sorts.find((each) => each.key === "name")?.best === true && <ArrowDown className="size-3" />}
                {sorts.find((each) => each.key === "name")?.best === false && <ArrowUp className="size-3" />}
              </button>
              {/* Two lines, like the rows: each column's first-line field over its second-line one. */}
              {SLOTS.map((index) => (
                <span key={index} className="flex flex-col">
                  {[FIRST_LINE[index], SECOND_LINE[index]].map((column, line) => {
                    if (column === undefined) {
                      return <span key={line} className="h-5" />;
                    }
                    const sort = sorts.find((each) => each.key === column.key);
                    return (
                      <button
                        key={column.key}
                        type="button"
                        className={cn("flex h-5 items-center gap-0.5 hover:text-primary", sort !== undefined && "text-primary")}
                        title={column.title}
                        onClick={() => clickSort(column.key)}
                      >
                        {column.label}
                        {sort !== undefined && (sort.best ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                      </button>
                    );
                  })}
                </span>
              ))}
              <span />
              <span />
            </div>
            {lines.map((line) => {
              // A tag's header: a click folds its repos away or opens them again.
              if (line.repo === null) {
                const open = !folded.includes(line.tag);
                return (
                  <button
                    key={`#${line.tag}`}
                    type="button"
                    className="col-span-full flex h-7 items-center gap-1 border-t bg-muted/40 px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                    aria-expanded={open}
                    onClick={() => setFolded(open ? [...folded, line.tag] : folded.filter((each) => each !== line.tag))}
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                    {line.tag === "" ? "No tag" : line.tag}
                    <span className="ml-0.5 tabular-nums">{rows.filter((repo) => tagOf[repo.full_name] === line.tag).length}</span>
                  </button>
                );
              }
              const repo = line.repo;
              const check = repo.check;
              const signals = repo.signals;
              const free = check !== null ? check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free").length : 0;
              const easy = check !== null ? check.issues.filter((issue) => issue.assignees === 0 && issue.tags?.status === "free" && issue.tags.level === "easy").length : 0;
              return (
                <div
                  key={repo.full_name}
                  data-select-id={repo.full_name}
                  className={cn(
                    "group col-span-full grid cursor-pointer grid-cols-subgrid border-t px-3 py-2 hover:bg-accent/50",
                    openName === repo.full_name && "bg-accent/40",
                    chosen.includes(repo.full_name) && "bg-selected hover:bg-selected",
                  )}
                  onClick={(event) => {
                    // In select mode a click picks the row; otherwise Ctrl / Shift-click picks it and a plain click opens its pop-up.
                    if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) {
                      select(repo.full_name, event.shiftKey);
                    } else {
                      setOpenName(repo.full_name);
                    }
                  }}
                >
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
                  <span className="flex h-7 min-w-0 items-center">
                    <span className="truncate font-medium">{repo.full_name}</span>
                  </span>
                  {/* The first line: the repo's tags, from its signals; – until they are fetched (seconds after it is
                      tracked). Then an empty column, the room left over and the buttons. */}
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
                  {/* The second line, under the first one's columns: nothing under the box and the name. */}
                  <span />
                  <span />
                  <span className="flex h-6 items-center gap-1 tabular-nums">
                    <Star className="size-3.5" />
                    {COMPACT.format(check !== null && check.stars !== null ? check.stars : repo.stars)}
                  </span>
                  <span className={cn("flex h-6 items-center tabular-nums", free > 0 && "text-ok")}>{check !== null ? free : "–"}</span>
                  <span className={cn("flex h-6 items-center tabular-nums", easy > 0 && "text-ok")}>{check !== null ? easy : "–"}</span>
                  <span />
                  <span />
                  {(repo.note !== "" || repo.description !== "") && (
                    <div className="w-0 min-w-full truncate pt-0.5" style={{ gridColumn: "2 / -1" }} title={repo.note || repo.description}>
                      {repo.note || repo.description}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <RowSelection listRef={listRef} ids={shownNames} selected={chosen} onSelect={onSelect}>
        <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)}>
          <X /> Stop tracking
        </Button>
        <Button size="xs" variant="ghost" title="Put the picked repos under a tag" onClick={() => setTagging(true)}>
          <Tag /> Tag
        </Button>
      </RowSelection>

      {tagging && (
        <TagDialog
          items={tagItems}
          names={chosen}
          url="/api/tracked/tag"
          onClose={() => setTagging(false)}
          onTagged={(tag) => {
            // Its header opens, so they show.
            setTagging(false);
            setFolded((current) => current.filter((each) => each !== tag));
            onSelect([]);
          }}
          onDeleted={(tag) => setFolded((current) => current.filter((each) => each !== tag))}
        />
      )}

      {/* The open repo's issues. Its top stays put: the name, the row's buttons with their names, the description and
          the last check, then the tabs. Only the issues scroll, sideways too when the pop-up is narrower than them. */}
      <Dialog
        open={openRepo !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setOpenName(null);
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-7xl">
          {openRepo !== undefined && (
            <>
              <div className="shrink-0 space-y-2 border-b pt-3 pr-10 pb-2 pl-4">
                <div className="flex items-center gap-3 max-md:flex-wrap max-md:gap-y-1">
                  <DialogTitle className="min-w-0 truncate leading-normal">{openRepo.full_name}</DialogTitle>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      title="Check on GitHub now"
                      disabled={checking.includes(openRepo.full_name)}
                      onClick={() => checkNow(openRepo.full_name)}
                    >
                      <RefreshCw className={cn(checking.includes(openRepo.full_name) && "animate-spin")} /> Check now
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      title="Tag again: Claude reads its unassigned issues and their comments again now"
                      disabled={openCheck === null || retagging.includes(openRepo.full_name)}
                      onClick={() => tagAgain(openRepo)}
                    >
                      {retagging.includes(openRepo.full_name) ? <Loader2 className="animate-spin" /> : <Tags />} Tag again
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => remove([openRepo.full_name])}>
                      <X /> Stop tracking
                    </Button>
                  </span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  {(openRepo.note !== "" || openRepo.description !== "") && (
                    <span className="min-w-0 truncate" title={openRepo.note || openRepo.description}>
                      {openRepo.note || openRepo.description}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                    {openCheck === null && (
                      <>
                        <Loader2 className="size-3.5 animate-spin" /> checking
                      </>
                    )}
                    {openCheck !== null && openCheck.error !== null && (
                      <span className="text-destructive" title={openCheck.error}>
                        Check failed
                      </span>
                    )}
                    {openCheck !== null && openCheck.error === null && <span title={new Date(openCheck.checked_at).toLocaleString()}>Checked {timeAgo(openCheck.checked_at)}</span>}
                  </span>
                </div>
                {openCheck !== null && (
                  <Tabs value={tab} onValueChange={(value) => setTabs({ ...tabs, [openRepo.full_name]: value as IssueTab })}>
                    <TabsList>
                      <TabsTrigger value="free" className="px-2.5">
                        Free <span className="text-xs text-muted-foreground tabular-nums">{openFree}</span>
                      </TabsTrigger>
                      <TabsTrigger value="assigned" className="px-2.5">
                        Assigned <span className="text-xs text-muted-foreground tabular-nums">{openAssigned}</span>
                      </TabsTrigger>
                      <TabsTrigger value="all" className="px-2.5">
                        All <span className="text-xs text-muted-foreground tabular-nums">{openCheck.issues.length}</span>
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-4 pb-2">
                {openCheck === null && (
                  <div className="flex items-center gap-2 py-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Getting its issues from GitHub…
                  </div>
                )}
                {openCheck !== null && openCheck.error !== null && <div className="py-2 text-destructive">The last check failed: {openCheck.error}</div>}
                {openCheck !== null && shown.length === 0 && (
                  <div className="py-2 text-muted-foreground">
                    {tab === "free" && "No issue a newcomer can start on now."}
                    {tab === "assigned" && "Nobody is assigned to any of its open issues."}
                    {tab === "all" && "No open issues."}
                  </div>
                )}
                {/* min-w-min: never narrower than the columns, so a narrow pop-up scrolls sideways instead of
                    squeezing them; the headers stay on top while the issues scroll. */}
                {openCheck !== null && shown.length > 0 && (
                  <div className="min-w-min">
                    <div className={cn(ISSUE_COLUMNS, "sticky top-0 h-7 bg-popover text-xs font-medium text-muted-foreground")}>
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
                    {shown.map((issue) => {
                      const id = `${openRepo.full_name}#${issue.number}`;
                      const isNew = new Date(issue.created_at).getTime() > newSince && !(openCheck.read ?? []).includes(issue.number);
                      const tags = issue.tags ?? null;
                      const isAssigned = issue.assignees > 0 || tags?.status === "assigned";
                      const goodFirst = issue.labels.some((label) => GOOD_FIRST.test(label));
                      const helpWanted = issue.labels.some((label) => HELP_WANTED.test(label));
                      const confirmed = issue.labels.some((label) => CONFIRMED.test(label));
                      return (
                        <div
                          key={issue.number}
                          className={cn(ISSUE_COLUMNS, "min-h-7 cursor-pointer border-t border-border/50 py-0.5 hover:bg-accent/50")}
                          onClick={() => setDetails({ repo: openRepo.full_name, number: issue.number })}
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
                          {/* The app's tags, each in its column, the reason on hover; of GitHub's own labels only the Marked ones show.
                              – is not ready yet (Free) or none (assigned on GitHub isn't read); … is not tagged yet. */}
                          <span
                            className={cn("truncate", isAssigned && "text-warn", !isAssigned && tags?.status === "free" && "text-ok")}
                            title={tags?.reason ?? (isAssigned ? "Assigned on GitHub" : "Claude hasn't tagged it yet")}
                          >
                            {isAssigned ? "Assigned" : tags === null ? "…" : tags.status === "free" ? "Free" : "–"}
                          </span>
                          <span className="truncate" title={issue.labels.length > 0 ? `Its labels: ${issue.labels.join(", ")}` : "No labels"}>
                            {!goodFirst && !helpWanted && !confirmed && "–"}
                            {goodFirst && <span className="text-ok">Good first issue</span>}
                            {goodFirst && (helpWanted || confirmed) && " · "}
                            {helpWanted && <span className="text-ok">Help wanted</span>}
                            {helpWanted && confirmed && " · "}
                            {confirmed && "Confirmed"}
                          </span>
                          <span className={cn("truncate", tags !== null && tags.level !== null && LEVEL_COLOR[tags.level])} title={tags?.reason}>
                            {tags !== null ? (tags.level !== null ? LEVEL_LABEL[tags.level] : "–") : isAssigned ? "–" : "…"}
                          </span>
                          <span className="truncate" title={tags?.reason}>
                            {tags !== null ? (tags.lines !== undefined && tags.lines !== null ? `~${tags.lines}` : "–") : isAssigned ? "–" : "…"}
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
                          <span className="truncate text-muted-foreground" title={tags !== null ? new Date(tags.judged_at).toLocaleString() : "Claude hasn't read it yet"}>
                            {tags !== null ? timeAgo(tags.judged_at) : "–"}
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
                              <Button variant="ghost" size="xs" title="Add to the Issues list" onClick={() => addIssue(openRepo.full_name, issue.number)}>
                                <Plus /> Issues
                              </Button>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* On top of the repo's pop-up: a click on one of its issues. Closing it goes back to the repo's. */}
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
