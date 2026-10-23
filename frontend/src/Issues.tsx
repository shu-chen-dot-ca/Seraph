/*
The Issues list: issues the agents picked, and what is being done about each one.

An issue's status comes from its latest job: no job = New, else queued / working / waiting on you / done
(a cancelled latest job counts as New again, so it can be reassigned). Tabs filter by that status,
the repo chip filters by repo (it lives in the URL: #/issues?repo=owner/name, which the Repos page links to).

Each row shows what helps decide whether an issue is worth fixing, from its facts (github_searcher/issue_facts.py,
kept fresh by the backend; Refresh fetches them all now): repo stars, when it was opened, its last activity, comments,
and warning chips when someone is assigned or a PR is open or merged for it. Opened, Active, comments and stars sort
on click (newest/most first, then oldest/fewest, then back to the list's order). Times re-render every minute.

Rows open in place: the facts in full (author and role, last comment and who wrote it, assignees, linked PRs,
the repo's last push), the agent's note, the issue body (fetched from GitHub on every open, so new comments show;
the last one fetched shows meanwhile), and every job for the issue with its progress (steps and the agent's headline) and links to its agent, VM and drafts.
A job in progress shows in the row as a small progress bar with its step.
Assign opens AssignDialog.
Only the rows on screen are drawn, so thousands of issues stay fast. Undo / redo like the Repos page.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronRight, ExternalLink, Loader2, MessageSquare, RefreshCw, Redo2, Undo2, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import AssignDialog from "@/AssignDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JobProgressBar, JobSteps } from "@/components/ui/job-progress";
import { Markdown } from "@/components/ui/markdown";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useLive, useLoaded, type IssueItem, type Job, type Thread } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[16px_60px_minmax(0,1fr)_150px_56px_68px_68px_40px_165px_96px_76px] items-center gap-2";

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

type SortKey = "opened" | "active" | "comments" | "stars";

// Tab → which latest-job statuses it shows. "new" also takes issues without a job.
const TABS = [
  { value: "all", label: "All", statuses: [] as string[] },
  { value: "new", label: "New", statuses: ["cancelled"] },
  { value: "queued", label: "Queued", statuses: ["queued"] },
  { value: "working", label: "Working", statuses: ["working"] },
  { value: "waiting", label: "Waiting", statuses: ["waiting_on_user"] },
  { value: "done", label: "Done", statuses: ["done"] },
];

const ALL_REPOS = "__all__";

// open: an issue id whose row starts open and in view (#/issues?open=owner/name%23n, from the Jobs page).
export default function Issues(props: { repo: string | null; open: string | null }) {
  const issues = useLive("issues");
  const repos = useLive("repos");
  const jobs = useLive("jobs");
  const agents = useLive("agents");
  const loaded = useLoaded("issues");
  const [tab, setTab] = useState("all");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string[]>(props.open !== null ? [props.open] : []);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [threadErrors, setThreadErrors] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<IssueItem | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // Count per tab (within the repo filter), then the rows of the current tab.
  const inRepo = issues.items.filter((issue) => props.repo === null || issue.repo === props.repo);
  const tabCounts: Record<string, number> = {};
  for (const item of TABS) {
    tabCounts[item.value] = inRepo.filter((issue) => {
      const job = latestJob[issue.id];
      if (item.value === "all") {
        return true;
      }
      if (job === undefined) {
        return item.value === "new";
      }
      return item.statuses.includes(job.status);
    }).length;
  }
  const tabStatuses = TABS.find((item) => item.value === tab)?.statuses ?? [];
  const needle = filter.trim().toLowerCase();
  const rows = inRepo.filter((issue) => {
    const job = latestJob[issue.id];
    if (tab !== "all" && job === undefined && tab !== "new") {
      return false;
    }
    if (tab !== "all" && job !== undefined && !tabStatuses.includes(job.status)) {
      return false;
    }
    if (needle === "") {
      return true;
    }
    const text = `${issue.id} ${issue.title} ${issue.note} ${issue.labels.join(" ")}`.toLowerCase();
    return text.includes(needle);
  });

  // The sort value of a row; missing facts sort last either way.
  function sortValue(issue: IssueItem, key: SortKey): number | null {
    const facts = issue.facts;
    if (key === "stars") {
      return facts?.repo_stars ?? repoStars[issue.repo] ?? null;
    }
    if (key === "comments") {
      return facts?.comments ?? issue.comments;
    }
    if (facts === null || facts === undefined) {
      return null;
    }
    return new Date(key === "opened" ? facts.created_at : facts.updated_at).getTime();
  }
  if (sort !== null) {
    rows.sort((a, b) => {
      const first = sortValue(a, sort.key);
      const second = sortValue(b, sort.key);
      if (first === null || second === null) {
        return first === null ? (second === null ? 0 : 1) : -1;
      }
      return sort.desc ? second - first : first - second;
    });
  }

  function clickSort(key: SortKey) {
    if (sort === null || sort.key !== key) {
      setSort({ key, desc: true });
    } else if (sort.desc) {
      setSort({ key, desc: false });
    } else {
      setSort(null);
    }
  }

  function sortHeader(key: SortKey, label: React.ReactNode, title: string) {
    return (
      <button type="button" className="flex items-center gap-0.5 text-left hover:text-foreground" title={title} onClick={() => clickSort(key)}>
        {label}
        {sort?.key === key && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    );
  }

  async function refreshFacts() {
    setRefreshing(true);
    try {
      const result = await api<{ refreshed: number; failed: string[] }>("/api/issues/refresh", { method: "POST" });
      if (result.failed.length > 0) {
        toast.error(`Could not refresh ${result.failed.join(", ")}`);
      }
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : err}`);
    }
    setRefreshing(false);
  }

  // The repo chip offers the Repos list, plus the URL's repo if it isn't listed there.
  const repoNames = repos.items.map((repo) => repo.full_name);
  if (props.repo !== null && !repoNames.includes(props.repo)) {
    repoNames.unshift(props.repo);
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 10,
    getItemKey: (index) => rows[index].id,
  });

  // Opened from a link to one issue (props.open): bring its row into view once the list is there.
  const openIndex = props.open !== null ? rows.findIndex((issue) => issue.id === props.open) : -1;
  const [scrolledTo, setScrolledTo] = useState(false);
  useEffect(() => {
    if (scrolledTo || openIndex < 0) {
      return;
    }
    virtualizer.scrollToIndex(openIndex, { align: "start" });
    setScrolledTo(true);
    // Its text, as a click on the row would fetch it.
    const id = rows[openIndex].id;
    api<Thread>(`/api/issues/thread?id=${encodeURIComponent(id)}`)
      .then((thread) => setThreads((current) => ({ ...current, [id]: thread })))
      .catch((err) => setThreadErrors((current) => ({ ...current, [id]: err instanceof Error ? err.message : String(err) })));
  }, [openIndex, scrolledTo, virtualizer, rows]);

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

  async function remove(id: string) {
    try {
      await api(`/api/issues?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      toast.error(`Could not remove ${id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function cancelJob(job: Job) {
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not cancel ${job.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Open or close a row. Every open fetches the issue thread from GitHub again; the one fetched before shows meanwhile.
  async function toggle(id: string) {
    if (open.includes(id)) {
      setOpen((current) => current.filter((other) => other !== id));
      return;
    }
    setOpen((current) => [...current, id]);
    setThreadErrors((current) => ({ ...current, [id]: "" }));
    try {
      const thread = await api<Thread>(`/api/issues/thread?id=${encodeURIComponent(id)}`);
      setThreads((current) => ({ ...current, [id]: thread }));
    } catch (err) {
      setThreadErrors((current) => ({ ...current, [id]: err instanceof Error ? err.message : String(err) }));
    }
  }

  function setRepo(value: string) {
    window.location.hash = value === ALL_REPOS ? "#/issues" : `#/issues?repo=${encodeURIComponent(value)}`;
  }

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
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <h1 className="font-semibold">Issues</h1>
        <Tabs value={tab} onValueChange={setTab} className="ml-2">
          <TabsList>
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="px-2.5">
                {item.label}
                <span className="text-xs text-muted-foreground tabular-nums">{tabCounts[item.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1">
          <Select value={props.repo ?? ALL_REPOS} onValueChange={setRepo}>
            <SelectTrigger className={cn("max-w-56", props.repo !== null && "border-primary text-primary")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value={ALL_REPOS}>All repos</SelectItem>
              {repoNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {props.repo !== null && (
            <Button variant="ghost" size="icon-sm" aria-label="Clear the repo filter" onClick={() => setRepo(ALL_REPOS)}>
              <X />
            </Button>
          )}
        </div>
        <Input className="w-52" placeholder="Filter issues" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" disabled={refreshing} onClick={refreshFacts} aria-label="Refresh from GitHub">
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh every issue from GitHub (also happens by itself every 30 minutes)</TooltipContent>
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

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>#</span>
        <span>Title</span>
        <span>Repo</span>
        {sortHeader("stars", "Stars", "The repo's stars")}
        {sortHeader("opened", "Opened", "When the issue was opened on GitHub")}
        {sortHeader("active", "Active", "The last activity on the issue: a comment, a label, an edit…")}
        {sortHeader("comments", <MessageSquare className="size-3.5" />, "Comments")}
        <span>Status</span>
        <span>Agent</span>
        <span />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && issues.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No issues yet. Agents add good first issues here while they search.</div>
        )}
        {loaded && issues.items.length > 0 && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">No issue matches.</div>}

        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const issue = rows[item.index];
            const isOpen = open.includes(issue.id);
            const job = latestJob[issue.id];
            const thread = threads[issue.id];
            const threadError = threadErrors[issue.id] ?? "";
            const facts = issue.facts ?? null;
            const commentCount = facts !== null ? facts.comments : thread !== undefined ? thread.comments.length : issue.comments;
            const state = facts !== null ? facts.state : issue.state;
            const stars = facts !== null ? facts.repo_stars : repoStars[issue.repo];
            const openPRs = facts !== null ? facts.linked_prs.filter((pull) => pull.state === "OPEN") : [];
            const mergedPRs = facts !== null ? facts.linked_prs.filter((pull) => pull.state === "MERGED") : [];
            const history = [...(issueJobs[issue.id] ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
            return (
              <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="absolute left-0 w-full border-b" style={{ top: item.start }}>
                <div
                  className={cn(COLUMNS, "h-7 cursor-pointer px-3 hover:bg-accent/50", isOpen && "bg-accent/40")}
                  onClick={() => toggle(issue.id)}
                >
                  <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <a
                    href={issue.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground tabular-nums hover:text-foreground hover:underline"
                    title="Open on GitHub"
                    onClick={(event) => event.stopPropagation()}
                  >
                    #{issue.number}
                  </a>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cn("truncate", state === "CLOSED" && "text-muted-foreground line-through")}>{facts !== null ? facts.title : issue.title}</span>
                    {state === "CLOSED" && <Badge variant="outline">closed</Badge>}
                    {facts !== null && facts.assignees.length > 0 && (
                      <Badge variant="outline" className="border-warn text-warn" title={`Assigned to ${facts.assignees.join(", ")}`}>
                        assigned
                      </Badge>
                    )}
                    {/* Each PR its own chip, linked to it on GitHub; the open ones first, at most three. */}
                    {[...openPRs, ...mergedPRs].slice(0, 3).map((pull) => (
                      <Badge key={pull.url} variant="outline" className={cn("hover:bg-accent", pull.state === "OPEN" && "border-warn text-warn")} asChild>
                        <a href={pull.url} target="_blank" rel="noreferrer" title={`Open on GitHub: by ${pull.author}`} onClick={(event) => event.stopPropagation()}>
                          PR #{pull.number} {pull.state === "OPEN" ? "open" : "merged"}
                        </a>
                      </Badge>
                    ))}
                    {openPRs.length + mergedPRs.length > 3 && <span className="text-xs text-muted-foreground">+{openPRs.length + mergedPRs.length - 3}</span>}
                  </span>
                  <span className="truncate text-muted-foreground">{issue.repo}</span>
                  <span className="text-muted-foreground tabular-nums">{stars !== undefined ? STARS.format(stars) : "–"}</span>
                  <span className="text-muted-foreground tabular-nums" title={facts !== null ? new Date(facts.created_at).toLocaleString() : undefined}>
                    {facts !== null ? timeAgo(facts.created_at) : "–"}
                  </span>
                  <span className="text-muted-foreground tabular-nums" title={facts !== null ? new Date(facts.updated_at).toLocaleString() : undefined}>
                    {facts !== null ? timeAgo(facts.updated_at) : "–"}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{commentCount}</span>
                  {job !== undefined && (job.status === "queued" || job.status === "working" || job.status === "waiting_on_user") ? (
                    <JobProgressBar job={job} />
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <StatusDot tone={job === undefined ? "gray" : JOB_TONE[job.status]} />
                      {job === undefined ? "New" : (JOB_LABEL[job.status] ?? job.status)}
                    </span>
                  )}
                  <span className="truncate">
                    {job !== undefined && (
                      <a href={`#/agents/${job.agent}`} className="hover:underline" onClick={(event) => event.stopPropagation()}>
                        {agentNames[job.agent] ?? job.agent}
                      </a>
                    )}
                  </span>
                  <span className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      title="Give this issue to an agent"
                      onClick={(event) => {
                        event.stopPropagation();
                        setAssigning(issue);
                      }}
                    >
                      <UserPlus /> Assign
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${issue.id}`}
                      title="Remove from the list"
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(issue.id);
                      }}
                    >
                      <X />
                    </Button>
                  </span>
                </div>

                {isOpen && (
                  <div className="space-y-3 border-t bg-muted/30 px-9 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                      <span>
                        {commentCount} {commentCount === 1 ? "comment" : "comments"}
                      </span>
                      {(facts !== null ? facts.labels : issue.labels).map((label) => (
                        <Badge key={label} variant="secondary">
                          {label}
                        </Badge>
                      ))}
                      <a href={issue.html_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">
                        GitHub <ExternalLink className="size-3" />
                      </a>
                    </div>

                    {facts === null && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> Getting the facts from GitHub…
                      </div>
                    )}
                    {facts !== null && (
                      <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1">
                        <span className="text-muted-foreground">Opened</span>
                        <span>
                          {timeAgo(facts.created_at)} by {facts.author}
                          {ROLE[facts.author_role] && (
                            <span className={MAINTAINERS.includes(facts.author_role) ? "text-ok" : "text-muted-foreground"}> · {ROLE[facts.author_role]}</span>
                          )}
                        </span>

                        <span className="text-muted-foreground">Last activity</span>
                        <span>{timeAgo(facts.updated_at)}</span>

                        <span className="text-muted-foreground">Last comment</span>
                        <span>
                          {facts.last_comment_at === null && <span className="text-muted-foreground">No comments yet</span>}
                          {facts.last_comment_at !== null && (
                            <>
                              {timeAgo(facts.last_comment_at)} by {facts.last_comment_by}
                              {facts.last_comment_role !== null && ROLE[facts.last_comment_role] && (
                                <span className={MAINTAINERS.includes(facts.last_comment_role) ? "text-ok" : "text-muted-foreground"}>
                                  {" "}
                                  · {ROLE[facts.last_comment_role]}
                                </span>
                              )}
                              <span className="text-muted-foreground"> · {facts.comments} in all</span>
                            </>
                          )}
                        </span>

                        <span className="text-muted-foreground">Interest</span>
                        <span>
                          {facts.participants} {facts.participants === 1 ? "person" : "people"} in the thread · {facts.thumbs_up} thumbs up
                        </span>

                        <span className="text-muted-foreground">Assigned</span>
                        <span className={facts.assignees.length > 0 ? "text-warn" : "text-muted-foreground"}>
                          {facts.assignees.length > 0 ? facts.assignees.join(", ") : "Nobody"}
                        </span>

                        <span className="text-muted-foreground">Linked PRs</span>
                        <span className="flex flex-wrap gap-x-3">
                          {facts.linked_prs.length === 0 && <span className="text-muted-foreground">None</span>}
                          {facts.linked_prs.map((pull) => (
                            <a
                              key={pull.url}
                              href={pull.url}
                              target="_blank"
                              rel="noreferrer"
                              className={cn("hover:underline", pull.state === "OPEN" ? "text-warn" : "text-muted-foreground")}
                            >
                              {pull.repo !== issue.repo && pull.repo}#{pull.number} {pull.state.toLowerCase()} by {pull.author}
                            </a>
                          ))}
                        </span>

                        <span className="text-muted-foreground">Repo</span>
                        <span>
                          {STARS.format(facts.repo_stars)} stars · last push {timeAgo(facts.repo_pushed_at)}
                        </span>

                        <span className="col-span-2 text-xs text-muted-foreground">From GitHub {timeAgo(facts.fetched_at)}</span>
                      </div>
                    )}

                    {issue.note !== "" && (
                      <div className="border-l-2 border-primary pl-3">
                        <div className="text-xs font-medium text-muted-foreground">Agent's note</div>
                        <div className="whitespace-pre-wrap">{issue.note}</div>
                      </div>
                    )}

                    {thread === undefined && threadError === "" && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> Loading the issue…
                      </div>
                    )}
                    {threadError !== "" && <div className="text-destructive">Could not load the issue: {threadError}</div>}
                    {thread !== undefined && (
                      <div className="border bg-background px-4 py-3">
                        <Markdown text={thread.body || "*No description.*"} repo={issue.repo} issueRefs />
                      </div>
                    )}

                    <div>
                      <div className="mb-1 text-xs font-medium text-muted-foreground">Jobs</div>
                      {history.length === 0 && <div className="text-muted-foreground">No jobs yet. Use Assign to give this issue to an agent.</div>}
                      {history.map((each) => (
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
                )}
              </div>
            );
          })}
        </div>
      </div>

      {assigning !== null && <AssignDialog key={assigning.id} issue={assigning} onClose={() => setAssigning(null)} />}
    </div>
  );
}
