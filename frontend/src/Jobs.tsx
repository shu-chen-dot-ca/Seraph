/*
The Jobs list: every job of every agent, and the place to make new ones.

A job comes from Assign on the Issues page (kind fix_issue), from New job here (kind task), or from an
agent itself (job_create). Tabs filter by status; "Open" is everything not done or cancelled, the most
recently changed first. Each row shows its progress (the step the agent is on) and, under the title, the
agent's headline in everyday words. Rows open in place: every step, what the job is about, the technical
detail, the project's test suite runs (before and with the change), what the agent is doing right now, the instructions, the agent's notes and the drafts it made,
each linking to the Inbox. #/jobs/<job id> opens with that job's row open.
Only the rows on screen are drawn, so long lists stay fast.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ExternalLink, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import NewJobDialog from "@/NewJobDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JobProgressBar, JobSteps, JobTests, since, stuckFor, useNow } from "@/components/ui/job-progress";
import { DRAFT_TONE, JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type AgentSummary, type Job } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[16px_120px_165px_minmax(0,1fr)_110px_70px_190px_120px_64px] items-center gap-2";

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
  const loaded = useLoaded("jobs");
  const [tab, setTab] = useState(props.selected !== null ? "all" : "open");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string[]>(props.selected !== null ? [props.selected] : []);
  const [creating, setCreating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const now = useNow();

  const agentNames: Record<string, string> = {};
  const agentById: Record<string, AgentSummary> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
    agentById[agent.id] = agent;
  }
  const drafts: Record<string, { kind: string; status: string; title: string }> = {};
  for (const draft of inbox) {
    drafts[draft.id] = { kind: draft.kind, status: draft.status, title: draft.title };
  }

  const tabCounts: Record<string, number> = {};
  for (const item of TABS) {
    tabCounts[item.value] = jobs.filter((job) => item.value === "all" || item.statuses.includes(job.status)).length;
  }
  const tabStatuses = TABS.find((item) => item.value === tab)?.statuses ?? [];
  const needle = filter.trim().toLowerCase();
  const rows = jobs
    .filter((job) => {
      if (tab !== "all" && !tabStatuses.includes(job.status)) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const text = `${job.id} ${job.title} ${job.issue ?? ""} ${job.vm ?? ""} ${agentNames[job.agent] ?? ""} ${job.instructions} ${job.notes}`.toLowerCase();
      return text.includes(needle);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 10,
    getItemKey: (index) => rows[index].id,
  });

  function toggle(id: string) {
    if (open.includes(id)) {
      setOpen(open.filter((other) => other !== id));
      return;
    }
    setOpen([...open, id]);
  }

  async function cancelJob(job: Job) {
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not cancel ${job.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <h1 className="font-semibold">Jobs</h1>
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
        <Input className="ml-auto w-52" placeholder="Filter jobs" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New job
        </Button>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>Status</span>
        <span>Progress</span>
        <span>Job</span>
        <span>Agent</span>
        <span>VM</span>
        <span>Issue</span>
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
            const job = rows[item.index];
            const isOpen = open.includes(job.id);
            const isOpenJob = OPEN.includes(job.status);
            const agent = agentById[job.agent];
            // What the agent does right now, only for the job it is working on in this turn.
            const live = agent !== undefined && agent.busy && job.status === "working";
            const stuck = live ? stuckFor(agent, now) : "";
            return (
              <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="absolute left-0 w-full border-b" style={{ top: item.start }}>
                <div
                  className={cn(COLUMNS, "min-h-7 cursor-pointer px-3 hover:bg-accent/50", isOpenJob && job.headline !== "" && "py-1", isOpen && "bg-accent/40")}
                  onClick={() => toggle(job.id)}
                >
                  <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="flex items-center gap-1.5">
                    <StatusDot tone={stuck !== "" ? "amber" : JOB_TONE[job.status]} />
                    {JOB_LABEL[job.status] ?? job.status}
                  </span>
                  <JobProgressBar job={job} />
                  <span className="min-w-0">
                    <span className={cn("block truncate", !isOpenJob && "text-muted-foreground")}>{job.title}</span>
                    {isOpenJob && job.headline !== "" && (
                      <span className="block truncate text-xs text-muted-foreground" title={job.headline}>
                        {job.headline}
                      </span>
                    )}
                  </span>
                  <a href={`#/agents/${job.agent}`} className="truncate hover:underline" onClick={(event) => event.stopPropagation()}>
                    {agentNames[job.agent] ?? job.agent}
                  </a>
                  <span className="truncate">
                    {job.vm !== null && (
                      <a href={`#/vms/${job.vm}`} className="hover:underline" onClick={(event) => event.stopPropagation()}>
                        {job.vm}
                      </a>
                    )}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {job.issue !== null && (
                      <span className="flex items-center gap-1">
                        <a
                          href={`#/issues?repo=${encodeURIComponent(job.repo ?? "")}&open=${encodeURIComponent(job.issue)}`}
                          className="truncate hover:text-foreground hover:underline"
                          title="Open it in Issues"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {job.issue}
                        </a>
                        <a
                          href={`https://github.com/${job.issue.replace("#", "/issues/")}`}
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
                  <span className="truncate text-xs whitespace-nowrap text-muted-foreground tabular-nums">{new Date(job.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                  <span className="flex justify-end">
                    {isOpenJob && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          cancelJob(job);
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </span>
                </div>

                {isOpen && (
                  <div className="space-y-3 border-t bg-muted/30 px-9 py-3">
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
                      <Badge variant="secondary">{job.kind === "fix_issue" ? "fix issue" : job.kind}</Badge>
                      <span>
                        Made by {job.created_by === "user" ? "you" : (agentNames[job.created_by] ?? job.created_by)} on {new Date(job.created_at).toLocaleString()}
                      </span>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-muted-foreground">Instructions</div>
                      <div className="whitespace-pre-wrap">{job.instructions !== "" ? job.instructions : <span className="text-muted-foreground">None.</span>}</div>
                    </div>

                    <div className="border-l-2 border-primary pl-3">
                      <div className="text-xs font-medium text-muted-foreground">Agent's notes</div>
                      <div className="whitespace-pre-wrap">{job.notes !== "" ? job.notes : <span className="text-muted-foreground">None yet.</span>}</div>
                    </div>

                    <div>
                      <div className="mb-1 text-xs font-medium text-muted-foreground">Drafts</div>
                      {job.drafts.length === 0 && <div className="text-muted-foreground">None yet.</div>}
                      {job.drafts.map((id) => {
                        const draft = drafts[id];
                        return (
                          <a key={id} href={`#/inbox/${id}`} className="flex h-6 items-center gap-2 hover:underline">
                            <StatusDot tone={draft !== undefined ? DRAFT_TONE[draft.status] : "gray"} />
                            <span className="w-16 shrink-0 text-muted-foreground">{draft !== undefined ? (DRAFT_KIND[draft.kind] ?? draft.kind) : "Draft"}</span>
                            <span className="truncate">{draft !== undefined ? draft.title : id}</span>
                            {draft !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{draft.status}</span>}
                          </a>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {creating && <NewJobDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
