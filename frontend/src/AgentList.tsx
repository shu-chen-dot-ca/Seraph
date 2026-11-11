/*
The Dashboard's Agents page (#/dashboard/agents): the agents in one table, with tabs Open (first) and Closed with how
many, like the Dashboard's Pull requests. Open has the agents on an issue that is in Catalog, In progress, Review,
Needs action or Waiting approval on the Issues board (IssueBoard.tsx): a job on the issue that waits in the queue, works, waits on you or is
paused, or waits on maintainers while its pull request is open (or not read yet); or an open pull request of yours the
agent follows (also after its job is done). Closed has every other one (?state=closed): finished, cancelled, archived,
and the ones you only chat with. A row:
its name (with its status dot), its id, the repository, issue and pull request it is on, the VM it works on (its job's,
else the one it holds or waits for, else its target VM; its page) and its desktop there now (Desktop 2, In line #3 while
it waits for one, else –), how many times its context was
compacted over its whole life, how full its context is now, and the tokens it used over its whole life, in millions
(every reply's: what it was given, cached or not, plus what it wrote).
The repository, issue and pull request come from its job: the one that makes it open (a working one first), else the job
it is on now, else its newest. The pull request is the one it follows (an open one first), from the live "prs" topic; with no job on
an issue, the issue is the one that pull request links. The repository, issue and pull request open on GitHub in a new
tab; a click anywhere else on the row opens the agent's chat (#/agents/<id>), which stays on the Dashboard tab
(App.tsx). In phone mode only the name and the context show.
Everything comes from the live "agents", "jobs" and "prs" topics, so the table updates itself while agents work.
*/

import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";

import { currentJob } from "@/components/ui/job-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AGENT_TONE, StatusDot } from "@/components/ui/status-dot";
import { useLive, useLoaded, type AgentSummary, type Job } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS =
  "grid grid-cols-[minmax(120px,180px)_96px_minmax(140px,1fr)_80px_110px_100px_120px_96px_150px_80px] items-center gap-3 max-md:grid-cols-[minmax(0,1fr)_150px]";

// The context bar's full width: the backend compacts the conversation at AGENT_CONTEXT_CAP (500k) tokens, or earlier
// when the model's window is smaller.
const CONTEXT_CAP = 500_000;

export default function AgentList(props: { state: "open" | "closed" }) {
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const prs = useLive("prs");
  const loaded = useLoaded("agents");
  // The open agents, by id, and the job that makes each one open (a working one first), for its row.
  const openIds: string[] = [];
  const openJobs: Record<string, Job> = {};
  for (const job of jobs) {
    if (job.issue === null) {
      continue;
    }
    let isOpen = job.status === "queued" || job.status === "working" || job.status === "waiting_on_user" || job.status === "paused";
    if (job.status === "waiting_on_maintainers") {
      const pr = prs.items.find((each) => each.job === job.id);
      isOpen = pr === undefined || pr.state === "open";
    }
    if (!isOpen) {
      continue;
    }
    if (!openIds.includes(job.agent)) {
      openIds.push(job.agent);
    }
    if (openJobs[job.agent] === undefined || job.status === "working") {
      openJobs[job.agent] = job;
    }
  }
  // Needs action and Waiting approval also have the open pull requests of yours an agent follows, also after its job is done.
  for (const pr of prs.items) {
    if (pr.relation === "author" && pr.state === "open" && pr.agent !== null && !openIds.includes(pr.agent)) {
      openIds.push(pr.agent);
    }
  }
  const open = agents.filter((agent) => openIds.includes(agent.id));
  const closed = agents.filter((agent) => !openIds.includes(agent.id));
  const shown = props.state === "closed" ? closed : open;
  const link = "truncate hover:underline";

  function row(agent: AgentSummary) {
    // Its job: the one that makes it open, else the one it is on now, else its newest.
    let job: Job | undefined = openJobs[agent.id];
    if (job === undefined) {
      job = currentJob(agent.id, jobs);
    }
    if (job === undefined) {
      for (const each of jobs) {
        if (each.agent === agent.id && (job === undefined || each.updated_at > job.updated_at)) {
          job = each;
        }
      }
    }
    // The pull request it follows, an open one first.
    const mine = prs.items.filter((each) => each.agent === agent.id);
    const pr = mine.find((each) => each.state === "open") ?? (mine.length > 0 ? mine[0] : undefined);
    const repo = job?.repo ?? pr?.repo ?? agent.repo ?? agent.project ?? agent.workflow ?? null;
    // Where it works: its job's VM, else the one it holds or waits for, else its target VM; and its desktop there now.
    const vm = job?.vm ?? agent.vm ?? agent.target_vm;
    let desktop = "";
    if (agent.status === "using_vm") {
      desktop = `Desktop ${agent.desktop}`;
    }
    if (agent.status === "in_queue") {
      desktop = `In line #${agent.place}`;
    }
    // The issue as "owner/name#n" and its page on GitHub.
    let issue: string | null = null;
    let issueUrl = "";
    if (job !== undefined && job.issue !== null) {
      issue = job.issue;
      issueUrl = `https://github.com/${job.issue.replace("#", "/issues/")}`;
    } else if (pr !== undefined && pr.issues.length > 0) {
      issue = `${pr.repo}#${pr.issues[0].number}`;
      issueUrl = pr.issues[0].url;
    }
    let prIcon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
    if (pr !== undefined && pr.state === "merged") {
      prIcon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
    }
    if (pr !== undefined && pr.state === "closed") {
      prIcon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
    }
    const cap = agent.context_max > 0 ? Math.min(agent.context_max, CONTEXT_CAP) : CONTEXT_CAP;
    const percent = Math.min(100, (agent.context_used / cap) * 100);

    return (
      <div
        key={agent.id}
        className={cn(COLUMNS, "h-8 cursor-pointer border-b px-3 hover:bg-accent/50")}
        onClick={() => {
          window.location.hash = `#/agents/${agent.id}`;
        }}
      >
        <a href={`#/agents/${agent.id}`} className="flex min-w-0 items-center gap-1.5 font-medium" title={agent.activity}>
          <StatusDot tone={agent.archived_at !== null ? "gray" : (AGENT_TONE[agent.status] ?? "gray")} />
          <span className="truncate">{agent.name}</span>
        </a>
        <span className="truncate font-mono text-xs text-muted-foreground max-md:hidden">{agent.id}</span>
        <span className="min-w-0 truncate max-md:hidden">
          {repo === null && <span className="text-muted-foreground">–</span>}
          {repo !== null && (
            <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer" className={link} onClick={(event) => event.stopPropagation()}>
              {repo}
            </a>
          )}
        </span>
        <span className="min-w-0 truncate max-md:hidden">
          {issue === null && <span className="text-muted-foreground">–</span>}
          {issue !== null && (
            <a href={issueUrl} target="_blank" rel="noreferrer" className={link} title={job?.title ?? issue} onClick={(event) => event.stopPropagation()}>
              #{issue.split("#")[1]}
            </a>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 max-md:hidden">
          {pr === undefined && <span className="text-muted-foreground">–</span>}
          {pr !== undefined && (
            <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 hover:underline" title={pr.title} onClick={(event) => event.stopPropagation()}>
              {prIcon}
              <span className="truncate">#{pr.number}</span>
            </a>
          )}
        </span>
        <span className="min-w-0 truncate max-md:hidden">
          {vm === null && <span className="text-muted-foreground">–</span>}
          {vm !== null && (
            <a href={`#/vms/${encodeURIComponent(vm)}`} className={link} onClick={(event) => event.stopPropagation()}>
              {vm}
            </a>
          )}
        </span>
        <span className={cn("truncate max-md:hidden", desktop === "" && "text-muted-foreground")}>{desktop === "" ? "–" : desktop}</span>
        <span className={cn("tabular-nums max-md:hidden", agent.compactions === 0 && "text-muted-foreground")}>{agent.compactions}</span>
        <span className="flex items-center gap-2" title={`${agent.context_used.toLocaleString()} of ${cap.toLocaleString()} tokens`}>
          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className={cn("block h-full", percent > 80 ? "bg-warn" : "bg-muted-foreground/70")} style={{ width: `${percent}%` }} />
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {Math.round(agent.context_used / 1000)}k / {cap >= 1_000_000 ? `${cap / 1_000_000}M` : `${Math.round(cap / 1000)}k`}
          </span>
        </span>
        <span className="tabular-nums max-md:hidden" title={`${agent.tokens_used.toLocaleString()} tokens`}>
          {(agent.tokens_used / 1_000_000).toFixed(1)}M
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 items-center border-b px-3 py-1">
        <Tabs
          value={props.state}
          onValueChange={(value) => {
            window.location.hash = value === "closed" ? "#/dashboard/agents?state=closed" : "#/dashboard/agents";
          }}
        >
          <TabsList>
            <TabsTrigger value="open" className="px-2.5">
              Open <span className="text-xs text-muted-foreground tabular-nums">{loaded ? open.length : ""}</span>
            </TabsTrigger>
            <TabsTrigger value="closed" className="px-2.5">
              Closed <span className="text-xs text-muted-foreground tabular-nums">{loaded ? closed.length : ""}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span>Name</span>
        <span className="max-md:hidden">ID</span>
        <span className="max-md:hidden">Repository</span>
        <span className="max-md:hidden">Issue</span>
        <span className="max-md:hidden">Pull request</span>
        <span className="max-md:hidden">VM</span>
        <span className="max-md:hidden">Desktop</span>
        <span className="max-md:hidden">Compactions</span>
        <span>Context</span>
        <span className="max-md:hidden">Tokens</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && shown.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">{props.state === "closed" ? "No closed agents." : "No open agents."}</div>
        )}
        {shown.map((agent) => row(agent))}
      </div>
    </div>
  );
}
