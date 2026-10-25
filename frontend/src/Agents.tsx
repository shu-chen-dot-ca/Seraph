/*
The Agents overview: one row per agent with its name and id (agent_ and 6 hex digits: unique, and it never
changes, also when the agent is renamed; jobs, drafts and VM queues know it by it), where it stands (idle, working, waiting in a VM's queue,
using a VM), its target VM, the job it is on and how far that is, how many open jobs it has, how full
its context is and what it did last. Under an agent with a job: the agent's headline for it in everyday
words, its todo count, how long it has been on this step, and a warning when it has been quiet too long.

Everything comes from the live store (agents and jobs), so the table updates itself while agents work.
Clicking a row opens that agent's page. New agent makes an agent with the next free name ("agent-N")
and opens it. Delete asks first: the agent's conversation goes, its open jobs are cancelled and it leaves
every VM queue (its drafts stay in the Inbox).
*/

import { Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
import { JobProgressBar, currentJob, since, stuckFor, useNow } from "@/components/ui/job-progress";
import { AGENT_TONE, StatusDot } from "@/components/ui/status-dot";
import { api, useLive, useLoaded, type AgentSummary } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[minmax(120px,180px)_96px_190px_100px_minmax(200px,320px)_80px_150px_minmax(0,1fr)_32px] items-center gap-3";

// The bar's full width: the backend compacts the conversation at AGENT_CONTEXT_CAP (500k) tokens,
// or earlier when the model's window is smaller.
const CONTEXT_CAP = 500_000;

const OPEN_STATUSES = ["queued", "working", "waiting_on_user"];

export default function Agents() {
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const loaded = useLoaded("agents");
  // The agent the delete dialog asks about. It stays set while the dialog fades out, so the title doesn't blank.
  const [deleting, setDeleting] = useState<AgentSummary | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const now = useNow();

  // Open jobs per agent.
  const openJobs: Record<string, number> = {};
  for (const job of jobs) {
    if (!OPEN_STATUSES.includes(job.status)) {
      continue;
    }
    openJobs[job.agent] = (openJobs[job.agent] ?? 0) + 1;
  }

  // No name: the backend gives it the next free "agent-N".
  async function createAgent() {
    try {
      const agent = await api<{ id: string }>("/api/agents", { method: "POST", body: { name: "" } });
      window.location.hash = `#/agents/${agent.id}`;
    } catch (err) {
      toast.error(`Could not make an agent: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove(agent: AgentSummary) {
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      toast.success(`Deleted ${agent.name}`);
    } catch (err) {
      toast.error(`Could not delete ${agent.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Button className="ml-auto" size="sm" onClick={createAgent}>
          <Plus /> New agent
        </Button>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span>Name</span>
        <span>ID</span>
        <span>Status</span>
        <span>Target VM</span>
        <span>Job</span>
        <span>Open jobs</span>
        <span>Context</span>
        <span>Activity</span>
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && agents.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            No agents yet. Create one, then tell it what to look for, or give it an issue from the Issues page.
          </div>
        )}

        {agents.map((agent) => {
          const cap = agent.context_max > 0 ? Math.min(agent.context_max, CONTEXT_CAP) : CONTEXT_CAP;
          const percent = Math.min(100, (agent.context_used / cap) * 100);
          const job = currentJob(agent.id, jobs);
          const stuck = stuckFor(agent, now);
          return (
            <div
              key={agent.id}
              className="cursor-pointer border-b px-3 hover:bg-accent/50"
              onClick={() => {
                window.location.hash = `#/agents/${agent.id}`;
              }}
            >
            <div className={cn(COLUMNS, "h-7")}>
              <a href={`#/agents/${agent.id}`} className="truncate font-medium" onClick={(event) => event.stopPropagation()}>
                {agent.name}
              </a>
              <span className="truncate font-mono text-xs text-muted-foreground" title="Its id: unique, and it never changes">
                {agent.id}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusDot tone={stuck !== "" ? "amber" : (AGENT_TONE[agent.status] ?? "gray")} />
                <span className="truncate">
                  {agent.status === "idle" && "idle"}
                  {agent.status === "working" && "working"}
                  {agent.status === "in_queue" && `in queue #${agent.place} · ${agent.vm}`}
                  {agent.status === "using_vm" && `using ${agent.vm}`}
                  {agent.busy && agent.status !== "working" && <span className="text-muted-foreground"> · working</span>}
                </span>
              </span>
              <span className="truncate">
                {agent.target_vm === null && <span className="text-muted-foreground">–</span>}
                {agent.target_vm !== null && (
                  <a href={`#/vms/${agent.target_vm}`} className="text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
                    {agent.target_vm}
                  </a>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                {job === undefined && <span className="text-muted-foreground">–</span>}
                {job !== undefined && (
                  <>
                    <JobProgressBar job={job} className="w-36 shrink-0" />
                    <a href={`#/jobs/${job.id}`} className="truncate hover:underline" title={job.title} onClick={(event) => event.stopPropagation()}>
                      {job.title}
                    </a>
                  </>
                )}
              </span>
              <span className={cn("tabular-nums", (openJobs[agent.id] ?? 0) === 0 && "text-muted-foreground")}>{openJobs[agent.id] ?? 0}</span>
              <span className="flex items-center gap-2" title={`${agent.context_used.toLocaleString()} of ${cap.toLocaleString()} tokens`}>
                <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full", percent > 80 ? "bg-warn" : "bg-muted-foreground/70")} style={{ width: `${percent}%` }} />
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(agent.context_used / 1000)}k / {cap >= 1_000_000 ? `${cap / 1_000_000}M` : `${Math.round(cap / 1000)}k`}
                </span>
              </span>
              <span className="truncate text-muted-foreground" title={agent.activity}>
                {agent.activity}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${agent.name}`}
                title="Delete this agent"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleting(agent);
                  setConfirmOpen(true);
                }}
              >
                <X />
              </Button>
            </div>
            {job !== undefined && (job.headline !== "" || stuck !== "" || (agent.busy && agent.todo_total > 0)) && (
              <div className="flex min-w-0 items-center gap-3 pb-1.5 pl-[300px] text-xs text-muted-foreground tabular-nums">
                {job.headline !== "" && (
                  <span className="truncate text-foreground/80" title={job.headline}>
                    {job.headline}
                  </span>
                )}
                {agent.busy && agent.todo_total > 0 && (
                  <span className="shrink-0">
                    todo {agent.todo_done}/{agent.todo_total}
                  </span>
                )}
                {job.status === "working" && job.step_at !== null && <span className="shrink-0">step {since(job.step_at, now)}</span>}
                {stuck !== "" && <span className="shrink-0 text-warn">no activity for {stuck}</span>}
              </div>
            )}
            </div>
          );
        })}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its conversation is deleted, its open jobs are cancelled and it leaves every VM queue. Its drafts stay in the Inbox.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting !== null) {
                  remove(deleting);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
