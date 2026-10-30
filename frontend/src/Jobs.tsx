/*
The Jobs list: every job of every agent, and the place to make new ones.

A job comes from Assign on the Issues page (kind fix_issue), from Set up on the Repos page (kind set_up_repo:
the repo running on the VM's desktop or opened in VS Code there, and the agent's short introduction to it in its
notes), from New job here (kind task), from an agent itself (job_create), or from the app (kind follow_up: someone
else wrote on one of your PRs or issues whose Agent setting is Drafts, or a PR's checks failed, and its agent drafts
an answer or a fix for the Inbox). Tabs filter by status; "Open" is everything not done or cancelled, the most
recently changed first. Each row shows its progress (the step the agent is on) and, under the title, the
agent's headline in everyday words. Only the rows on screen are drawn, so long lists stay fast.
A click on a row opens that job in a pop-up (#/jobs/<job id>, whatever the tab or filter); the X, Esc or a click
outside it closes it, back to the list. Its top has the job's status, links to its agent, VM and issue, and Cancel
job for an open one (like the row's Cancel). A follow_up job links, in the row and the pop-up, to the PR or issue it
answers: its pop-up on the GitHub tab (#/github/pulls?open=... or #/github/issues?open=...), and GitHub. Below that: every step, what the job is about, the technical detail,
the project's test suite runs (before and with the change), what the agent is doing right now, the instructions,
the agent's notes and the drafts it made, each linking to the Inbox.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { ExternalLink, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import NewJobDialog from "@/NewJobDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { JobProgressBar, JobSteps, JobTests, since, stuckFor, useNow } from "@/components/ui/job-progress";
import { DRAFT_TONE, JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type AgentSummary, type Job } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[120px_165px_minmax(0,1fr)_110px_70px_190px_120px_64px] items-center gap-2";

const OPEN = ["queued", "working", "waiting_on_user"];

const TABS = [
  { value: "open", label: "Open", statuses: OPEN },
  { value: "queued", label: "Queued", statuses: ["queued"] },
  { value: "working", label: "Working", statuses: ["working"] },
  { value: "waiting", label: "Waiting", statuses: ["waiting_on_user"] },
  { value: "done", label: "Done", statuses: ["done"] },
  { value: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
  { value: "all", label: "All", statuses: [] as string[] },
];

const DRAFT_KIND: Record<string, string> = { pr: "PR", comment: "Comment", question: "Question" };

export default function Jobs(props: { selected: string | null }) {
  const jobs = useLive("jobs");
  const agents = useLive("agents");
  const inbox = useLive("inbox");
  const prs = useLive("prs");
  const loaded = useLoaded("jobs");
  const [tab, setTab] = useState("open");
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const now = useNow();

  const agentNames: Record<string, string> = {};
  const agentById: Record<string, AgentSummary> = {};
  for (const each of agents) {
    agentNames[each.id] = each.name;
    agentById[each.id] = each;
  }
  const drafts: Record<string, { kind: string; status: string; title: string }> = {};
  for (const draft of inbox) {
    drafts[draft.id] = { kind: draft.kind, status: draft.status, title: draft.title };
  }
  // A follow_up job's PR or issue opens in the GitHub tab's pop-up: under Pull requests when it is one of your PRs.
  const prIds: string[] = prs.items.map((each) => each.id);

  // The job in the pop-up (#/jobs/<id>), looked up in all jobs, whatever the tab and filter.
  const job = jobs.find((each) => each.id === props.selected);
  const isOpenJob = job !== undefined && OPEN.includes(job.status);
  const agent = job !== undefined ? agentById[job.agent] : undefined;
  // What the agent does right now, only for the job it is working on in this turn.
  const live = job !== undefined && agent !== undefined && agent.busy && job.status === "working";
  const stuck = live ? stuckFor(agent, now) : "";

  const tabCounts: Record<string, number> = {};
  for (const item of TABS) {
    tabCounts[item.value] = jobs.filter((each) => item.value === "all" || item.statuses.includes(each.status)).length;
  }
  const tabStatuses = TABS.find((item) => item.value === tab)?.statuses ?? [];
  const needle = filter.trim().toLowerCase();
  const rows = jobs
    .filter((each) => {
      if (tab !== "all" && !tabStatuses.includes(each.status)) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const text = `${each.id} ${each.title} ${each.issue ?? ""} ${each.thread ?? ""} ${each.vm ?? ""} ${agentNames[each.agent] ?? ""} ${each.instructions} ${each.notes}`.toLowerCase();
      return text.includes(needle);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // A row is 28px, or 44px for an open job with its headline under the title.
    estimateSize: (index) => (OPEN.includes(rows[index].status) && rows[index].headline !== "" ? 44 : 28),
    overscan: 10,
    getItemKey: (index) => rows[index].id,
  });

  async function cancelJob(target: Job) {
    try {
      await api(`/api/jobs/${target.id}/cancel`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not cancel ${target.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="px-2.5">
                {item.label}
                <span className="text-xs text-muted-foreground tabular-nums">{tabCounts[item.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Input className="ml-auto w-52" placeholder="Filter jobs" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New job
        </Button>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span>Status</span>
        <span>Progress</span>
        <span>Job</span>
        <span>Agent</span>
        <span>VM</span>
        <span>Issue or PR</span>
        <span>Updated</span>
        <span />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && jobs.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No jobs yet. Use New job, or Assign on the Issues page.</div>
        )}
        {loaded && jobs.length > 0 && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">No job matches.</div>}

        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const each = rows[item.index];
            const eachIsOpen = OPEN.includes(each.status);
            const eachAgent = agentById[each.agent];
            // Amber when its agent, working on it in this turn, has been quiet for a while.
            const eachLive = eachAgent !== undefined && eachAgent.busy && each.status === "working";
            const eachStuck = eachLive ? stuckFor(eachAgent, now) : "";
            return (
              <div
                key={item.key}
                className={cn(
                  COLUMNS,
                  "absolute left-0 w-full cursor-pointer border-b px-3 hover:bg-accent/50",
                  eachIsOpen && each.headline !== "" ? "h-11" : "h-7",
                  each.id === props.selected && "bg-selected hover:bg-selected",
                )}
                style={{ top: item.start }}
                onClick={() => {
                  window.location.hash = `#/jobs/${each.id}`;
                }}
              >
                <span className="flex items-center gap-1.5">
                  <StatusDot tone={eachStuck !== "" ? "amber" : JOB_TONE[each.status]} />
                  {JOB_LABEL[each.status] ?? each.status}
                </span>
                <JobProgressBar job={each} />
                <span className="min-w-0">
                  <span className={cn("block truncate", !eachIsOpen && "text-muted-foreground")}>{each.title}</span>
                  {eachIsOpen && each.headline !== "" && (
                    <span className="block truncate text-xs text-muted-foreground" title={each.headline}>
                      {each.headline}
                    </span>
                  )}
                </span>
                <a href={`#/agents/${each.agent}`} className="truncate hover:underline" onClick={(event) => event.stopPropagation()}>
                  {agentNames[each.agent] ?? each.agent}
                </a>
                <span className="truncate">
                  {each.vm !== null && (
                    <a href={`#/vms/${each.vm}`} className="hover:underline" onClick={(event) => event.stopPropagation()}>
                      {each.vm}
                    </a>
                  )}
                </span>
                <span className="truncate text-muted-foreground">
                  {each.issue !== null && (
                    <span className="flex items-center gap-1">
                      <a
                        href={`#/issues?repo=${encodeURIComponent(each.repo ?? "")}&open=${encodeURIComponent(each.issue)}`}
                        className="truncate hover:text-foreground hover:underline"
                        title="Open it in Issues"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {each.issue}
                      </a>
                      <a
                        href={`https://github.com/${each.issue.replace("#", "/issues/")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 hover:text-foreground"
                        title="Open on GitHub"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </span>
                  )}
                  {each.issue === null && each.thread !== null && (
                    <span className="flex items-center gap-1">
                      <a
                        href={`#/github/${prIds.includes(each.thread) ? "pulls" : "issues"}?open=${encodeURIComponent(each.thread)}`}
                        className="truncate hover:text-foreground hover:underline"
                        title="Open it on the GitHub tab"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {each.thread}
                      </a>
                      <a
                        href={`https://github.com/${each.thread.replace("#", "/issues/")}`}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 hover:text-foreground"
                        title="Open on GitHub"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    </span>
                  )}
                </span>
                <span className="truncate text-xs whitespace-nowrap text-muted-foreground tabular-nums">{new Date(each.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                <span className="flex justify-end">
                  {eachIsOpen && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        cancelJob(each);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {creating && <NewJobDialog onClose={() => setCreating(false)} />}

      <Dialog
        open={props.selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            window.location.hash = "#/jobs";
          }
        }}
      >
        <DialogContent aria-describedby={undefined} className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          {job === undefined && (
            <div className="flex flex-1 items-center justify-center">
              <DialogTitle className="font-normal text-muted-foreground">{loaded ? `There is no job ${props.selected}.` : "Loading…"}</DialogTitle>
            </div>
          )}
          {job !== undefined && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 space-y-2 border-b pt-3 pr-10 pb-2 pl-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <span className="flex items-center gap-1.5 text-foreground">
                    <StatusDot tone={stuck !== "" ? "amber" : JOB_TONE[job.status]} />
                    {JOB_LABEL[job.status] ?? job.status}
                  </span>
                  <span>
                    agent{" "}
                    <a href={`#/agents/${job.agent}`} className="text-primary hover:underline">
                      {agentNames[job.agent] ?? job.agent}
                    </a>
                  </span>
                  {job.vm !== null && (
                    <span>
                      VM{" "}
                      <a href={`#/vms/${job.vm}`} className="text-primary hover:underline">
                        {job.vm}
                      </a>
                    </span>
                  )}
                  {job.issue !== null && (
                    <span className="flex items-center gap-1">
                      <a
                        href={`#/issues?repo=${encodeURIComponent(job.repo ?? "")}&open=${encodeURIComponent(job.issue)}`}
                        className="text-primary hover:underline"
                        title="Open it in Issues"
                      >
                        {job.issue}
                      </a>
                      <a href={`https://github.com/${job.issue.replace("#", "/issues/")}`} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open on GitHub">
                        <ExternalLink className="size-3" />
                      </a>
                    </span>
                  )}
                  {job.thread !== null && (
                    <span className="flex items-center gap-1">
                      <a
                        href={`#/github/${prIds.includes(job.thread) ? "pulls" : "issues"}?open=${encodeURIComponent(job.thread)}`}
                        className="text-primary hover:underline"
                        title="Open it on the GitHub tab"
                      >
                        {job.thread}
                      </a>
                      <a href={`https://github.com/${job.thread.replace("#", "/issues/")}`} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open on GitHub">
                        <ExternalLink className="size-3" />
                      </a>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <DialogTitle className="min-w-0 flex-1 leading-normal">{job.title}</DialogTitle>
                  {isOpenJob && (
                    <Button variant="outline" size="sm" onClick={() => cancelJob(job)}>
                      Cancel job
                    </Button>
                  )}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                <div className="space-y-3 px-4 py-3">
                  <div className="space-y-1.5">
                    <JobSteps job={job} />
                    {job.kind === "fix_issue" && <JobTests job={job} />}
                    {job.about !== "" && <div className="text-muted-foreground">{job.about}</div>}
                    {job.headline !== "" && <div className="font-medium">{job.headline}</div>}
                    {job.headline === "" && isOpenJob && <div className="text-muted-foreground">No progress reported yet.</div>}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                      {job.started_at !== null && <span>Started {since(job.started_at, now)} ago</span>}
                      {job.step !== null && job.step_at !== null && isOpenJob && <span>On this step for {since(job.step_at, now)}</span>}
                      {live && agent.todo_total > 0 && (
                        <span>
                          Todo {agent.todo_done}/{agent.todo_total}
                        </span>
                      )}
                    </div>
                    {live && agent.activity !== "" && (
                      <div className="truncate text-xs text-muted-foreground" title={agent.activity}>
                        Now: {agent.activity}
                        {agent.in_tool && agent.last_event_at !== null && ` · ${since(agent.last_event_at, now)}`}
                      </div>
                    )}
                    {stuck !== "" && <div className="text-xs text-warn">No activity for {stuck}: it may be stuck, or running something slow.</div>}
                    {job.detail !== "" && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground select-none">Technical detail</summary>
                        <div className="mt-1 font-mono whitespace-pre-wrap">{job.detail}</div>
                      </details>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                    <span className="font-mono text-xs">{job.id}</span>
                    <Badge variant="secondary">{job.kind.replaceAll("_", " ")}</Badge>
                    <span>
                      Made by {job.created_by === "user" ? "you" : (agentNames[job.created_by] ?? job.created_by)} on {new Date(job.created_at).toLocaleString()}
                    </span>
                  </div>

                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Instructions</div>
                    <div className="whitespace-pre-wrap">{job.instructions !== "" ? job.instructions : <span className="text-muted-foreground">None.</span>}</div>
                  </div>

                  <div className="border-l-2 border-muted-foreground/30 pl-3">
                    <div className="text-xs font-medium text-muted-foreground">Agent's notes</div>
                    <div className="whitespace-pre-wrap">{job.notes !== "" ? job.notes : <span className="text-muted-foreground">None yet.</span>}</div>
                  </div>

                  <div>
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Drafts</div>
                    {job.drafts.length === 0 && <div className="text-muted-foreground">None yet.</div>}
                    {job.drafts.map((id) => {
                      const draft = drafts[id];
                      return (
                        <a key={id} href={`#/inbox/${id}`} className="group flex min-h-6 items-center gap-2 py-0.5">
                          <StatusDot tone={draft !== undefined ? DRAFT_TONE[draft.status] : "gray"} />
                          <span className="w-16 shrink-0 text-muted-foreground">{draft !== undefined ? (DRAFT_KIND[draft.kind] ?? draft.kind) : "Draft"}</span>
                          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate group-hover:underline">{draft !== undefined ? draft.title : id}</span>
                            {draft !== undefined && <Badge variant="secondary">{draft.status}</Badge>}
                          </span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
