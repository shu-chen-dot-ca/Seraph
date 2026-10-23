/*
The Tracked list: repos the user wants to keep an eye on for new issues. The user adds them here by name or
GitHub link; agents can add and remove them too (their tracked_* tools), and undo / redo works on both, like Repos.

The backend checks each repo's open issues every few minutes (github_searcher/tracked_issues.py): the newest
ones and every good first issue. An issue is new when it was opened after the user last marked the repo seen;
the row shows how many are new, the sidebar the total. Check now asks GitHub at once.

Each row opens in place to its issues, newest first, with tabs New / Good first / All (New when there are new
ones). An issue goes into the Issues list with one click (its repo into Repos too), or links there when it is
in already. The list is short (repos the user picked), so every row is drawn; times re-render every minute.
*/

import { Check, CheckCheck, ChevronRight, Loader2, MessageSquare, Plus, Redo2, RefreshCw, Star, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useLive, useLoaded } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

const STARS = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const COLUMNS = "grid grid-cols-[16px_minmax(0,1fr)_72px_64px_84px_64px_84px_88px] items-center gap-2";
const ISSUE_COLUMNS = "grid grid-cols-[56px_minmax(0,1fr)_150px_36px_92px] items-center gap-2";
// Same as the backend's GOOD_FIRST (tracked_issues.py), to color those labels.
const GOOD_FIRST = /good.?first|first.?timer|beginner|easy/i;

type IssueTab = "new" | "good_first" | "all";

export default function Tracked() {
  const tracked = useLive("tracked");
  const issues = useLive("issues");
  const loaded = useLoaded("tracked");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string[]>([]);
  const [tabs, setTabs] = useState<Record<string, IssueTab>>({});
  const [checking, setChecking] = useState<string[]>([]);
  const [, setTick] = useState(0);

  // "3h ago" goes stale on its own: draw again every minute.
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const inIssues = new Set(issues.items.map((issue) => issue.id));
  // How many of each repo's open issues were opened since the user last marked it seen.
  const newCounts: Record<string, number> = {};
  let totalNew = 0;
  for (const repo of tracked.items) {
    const check = repo.check;
    newCounts[repo.full_name] = check !== null ? check.issues.filter((issue) => issue.created_at > check.seen_at).length : 0;
    totalNew += newCounts[repo.full_name];
  }

  async function add() {
    if (name.trim() === "") {
      return;
    }
    setAdding(true);
    try {
      await api("/api/tracked", { method: "POST", body: { name: name.trim() } });
      setName("");
    } catch (err) {
      toast.error(`Could not track it: ${err instanceof Error ? err.message : err}`);
    }
    setAdding(false);
  }

  async function remove(full_name: string) {
    try {
      await api(`/api/tracked?name=${encodeURIComponent(full_name)}`, { method: "DELETE" });
    } catch (err) {
      toast.error(`Could not remove ${full_name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function markSeen(full_name: string | null) {
    try {
      await api("/api/tracked/seen", { method: "POST", body: { name: full_name } });
    } catch (err) {
      toast.error(`Could not mark as seen: ${err instanceof Error ? err.message : err}`);
    }
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
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <h1 className="font-semibold">Tracked</h1>
        <span className="text-muted-foreground tabular-nums">{tracked.items.length}</span>
        <form
          className="ml-4 flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input className="w-72" placeholder="owner/name or GitHub link" value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" variant="outline" disabled={adding || name.trim() === ""}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />} Track
          </Button>
        </form>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" disabled={totalNew === 0} onClick={() => markSeen(null)} title="None of the issues is new anymore">
            <CheckCheck /> Mark all seen
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled={!tracked.can_undo} onClick={undo} aria-label="Undo">
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" disabled={!tracked.can_redo} onClick={redo} aria-label="Redo">
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo (Ctrl+Y)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>Name</span>
        <span className="text-right">Stars</span>
        <span className="text-right">New</span>
        <span className="text-right">Good first</span>
        <span className="text-right">Open</span>
        <span className="text-right">Checked</span>
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && tracked.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">Nothing tracked yet. Type a repo above to keep an eye on its new issues.</div>
        )}

        {tracked.items.map((repo) => {
          const isOpen = open.includes(repo.full_name);
          const check = repo.check;
          const fresh = newCounts[repo.full_name];
          const goodFirst = check !== null ? check.issues.filter((issue) => issue.good_first).length : 0;
          const tab = tabs[repo.full_name] ?? (fresh > 0 ? "new" : "all");
          const shown =
            check === null
              ? []
              : check.issues.filter((issue) => {
                  if (tab === "new") {
                    return issue.created_at > check.seen_at;
                  }
                  if (tab === "good_first") {
                    return issue.good_first;
                  }
                  return true;
                });
          return (
            <div key={repo.full_name} className="border-b">
              <div className={cn("cursor-pointer px-3 hover:bg-accent/50", isOpen && "bg-accent/40")} onClick={() => toggle(repo.full_name)}>
                <div className={cn(COLUMNS, "h-7")}>
                  <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="truncate font-medium">{repo.full_name}</span>
                  <span className="flex items-center justify-end gap-1 text-muted-foreground tabular-nums">
                    <Star className="size-3.5" />
                    {STARS.format(check !== null && check.stars !== null ? check.stars : repo.stars)}
                  </span>
                  <span className={cn("text-right tabular-nums", fresh > 0 ? "font-medium text-primary" : "text-muted-foreground")}>{check !== null ? fresh : "–"}</span>
                  <span className={cn("text-right tabular-nums", goodFirst > 0 ? "text-ok" : "text-muted-foreground")}>{check !== null ? goodFirst : "–"}</span>
                  <span className="text-right text-muted-foreground tabular-nums">{check !== null ? check.issues.length : "–"}</span>
                  <span className="flex items-center justify-end gap-1 text-muted-foreground tabular-nums">
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
                  <span className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
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
                      aria-label={`Mark ${repo.full_name} seen`}
                      title="Mark seen: none of its issues is new anymore"
                      disabled={fresh === 0}
                      onClick={() => markSeen(repo.full_name)}
                    >
                      <Check />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Stop tracking ${repo.full_name}`} title="Stop tracking" onClick={() => remove(repo.full_name)}>
                      <X />
                    </Button>
                  </span>
                </div>
                {(repo.note !== "" || repo.description !== "") && <div className="-mt-1 truncate pb-1.5 pl-6 text-muted-foreground">{repo.note || repo.description}</div>}
              </div>

              {isOpen && (
                <div className="border-t bg-muted/30 py-1.5 pr-3 pl-9">
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
                          <TabsTrigger value="new" className="px-2.5">
                            New <span className="text-xs text-muted-foreground tabular-nums">{fresh}</span>
                          </TabsTrigger>
                          <TabsTrigger value="good_first" className="px-2.5">
                            Good first <span className="text-xs text-muted-foreground tabular-nums">{goodFirst}</span>
                          </TabsTrigger>
                          <TabsTrigger value="all" className="px-2.5">
                            All open <span className="text-xs text-muted-foreground tabular-nums">{check.issues.length}</span>
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                      {shown.length === 0 && (
                        <div className="py-1 text-muted-foreground">
                          {tab === "new" && `Nothing new since ${timeAgo(check.seen_at)}.`}
                          {tab === "good_first" && "No open issue with a good-first-issue kind of label."}
                          {tab === "all" && "No open issues."}
                        </div>
                      )}
                      {shown.map((issue) => {
                        const id = `${repo.full_name}#${issue.number}`;
                        const isNew = issue.created_at > check.seen_at;
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
                                <Badge variant="outline" className="border-warn text-warn">
                                  assigned
                                </Badge>
                              )}
                              {issue.labels.map((label) => (
                                <Badge key={label} variant={GOOD_FIRST.test(label) ? "outline" : "secondary"} className={cn(GOOD_FIRST.test(label) && "border-ok text-ok")}>
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
    </div>
  );
}
