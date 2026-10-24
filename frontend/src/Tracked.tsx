/*
The Tracked list: repos the user wants to keep an eye on for new issues. The user tracks them from the Repos page (its
Track column); agents can add and remove them too (their tracked_* tools), and undo / redo (Ctrl+Z / Ctrl+Y) works on
both, like Repos. The bar on top is kept empty, so the page lines up with the others.

The backend checks each repo's open issues every few minutes (github_searcher/tracked_issues.py): the newest
ones and every one with a good-first-issue or help-wanted kind of label. An issue is new for three days after it
was opened, assigned or not; the row shows how many are new, the sidebar the total. Check now asks GitHub at once.

The list is a table like the Explore page's: Name (taking the room left over) and its description under it, then
TRACKED_COLUMNS, every column as wide as its widest cell (one CSS grid, each row a subgrid), the text in the page's own
color (blue for new issues, green for free ones, red for a failed check). A click on a header sorts by that
column, one at a time: the most first (A to Z for the name, the latest check first), again the other way round, again
back to the list's order; the sorted header is blue with an arrow.

Each row opens in place to its issues, newest first, with tabs Free (nobody assigned, and a good-first-issue or
help-wanted kind of label) / Assigned (someone is on it) / All (Free when there are free ones). An issue goes into the Issues list with one click (its repo into Repos too), or links there when it is
in already. The list is short (repos the user picked), so every row is drawn; times re-render every minute.
Many rows are picked like in a mail app (components/ui/row-selection.tsx): Ctrl-click, Shift-click, dragging a rectangle,
Ctrl+A; a bar at the bottom then stops tracking them at once, as one undo step (it asks first; Enter confirms).
*/

import { ArrowDown, ArrowUp, Loader2, MessageSquare, Plus, RefreshCw, Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import { RowSelection } from "@/components/ui/row-selection";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type TrackedRepo } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
// The columns after Name, each sorted by a click on its header (the most, or the latest, first).
type TrackedKey = "name" | "stars" | "new" | "free" | "open" | "checked";
const TRACKED_COLUMNS: { key: TrackedKey; label: string; title: string }[] = [
  { key: "stars", label: "Stars", title: "Stars on GitHub" },
  { key: "new", label: "New", title: "Open issues opened in the last 3 days, assigned or not" },
  { key: "free", label: "Free", title: "Open issues nobody is assigned to, with a good-first-issue or help-wanted kind of label" },
  { key: "open", label: "Open", title: "Open issues its last check found" },
  { key: "checked", label: "Checked", title: "When the backend last asked GitHub" },
];
const ISSUE_COLUMNS = "grid grid-cols-[56px_minmax(0,1fr)_150px_36px_92px] items-center gap-2";
// Same as the backend's GOOD_FIRST (tracked_issues.py), to color those labels.
const GOOD_FIRST = /good.?first|first.?timer|beginner|easy|help.?wanted|up.?for.?grabs/i;

type IssueTab = "free" | "assigned" | "all";

export default function Tracked() {
  const tracked = useLive("tracked");
  const issues = useLive("issues");
  const loaded = useLoaded("tracked");
  const [open, setOpen] = useState<string[]>([]);
  const [tabs, setTabs] = useState<Record<string, IssueTab>>({});
  const [checking, setChecking] = useState<string[]>([]);
  // The list's order: as tracked (null), or by one column; best is the way its first click sorts, or not.
  const [sort, setSort] = useState<{ key: TrackedKey; best: boolean } | null>(null);
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
  // An issue is new for three days after it was opened, assigned or not. How many of each repo's are.
  const newSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const newCounts: Record<string, number> = {};
  for (const repo of tracked.items) {
    const check = repo.check;
    newCounts[repo.full_name] = check !== null ? check.issues.filter((issue) => new Date(issue.created_at).getTime() > newSince).length : 0;
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
    if (check === null) {
      return null;
    }
    if (key === "new") {
      return newCounts[repo.full_name];
    }
    if (key === "free") {
      return check.issues.filter((issue) => issue.good_first && issue.assignees === 0).length;
    }
    if (key === "open") {
      return check.issues.length;
    }
    return new Date(check.checked_at).getTime();
  }

  const rows = [...tracked.items];
  if (sort !== null) {
    rows.sort((a, b) => {
      const first = trackedValue(a, sort.key);
      const second = trackedValue(b, sort.key);
      if (first === second) {
        return 0;
      }
      // Missing values go last, whichever way.
      if (first === null) {
        return 1;
      }
      if (second === null) {
        return -1;
      }
      // The name A to Z; numbers the most first. Then turned round for the other way.
      const order = typeof first === "string" && typeof second === "string" ? first.localeCompare(second) : Number(second) - Number(first);
      return sort.best ? order : -order;
    });
  }

  // One column at a time: the best first, then the other way round, then back to the list's order.
  function clickSort(key: TrackedKey) {
    if (sort === null || sort.key !== key) {
      setSort({ key, best: true });
    } else if (sort.best) {
      setSort({ key, best: false });
    } else {
      setSort(null);
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
      {/* Kept empty: the same bar as on the other pages, with nothing in it. */}
      <div className="h-9 shrink-0 border-b" />

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && tracked.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">Nothing tracked yet. Track a repo from the Repos page to keep an eye on its new issues.</div>
        )}

        {/* One grid for the whole table, its columns as wide as their widest cell; the header and each row are subgrids
            of it, so they line up. w-max lets it grow past the page (it scrolls sideways); min-w-full fills the page
            otherwise, Name taking the room left over. The description and the open repo span the row without widening it. */}
        {rows.length > 0 && (
          <div
            className="grid w-max min-w-full gap-x-4 border-b"
            style={{ gridTemplateColumns: `minmax(160px,1fr) repeat(${TRACKED_COLUMNS.length}, max-content) max-content` }}
          >
            <div className="col-span-full grid h-7 grid-cols-subgrid items-center bg-muted/40 px-3 text-xs font-medium">
              {[{ key: "name" as TrackedKey, label: "Name", title: "A to Z" }, ...TRACKED_COLUMNS].map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className={cn("flex items-center gap-0.5 hover:text-primary", sort?.key === column.key && "text-primary")}
                  title={column.title}
                  onClick={() => clickSort(column.key)}
                >
                  {column.label}
                  {sort?.key === column.key && (sort.best ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                </button>
              ))}
              <span />
            </div>
            {rows.map((repo) => {
              const isOpen = open.includes(repo.full_name);
              const check = repo.check;
              const fresh = newCounts[repo.full_name];
              const free = check !== null ? check.issues.filter((issue) => issue.good_first && issue.assignees === 0).length : 0;
              const assigned = check !== null ? check.issues.filter((issue) => issue.assignees > 0).length : 0;
              const tab = tabs[repo.full_name] ?? (free > 0 ? "free" : "all");
              const shown =
                check === null
                  ? []
                  : check.issues.filter((issue) => {
                      if (tab === "free") {
                        return issue.good_first && issue.assignees === 0;
                      }
                      if (tab === "assigned") {
                        return issue.assignees > 0;
                      }
                      return true;
                    });
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
                    <span className="flex h-7 items-center gap-1 tabular-nums">
                      <Star className="size-3.5" />
                      {STARS.format(check !== null && check.stars !== null ? check.stars : repo.stars)}
                    </span>
                    <span className={cn("flex h-7 items-center tabular-nums", fresh > 0 && "font-medium text-primary")}>{check !== null ? fresh : "–"}</span>
                    <span className={cn("flex h-7 items-center tabular-nums", free > 0 && "text-ok")}>{check !== null ? free : "–"}</span>
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
                    <div className="col-span-full w-0 min-w-full border-t bg-muted/30 px-3 py-1.5">
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
                              {tab === "free" && "No unassigned issue with a good-first-issue or help-wanted kind of label."}
                              {tab === "assigned" && "Nobody is assigned to any of its open issues."}
                              {tab === "all" && "No open issues."}
                            </div>
                          )}
                          {shown.map((issue) => {
                            const id = `${repo.full_name}#${issue.number}`;
                            const isNew = new Date(issue.created_at).getTime() > newSince;
                            return (
                              <div key={issue.number} className={cn(ISSUE_COLUMNS, "min-h-7 border-t border-border/50 py-0.5")}>
                                <a
                                  href={issue.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-muted-foreground tabular-nums hover:text-foreground hover:underline"
                                  title="Open on GitHub"
                                >
                                  #{issue.number}
                                </a>
                                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                                  <a href={issue.url} target="_blank" rel="noreferrer" className="truncate hover:underline" title={issue.title}>
                                    {issue.title}
                                  </a>
                                  {isNew && <Badge>new</Badge>}
                                  {issue.assignees > 0 && (
                                    <Badge variant="warn">
                                      assigned
                                    </Badge>
                                  )}
                                  {issue.labels.map((label) => (
                                    <Badge key={label} variant={GOOD_FIRST.test(label) ? "ok" : "secondary"}>
                                      {label}
                                    </Badge>
                                  ))}
                                </span>
                                <span className="truncate text-muted-foreground" title={new Date(issue.created_at).toLocaleString()}>
                                  {timeAgo(issue.created_at)} by {issue.author}
                                </span>
                                <span className="flex items-center gap-1 text-muted-foreground tabular-nums" title="Comments">
                                  <MessageSquare className="size-3.5" />
                                  {issue.comments}
                                </span>
                                <span className="flex justify-end">
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
