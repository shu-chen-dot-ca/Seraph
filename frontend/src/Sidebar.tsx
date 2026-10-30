/*
The left tree, like Proxmox's resource tree. Every line is a link to a page, in the order the work flows, in three parts:
- finding work: Explore (the search for new repos; shows how many found repos wait for the user's approve or remove, with a green dot while a run
  goes), Repos, Tracked (new issues in the repos the user keeps an eye on), Issues
  (one child per issue an agent is on now: its latest job queued, working or waiting on you, waiting on you first;
  each with the issue's number and the job's progress bar and step, like the Issues page's Status column; hover for
  its repo, title, agent and the agent's headline; a click opens the issue in a pop-up on the Issues page);
- doing it, under a line: Jobs (open / all), Agents (one child per agent), then under another line VMs (one child per VM);
- the computer, under another line: Resource (this computer's CPU, memory, GPUs, disk, network and battery,
  Resource.tsx);
- pinned at the bottom: Inbox, GitHub (your PRs on GitHub and how each stands, your comments and your account, with how
  many PRs are open; GitHub.tsx) and Settings (below).
Counts and status dots come straight from the live store, so the tree updates itself.
The chevrons only fold Issues / Agents / VMs; clicking a name opens that page.
Hovering Jobs, Agents or VMs fades its count into a + that makes a new one right there:
New job opens NewJobDialog, + on Agents makes an agent with the next free name (agent-N) and opens it, + on VMs
opens NewVMDialog.
Each agent and VM line, like a chat in claude.ai's sidebar, fades its status into a ⋯ on hover: its menu has Rename
(a small dialog) and Delete (asks first), and for an agent Archive (asks first). Deleting the one whose page is open
goes back to its list. Archived agents aren't listed here (they are on the Agents page); an agent that made PRs
can only be archived, not deleted.
Inbox (pending drafts), GitHub (open PRs) and Settings stay pinned at the bottom while the tree scrolls; Settings opens SettingsDialog
(theme and accent color), which App owns.
*/

import { Archive, Bot, ChevronRight, CircleDot, Compass, Eye, FolderGit2, Gauge, Inbox, ListTodo, Monitor, MoreHorizontal, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import NewJobDialog from "@/NewJobDialog";
import NewVMDialog from "@/NewVMDialog";

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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { JobProgressBar } from "@/components/ui/job-progress";
import { AGENT_TONE, JOB_LABEL, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { api, useLive, useLiveValue, type IssueItem, type Job } from "@/live";
import { cn } from "@/lib/utils";

export default function Sidebar(props: { page: string; id: string | null; onOpenSettings: () => void }) {
  const [issuesOpen, setIssuesOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [vmsOpen, setVMsOpen] = useState(true);
  const [newJob, setNewJob] = useState(false);
  const [newVM, setNewVM] = useState(false);
  // The agent or VM its ⋯ menu acts on (a VM's id is its name). It stays set while a dialog fades out, so the title doesn't blank.
  const [target, setTarget] = useState<{ kind: "agent" | "vm"; id: string; name: string } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  // What the confirm dialog does to the agent: delete it, or archive it.
  const [confirmAction, setConfirmAction] = useState<"delete" | "archive">("delete");
  const inbox = useLive("inbox");
  const issues = useLive("issues");
  const jobs = useLive("jobs");
  const repos = useLive("repos");
  const tracked = useLive("tracked");
  const agents = useLive("agents");
  // Archived agents are on the Agents page only.
  const activeAgents = agents.filter((agent) => agent.archived_at === null);
  const vms = useLive("vms");
  // Only what the row shows: the explore topic changes many times a second while a run goes.
  const exploreRunning = useLiveValue((topics) => topics.explore.run !== null && topics.explore.run.status === "running");
  const exploreWaiting = useLiveValue((topics) => topics.explore.found.length);

  const pending = inbox.filter((draft) => draft.status === "pending").length;
  // Only the count: the PRs topic changes whenever a PR is read again.
  const openPRs = useLiveValue((topics) => topics.prs.items.filter((pr) => pr.state === "open").length);
  const running = vms.filter((vm) => vm.status === "running").length;
  // Issues opened in tracked repos in the last three days and not marked read (the Tracked page's Mark all as read).
  const newSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let trackedNew = 0;
  for (const repo of tracked.items) {
    const check = repo.check;
    if (check !== null) {
      const read = check.read ?? [];
      trackedNew += check.issues.filter((issue) => new Date(issue.created_at).getTime() > newSince && !read.includes(issue.number)).length;
    }
  }
  const openJobs = jobs.filter((job) => job.status === "queued" || job.status === "working" || job.status === "waiting_on_user").length;

  // The issues an agent is on now, under Issues: those whose latest job is waiting on you, then working, then queued.
  const latestJob: Record<string, Job> = {};
  for (const job of jobs) {
    if (job.issue === null) {
      continue;
    }
    const current = latestJob[job.issue];
    if (current === undefined || job.created_at > current.created_at) {
      latestJob[job.issue] = job;
    }
  }
  const activeIssues: { issue: IssueItem; job: Job }[] = [];
  for (const status of ["waiting_on_user", "working", "queued"]) {
    for (const issue of issues.items) {
      const job = latestJob[issue.id];
      if (job !== undefined && job.status === status) {
        activeIssues.push({ issue, job });
      }
    }
  }
  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
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

  async function rename() {
    if (target === null || renameBusy) {
      return;
    }
    const name = newName.trim();
    if (name === target.name) {
      setRenameOpen(false);
      return;
    }
    const path = target.kind === "agent" ? `/api/agents/${target.id}/rename` : `/api/vms/${encodeURIComponent(target.id)}/rename`;
    setRenameBusy(true);
    setRenameError("");
    try {
      await api(path, { method: "POST", body: { name: name } });
      setRenameOpen(false);
      // The open VM's page moves to the new name. An agent's page is by id, so it stays.
      if (target.kind === "vm" && props.page === "vms" && props.id === target.id) {
        window.location.hash = `#/vms/${encodeURIComponent(name)}`;
      }
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err));
    }
    setRenameBusy(false);
  }

  async function archive() {
    if (target === null) {
      return;
    }
    try {
      await api(`/api/agents/${target.id}/archive`, { method: "POST" });
      toast.success(`Archived ${target.name}. It is under Archived on the Agents page.`);
    } catch (err) {
      toast.error(`Could not archive ${target.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function remove() {
    if (target === null) {
      return;
    }
    const path = target.kind === "agent" ? `/api/agents/${target.id}` : `/api/vms/${encodeURIComponent(target.id)}`;
    const list = target.kind === "agent" ? "agents" : "vms";
    // A VM takes a few seconds to delete.
    const toastId = toast.loading(`Deleting ${target.name}…`);
    try {
      await api(path, { method: "DELETE" });
      toast.success(`Deleted ${target.name}`, { id: toastId });
      // Its page is gone: back to the list.
      if (props.page === list && props.id === target.id) {
        window.location.hash = `#/${list}`;
      }
    } catch (err) {
      toast.error(`Could not delete ${target.name}: ${err instanceof Error ? err.message : err}`, { id: toastId });
    }
  }

  // Rows like OpenClaw's nav: 32px, rounded, a step quieter than the page until hovered or open. Hovering in is
  // instant and only leaving fades (index.css), so picking a page shows at once.
  const row = "flex h-8 items-center gap-2 rounded-md px-2 font-medium hover:bg-sidebar-accent hover:text-foreground";
  // The count fades out and the + fades in, in the same spot, while the row is hovered or the + has focus.
  const count = "ml-auto text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0";
  const plus =
    "absolute right-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100";
  // An agent or VM line the same way: its status fades into the ⋯, which stays (and the line stays lit) while its menu is open.
  const status =
    "ml-auto text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-has-[[data-state=open]]:opacity-0";
  const more = cn(plus, "data-[state=open]:bg-accent data-[state=open]:text-foreground data-[state=open]:opacity-100");
  const child = cn(row, "group relative p-0 has-[[data-state=open]]:bg-sidebar-accent");

  // The open page: an accent wash, and its icon in the accent (the icon is the row's first svg, or its link's).
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>a>svg]:text-primary [&>svg]:text-primary";

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <a
          href="#/explore"
          className={cn(row, "pl-6", props.page === "explore" && selected)}
          title={`${exploreWaiting} found repos wait for your approve or remove${exploreRunning ? "; Explore is running" : ""}`}
        >
          <Compass className="size-4 text-muted-foreground" />
          Explore
          <span className={cn("ml-auto flex items-center gap-1.5 tabular-nums", exploreWaiting > 0 ? "font-medium text-primary" : "text-muted-foreground")}>
            {exploreRunning && <StatusDot tone="green" />}
            {exploreWaiting}
          </span>
        </a>

        <a href="#/repos" className={cn(row, "pl-6", props.page === "repos" && selected)}>
          <FolderGit2 className="size-4 text-muted-foreground" />
          Repos
          <span className="ml-auto text-muted-foreground tabular-nums">{repos.items.length}</span>
        </a>

        <a
          href="#/tracked"
          className={cn(row, "pl-6", props.page === "tracked" && selected)}
          title={trackedNew > 0 ? `${trackedNew} issues opened in the last 3 days and not marked read, in ${tracked.items.length} tracked repos` : `${tracked.items.length} tracked repos`}
        >
          <Eye className="size-4 text-muted-foreground" />
          Tracked
          {trackedNew > 0 ? (
            <span className="ml-auto font-medium text-primary tabular-nums">{trackedNew} new</span>
          ) : (
            <span className="ml-auto text-muted-foreground tabular-nums">{tracked.items.length}</span>
          )}
        </a>

        <div className={cn(row, "gap-0 px-0", props.page === "issues" && selected)}>
          <button
            type="button"
            className="flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground"
            aria-label={issuesOpen ? "Fold active issues" : "Unfold active issues"}
            onClick={() => setIssuesOpen(!issuesOpen)}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", issuesOpen && "rotate-90")} />
          </button>
          <a href="#/issues" className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2">
            <CircleDot className="size-4 text-muted-foreground" />
            Issues
            <span className="ml-auto text-muted-foreground tabular-nums">{issues.items.length}</span>
          </a>
        </div>
        {issuesOpen &&
          activeIssues.map(({ issue, job }) => {
            const agentName = agentNames[job.agent] ?? job.agent;
            const step = job.step !== null ? `, ${job.step.replace(/_/g, " ")}` : "";
            const headline = job.headline !== "" ? `\n${job.headline}` : "";
            return (
              <a
                key={issue.id}
                href={`#/issues?open=${encodeURIComponent(issue.id)}`}
                className={cn(row, "pl-6")}
                title={`${issue.id}: ${issue.facts?.title ?? issue.title}\n${agentName}: ${JOB_LABEL[job.status] ?? job.status}${step}${headline}`}
              >
                <span className="shrink-0 text-muted-foreground tabular-nums">#{issue.number}</span>
                <JobProgressBar job={job} />
              </a>
            );
          })}

        {/* The work: what runs (jobs), who runs it (agents) and where (VMs). */}
        <div className="mx-1 my-2 border-t" />

        <div className={cn(row, "group relative p-0", props.page === "jobs" && selected)}>
          <a href="#/jobs" className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2 pl-6">
            <ListTodo className="size-4 text-muted-foreground" />
            Jobs
            <span className={count}>
              {openJobs}/{jobs.length}
            </span>
          </a>
          <button type="button" className={plus} aria-label="New job" title="New job" onClick={() => setNewJob(true)}>
            <Plus className="size-3.5" />
          </button>
        </div>

        <div className={cn(row, "group relative gap-0 px-0", props.page === "agents" && props.id === null && selected)}>
          <button
            type="button"
            className="flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground"
            aria-label={agentsOpen ? "Fold agents" : "Unfold agents"}
            onClick={() => setAgentsOpen(!agentsOpen)}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", agentsOpen && "rotate-90")} />
          </button>
          <a href="#/agents" className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2">
            <Bot className="size-4 text-muted-foreground" />
            Agents
            <span className={count}>{activeAgents.length}</span>
          </a>
          <button type="button" className={plus} aria-label="New agent" title="New agent" onClick={createAgent}>
            <Plus className="size-3.5" />
          </button>
        </div>
        {agentsOpen &&
          activeAgents.map((agent) => (
            <div key={agent.id} className={cn(child, props.page === "agents" && props.id === agent.id && selected)}>
              <a href={`#/agents/${agent.id}`} className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2 pl-6" title={agent.activity}>
                <StatusDot tone={AGENT_TONE[agent.status]} />
                <span className="truncate">{agent.name}</span>
                {agent.status === "in_queue" && <span className={status}>#{agent.place}</span>}
              </a>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={more} aria-label={`Actions for ${agent.name}`}>
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => {
                      setTarget({ kind: "agent", id: agent.id, name: agent.name });
                      setNewName(agent.name);
                      setRenameError("");
                      setRenameOpen(true);
                    }}
                  >
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setTarget({ kind: "agent", id: agent.id, name: agent.name });
                      setConfirmAction("archive");
                      setDeleteOpen(true);
                    }}
                  >
                    <Archive /> Archive
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={agent.prs > 0}
                    onSelect={() => {
                      setTarget({ kind: "agent", id: agent.id, name: agent.name });
                      setConfirmAction("delete");
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 /> Delete
                    {agent.prs > 0 && <span className="ml-auto text-xs">made PRs</span>}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}

        <div className="mx-1 my-2 border-t" />

        <div className={cn(row, "group relative gap-0 px-0", props.page === "vms" && props.id === null && selected)}>
          <button
            type="button"
            className="flex h-8 w-6 shrink-0 items-center justify-center text-muted-foreground"
            aria-label={vmsOpen ? "Fold VMs" : "Unfold VMs"}
            onClick={() => setVMsOpen(!vmsOpen)}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", vmsOpen && "rotate-90")} />
          </button>
          <a href="#/vms" className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2">
            <Monitor className="size-4 text-muted-foreground" />
            VMs
            <span className={count}>
              {running}/{vms.length}
            </span>
          </a>
          <button type="button" className={plus} aria-label="New VM" title="New VM" onClick={() => setNewVM(true)}>
            <Plus className="size-3.5" />
          </button>
        </div>
        {vmsOpen &&
          vms.map((vm) => (
            <div key={vm.name} className={cn(child, props.page === "vms" && props.id === vm.name && selected)}>
              <a href={`#/vms/${vm.name}`} className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2 pl-6">
                <StatusDot tone={VM_TONE[vm.status]} />
                <span className="truncate">{vm.name}</span>
                <span className={status}>{vm.status !== "running" ? "off" : vm.holder !== null ? "busy" : "free"}</span>
              </a>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={more} aria-label={`Actions for ${vm.name}`}>
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => {
                      setTarget({ kind: "vm", id: vm.name, name: vm.name });
                      setNewName(vm.name);
                      setRenameError("");
                      setRenameOpen(true);
                    }}
                  >
                    <Pencil /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => {
                      setTarget({ kind: "vm", id: vm.name, name: vm.name });
                      setConfirmAction("delete");
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}

        <div className="mx-1 my-2 border-t" />

        <a href="#/resource" className={cn(row, "pl-6", props.page === "resource" && selected)}>
          <Gauge className="size-4 text-muted-foreground" />
          Resource
        </a>
      </div>

      <div className="border-t p-2">
        <a href="#/inbox" className={cn(row, "pl-6", props.page === "inbox" && selected)}>
          <Inbox className="size-4 text-muted-foreground" />
          Inbox
          {/* Drafts waiting on the user hold an agent up, so they get a filled pill, like unread mail. */}
          <span
            className={cn(
              "ml-auto tabular-nums",
              pending > 0 ? "min-w-4.5 rounded-full bg-primary px-1.5 text-center text-xs leading-4.5 font-medium text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {pending}
          </span>
        </a>
        {/* Like Sent under a mail app's Inbox: what went out, and how it is doing. */}
        <a href="#/github" className={cn(row, "pl-6", props.page === "github" && selected)}>
          {/* GitHub's mark (lucide has no brand icons). */}
          <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
          <span className="ml-auto text-muted-foreground tabular-nums">{openPRs}</span>
        </a>
        <button type="button" className={cn(row, "w-full pl-6")} onClick={props.onOpenSettings}>
          <Settings className="size-4 text-muted-foreground" />
          Settings
        </button>
      </div>

      {newJob && <NewJobDialog onClose={() => setNewJob(false)} />}
      <NewVMDialog open={newVM} onOpenChange={setNewVM} />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename {target?.name}</DialogTitle>
            <DialogDescription>
              {target?.kind === "vm"
                ? "Works while it runs. Agents aimed at it and its jobs follow. a-z, 0-9 and -, starting with a letter."
                : "Its conversation, jobs and drafts stay with it."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              rename();
            }}
          >
            <Input autoFocus spellCheck={false} value={newName} onChange={(event) => setNewName(event.target.value)} />
          </form>
          {renameError !== "" && <p className="text-destructive">{renameError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={rename} disabled={newName.trim() === "" || renameBusy}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "archive" ? "Archive" : "Delete"} {target?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "archive" &&
                "It stops, its open jobs are cancelled and it leaves every VM queue. Its conversation stays: it is under Archived on the Agents page, and a message or a job brings it back."}
              {confirmAction === "delete" &&
                (target?.kind === "vm"
                  ? "The VM and everything inside it are removed for good. An agent holding it is interrupted, and agents aimed at it lose their target VM."
                  : "Its conversation is deleted, its open jobs are cancelled and it leaves every VM queue. Its drafts stay in the Inbox.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirmAction === "archive" ? "default" : "destructive"} onClick={confirmAction === "archive" ? archive : remove}>
              {confirmAction === "archive" ? "Archive" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
