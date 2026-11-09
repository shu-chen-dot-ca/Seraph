/*
The Agents overview: one row per agent with its name and id (agent_ and 6 hex digits: unique, and it never
changes, also when the agent is renamed; jobs, drafts and VM queues know it by it), where it stands (idle, working, waiting in a VM's queue,
using a VM), its target VM, the job it is on and how far that is, how many open jobs it has, how full
its context is and what it did last. Under an agent with a job: the agent's headline for it in everyday
words, its todo count, how long it has been on this step, and a warning when it has been quiet too long.

Everything comes from the live store (agents and jobs), so the table updates itself while agents work.
Clicking a row opens that agent's page. New agent makes an agent with the next free name ("agent-N")
and opens it. Each row's ⋯ menu has Archive and Delete, both asking first. Archive stops the agent, cancels
its open jobs and takes it out of every VM queue, but keeps its conversation; Delete also deletes the
conversation (its drafts stay in the Inbox). An agent that made PRs can't be deleted, only archived, so
it keeps its context for updates on them.

Archived agents are in their own list under the others (it folds), with when they were archived and how
many PRs they made; Unarchive in their menu brings one back, and so does sending it a message or a job.

Many agents are picked like on the Repos page. Hovering a row shows its box on the left; ticking it picks that agent
and turns on select mode, like Select (top right) does: Delete and Archive show on the left of the bar, Select stays
lit (a click on it ends select mode), every row shows its box, and a click (also on the name) picks the row instead of
opening it. The box at the top left of the table's header picks every row shown (checked when all are, a dash when
some are); a click when all are picked unpicks them.
Rows are also picked like in a mail app (components/ui/row-selection.tsx): Ctrl-click, Shift-click, dragging a
rectangle, Ctrl+A, which turns on select mode too; a bar at the bottom says how many. Archived agents can be picked
while their list is open. Delete and Archive ask first (Enter confirms), then do every picked agent; Delete leaves out
the ones that made PRs (the question says how many stay: archive those), Archive the ones archived already. Clearing
the selection (Escape, the bar's x) ends select mode too.
*/

import { Archive, ArchiveRestore, ChevronRight, MoreHorizontal, Plus, SquareCheck, Trash2 } from "lucide-react";
import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { JobProgressBar, currentJob, since, stuckFor, useNow } from "@/components/ui/job-progress";
import { RowSelection, SelectBox } from "@/components/ui/row-selection";
import { AGENT_TONE, StatusDot } from "@/components/ui/status-dot";
import { api, useLive, useLoaded, type AgentSummary } from "@/live";
import { cn } from "@/lib/utils";

// The box (picking the row), then the columns. Phone mode (App.tsx) keeps the box, Name, Status and the menu.
const COLUMNS =
  "grid grid-cols-[16px_minmax(120px,180px)_96px_190px_100px_minmax(200px,320px)_80px_150px_minmax(0,1fr)_32px] items-center gap-3 max-md:grid-cols-[16px_minmax(0,1fr)_minmax(0,1.5fr)_32px]";

// The bar's full width: the backend compacts the conversation at AGENT_CONTEXT_CAP (500k) tokens,
// or earlier when the model's window is smaller.
const CONTEXT_CAP = 500_000;

const OPEN_STATUSES = ["queued", "working", "waiting_on_user", "waiting_on_maintainers"];

export default function Agents() {
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const loaded = useLoaded("agents");
  // The agents the dialog asks about (one from a row's menu, or the picked ones), whether to archive or delete them,
  // and how many picked ones Delete leaves out (they made PRs). It stays set while the dialog fades out, so the title
  // doesn't blank.
  const [confirming, setConfirming] = useState<{ agents: AgentSummary[]; action: "archive" | "delete"; kept: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(true);
  // Picked agents (by id), the last one clicked (where a shift-click range starts), and select mode.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const active = agents.filter((agent) => agent.archived_at === null);
  const archived = agents.filter((agent) => agent.archived_at !== null);
  const now = useNow();

  // The rows shown, in order (archived ones only while their list is open). Only agents still there count as picked.
  const rowIds = [...active.map((agent) => agent.id), ...(archivedOpen ? archived.map((agent) => agent.id) : [])];
  const chosen = selected.filter((id) => agents.some((agent) => agent.id === id));
  const chosenAgents = agents.filter((agent) => chosen.includes(agent.id));
  // What the bar's Delete and Archive would do: Delete not the ones that made PRs, Archive not the archived ones.
  const deletable = chosenAgents.filter((agent) => agent.prs === 0);
  const archivable = chosenAgents.filter((agent) => agent.archived_at === null);
  const selectMode = selecting || chosen.length > 0;
  const allPicked = rowIds.length > 0 && rowIds.every((id) => chosen.includes(id));

  // A ctrl-click picks or unpicks one row; a shift-click does the same to every row shown from the last one clicked.
  function select(id: string, shift: boolean) {
    const on = !chosen.includes(id);
    let ids = [id];
    if (shift && anchor !== null && rowIds.includes(anchor)) {
      const from = rowIds.indexOf(anchor);
      const to = rowIds.indexOf(id);
      ids = rowIds.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !ids.includes(each)), ...ids] : chosen.filter((each) => !ids.includes(each)));
    setAnchor(id);
  }

  // Clearing the selection (Escape, the bar's x, a click on the list's empty space) also ends select mode.
  function onSelect(ids: string[]) {
    setSelected(ids);
    if (ids.length === 0) {
      setSelecting(false);
    }
  }

  // A row's click: in select mode (or with Ctrl / Shift) it picks the row, else it opens the agent.
  function clickRow(event: ReactMouseEvent, id: string) {
    if (selectMode || event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault();
      select(id, event.shiftKey);
      return;
    }
    window.location.hash = `#/agents/${id}`;
  }

  function ask(list: AgentSummary[], action: "archive" | "delete", kept: number) {
    setConfirming({ agents: list, action: action, kept: kept });
    setConfirmOpen(true);
  }

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

  // One after another; the selection ends after.
  async function remove(list: AgentSummary[]) {
    let done = 0;
    for (const agent of list) {
      try {
        await api(`/api/agents/${agent.id}`, { method: "DELETE" });
        done += 1;
      } catch (err) {
        toast.error(`Could not delete ${agent.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (done > 0) {
      toast.success(list.length === 1 ? `Deleted ${list[0].name}` : `Deleted ${done} agents`);
    }
    setSelected([]);
    setSelecting(false);
  }

  async function archive(list: AgentSummary[]) {
    let done = 0;
    for (const agent of list) {
      try {
        await api(`/api/agents/${agent.id}/archive`, { method: "POST" });
        done += 1;
      } catch (err) {
        toast.error(`Could not archive ${agent.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (done > 0) {
      toast.success(list.length === 1 ? `Archived ${list[0].name}` : `Archived ${done} agents`);
    }
    setSelected([]);
    setSelecting(false);
  }

  async function unarchive(agent: AgentSummary) {
    try {
      await api(`/api/agents/${agent.id}/unarchive`, { method: "POST" });
      toast.success(`${agent.name} is back`);
    } catch (err) {
      toast.error(`Could not unarchive ${agent.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // The box at the start of a row: out of select mode only on hover. Ticking it picks the agent, which turns select
  // mode on.
  function rowBox(agent: AgentSummary) {
    return (
      <button
        type="button"
        className={cn("flex h-7 items-center", !selectMode && "invisible group-hover:visible")}
        aria-label={`Select ${agent.name}`}
        onClick={(event) => {
          event.stopPropagation();
          select(agent.id, event.shiftKey);
        }}
      >
        <SelectBox checked={chosen.includes(agent.id)} />
      </button>
    );
  }

  // The ⋯ menu at the end of a row: Archive or Unarchive, then Delete (not for an agent that made PRs).
  function rowMenu(agent: AgentSummary) {
    return (
      <span onClick={(event) => event.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${agent.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {agent.archived_at === null && (
              <DropdownMenuItem onSelect={() => ask([agent], "archive", 0)}>
                <Archive /> Archive
              </DropdownMenuItem>
            )}
            {agent.archived_at !== null && (
              <DropdownMenuItem onSelect={() => unarchive(agent)}>
                <ArchiveRestore /> Unarchive
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={agent.prs > 0}
              onSelect={() => ask([agent], "delete", 0)}
            >
              <Trash2 /> Delete
              {agent.prs > 0 && <span className="ml-auto text-xs">made PRs: archive it</span>}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
        {/* What to do with the picked agents, on the left while in select mode. */}
        {selectMode && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={deletable.length === 0}
              title={deletable.length === 0 ? "Pick agents that made no PRs (one that did can only be archived)" : `Delete the ${deletable.length} picked agents that made no PRs`}
              onClick={() => ask(deletable, "delete", chosenAgents.length - deletable.length)}
            >
              <Trash2 /> Delete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={archivable.length === 0}
              title={archivable.length === 0 ? "Pick agents that aren't archived" : `Archive the ${archivable.length} picked agents that aren't archived`}
              onClick={() => ask(archivable, "archive", 0)}
            >
              <Archive /> Archive
            </Button>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant={selectMode ? "secondary" : "ghost"} size="sm"
            disabled={!selectMode && rowIds.length === 0}
            title={selectMode ? "Stop selecting (Esc)" : "Pick rows: every row shows its box, and a click picks it"}
            onClick={() => (selectMode ? onSelect([]) : setSelecting(true))}
          >
            <SquareCheck /> Select
          </Button>
          <Button size="sm" onClick={createAgent}>
            <Plus /> New agent
          </Button>
        </span>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        {/* Top left: picks every agent shown, or none when all are; a dash when only some are. */}
        <button
          type="button"
          className="flex items-center"
          aria-label={allPicked ? "Unselect all" : "Select all"}
          title={allPicked ? "Unselect all" : "Select all (Ctrl+A)"}
          disabled={rowIds.length === 0}
          onClick={() => (allPicked ? onSelect([]) : setSelected(rowIds))}
        >
          <SelectBox checked={allPicked} partial={chosen.length > 0} />
        </button>
        <span>Name</span>
        <span className="max-md:hidden">ID</span>
        <span>Status</span>
        <span className="max-md:hidden">Target VM</span>
        <span className="max-md:hidden">Job</span>
        <span className="max-md:hidden">Open jobs</span>
        <span className="max-md:hidden">Context</span>
        <span className="max-md:hidden">Activity</span>
        <span />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && active.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            {archived.length === 0 ? "No agents yet." : "No agents at work."} Create one, then tell it what to look for, or give it an issue from the Issues page.
          </div>
        )}

        {active.map((agent) => {
          const cap = agent.context_max > 0 ? Math.min(agent.context_max, CONTEXT_CAP) : CONTEXT_CAP;
          const percent = Math.min(100, (agent.context_used / cap) * 100);
          const job = currentJob(agent.id, jobs);
          const stuck = stuckFor(agent, now);
          return (
            <div
              key={agent.id}
              data-select-id={agent.id}
              className={cn("group cursor-pointer border-b px-3 hover:bg-accent/50", chosen.includes(agent.id) && "bg-selected hover:bg-selected")}
              onClick={(event) => clickRow(event, agent.id)}
            >
            <div className={cn(COLUMNS, "h-7")}>
              {rowBox(agent)}
              <a
                href={`#/agents/${agent.id}`}
                className="truncate font-medium"
                onClick={(event) => {
                  event.stopPropagation();
                  clickRow(event, agent.id);
                }}
              >
                {agent.name}
              </a>
              <span className="truncate font-mono text-xs text-muted-foreground max-md:hidden" title="Its id: unique, and it never changes">
                {agent.id}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusDot tone={stuck !== "" ? "amber" : (AGENT_TONE[agent.status] ?? "gray")} />
                <span className="truncate">
                  {agent.status === "idle" && "idle"}
                  {agent.status === "working" && "working"}
                  {agent.status === "in_queue" && `in queue #${agent.place} · ${agent.vm}`}
                  {agent.status === "using_vm" && `using ${agent.vm} · desktop ${agent.desktop}`}
                  {agent.busy && agent.status !== "working" && <span className="text-muted-foreground"> · working</span>}
                </span>
              </span>
              <span className="truncate max-md:hidden">
                {agent.target_vm === null && <span className="text-muted-foreground">–</span>}
                {agent.target_vm !== null && (
                  <a href={`#/vms/${agent.target_vm}`} className="text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
                    {agent.target_vm}
                  </a>
                )}
              </span>
              <span className="flex min-w-0 items-center gap-2 max-md:hidden">
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
              <span className={cn("tabular-nums max-md:hidden", (openJobs[agent.id] ?? 0) === 0 && "text-muted-foreground")}>{openJobs[agent.id] ?? 0}</span>
              <span className="flex items-center gap-2 max-md:hidden" title={`${agent.context_used.toLocaleString()} of ${cap.toLocaleString()} tokens`}>
                <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full", percent > 80 ? "bg-warn" : "bg-muted-foreground/70")} style={{ width: `${percent}%` }} />
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {Math.round(agent.context_used / 1000)}k / {cap >= 1_000_000 ? `${cap / 1_000_000}M` : `${Math.round(cap / 1000)}k`}
                </span>
              </span>
              <span className="truncate text-muted-foreground max-md:hidden" title={agent.activity}>
                {agent.activity}
              </span>
              {rowMenu(agent)}
            </div>
            {job !== undefined && (job.headline !== "" || stuck !== "" || (agent.busy && agent.todo_total > 0)) && (
              <div className="flex min-w-0 items-center gap-3 pb-1.5 pl-[328px] text-xs max-md:pl-7 text-muted-foreground tabular-nums">
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

        {archived.length > 0 && (
          <button
            type="button"
            className="flex h-7 w-full items-center gap-1 border-b bg-muted/40 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen(!archivedOpen)}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", archivedOpen && "rotate-90")} />
            Archived
            <span className="ml-0.5 tabular-nums">{archived.length}</span>
          </button>
        )}
        {archivedOpen &&
          archived.map((agent) => (
            <div
              key={agent.id}
              data-select-id={agent.id}
              className={cn(
                COLUMNS,
                "group h-7 cursor-pointer border-b px-3 text-muted-foreground hover:bg-accent/50",
                chosen.includes(agent.id) && "bg-selected hover:bg-selected",
              )}
              onClick={(event) => clickRow(event, agent.id)}
            >
              {rowBox(agent)}
              <a
                href={`#/agents/${agent.id}`}
                className="truncate font-medium text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  clickRow(event, agent.id);
                }}
              >
                {agent.name}
              </a>
              <span className="truncate font-mono text-xs max-md:hidden" title="Its id: unique, and it never changes">
                {agent.id}
              </span>
              <span className="truncate">archived {agent.archived_at !== null ? new Date(agent.archived_at).toLocaleDateString() : ""}</span>
              <span className="truncate max-md:hidden">{agent.target_vm ?? "–"}</span>
              <span className="truncate max-md:hidden">{agent.prs > 0 ? `${agent.prs} PR${agent.prs > 1 ? "s" : ""}: it keeps its context for updates` : "–"}</span>
              <span className="max-md:hidden" />
              <span className="text-xs tabular-nums max-md:hidden">{Math.round(agent.context_used / 1000)}k</span>
              <span className="truncate max-md:hidden" title={agent.activity}>
                {agent.activity}
              </span>
              {rowMenu(agent)}
            </div>
          ))}
      </div>

      {/* Only the count and Select all: Delete and Archive are in the bar on top. */}
      <RowSelection listRef={listRef} ids={rowIds} selected={chosen} onSelect={onSelect} />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.action === "archive" ? "Archive" : "Delete"}{" "}
              {confirming !== null && confirming.agents.length === 1 ? confirming.agents[0].name : `${confirming?.agents.length} agents`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming !== null && confirming.agents.length === 1 && confirming.action === "archive" &&
                "It stops, its open jobs are cancelled and it leaves every VM queue. Its conversation stays: it is under Archived here, and a message or a job brings it back."}
              {confirming !== null && confirming.agents.length === 1 && confirming.action === "delete" &&
                "Its conversation is deleted, its open jobs are cancelled and it leaves every VM queue. Its drafts stay in the Inbox."}
              {confirming !== null && confirming.agents.length > 1 && confirming.action === "archive" &&
                "They stop, their open jobs are cancelled and they leave every VM queue. Their conversations stay: they are under Archived here, and a message or a job brings one back."}
              {confirming !== null && confirming.agents.length > 1 && confirming.action === "delete" &&
                "Their conversations are deleted, their open jobs are cancelled and they leave every VM queue. Their drafts stay in the Inbox."}
              {confirming !== null && confirming.kept > 0 &&
                ` ${confirming.kept} picked ${confirming.kept === 1 ? "agent made PRs and stays" : "agents made PRs and stay"}: archive those instead.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirming?.action === "archive" ? "default" : "destructive"}
              onClick={() => {
                if (confirming !== null && confirming.action === "archive") {
                  archive(confirming.agents);
                }
                if (confirming !== null && confirming.action === "delete") {
                  remove(confirming.agents);
                }
              }}
            >
              {confirming?.action === "archive" ? "Archive" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
