/*
The left tree, like Proxmox's resource tree. Every line is a link to a page, in the order the work flows, in three parts:
- finding work: Explore (the search for new repos; shows how many found repos wait for the user's approve or reject,
  with a green dot while a run goes), Repos, Tracked (new issues in the repos the user keeps an eye on), Issues;
- doing it, under a line: Jobs (open / all), Agents (one child per agent), then under another line VMs (one child per VM);
- pinned at the bottom: Inbox and Settings (below).
Counts and status dots come straight from the live store, so the tree updates itself.
The chevrons only fold Agents / VMs; clicking a name opens that page.
Hovering Jobs, Agents or VMs fades its count into a + that makes a new one right there:
New job opens NewJobDialog, + on Agents opens NewAgentDialog, + on VMs opens NewVMDialog.
Inbox (pending drafts) and Settings stay pinned at the bottom while the tree scrolls; Settings opens SettingsDialog
(theme and accent color), which App owns.
*/

import { Bot, ChevronRight, CircleDot, Compass, Eye, FolderGit2, Inbox, ListTodo, Monitor, Plus, Settings } from "lucide-react";
import { useState } from "react";

import NewAgentDialog from "@/NewAgentDialog";
import NewJobDialog from "@/NewJobDialog";
import NewVMDialog from "@/NewVMDialog";

import { AGENT_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { useLive, useLiveValue } from "@/live";
import { cn } from "@/lib/utils";

export default function Sidebar(props: { page: string; id: string | null; onOpenSettings: () => void }) {
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [vmsOpen, setVMsOpen] = useState(true);
  const [newJob, setNewJob] = useState(false);
  const [newVM, setNewVM] = useState(false);
  const [newAgent, setNewAgent] = useState(false);
  const inbox = useLive("inbox");
  const issues = useLive("issues");
  const jobs = useLive("jobs");
  const repos = useLive("repos");
  const tracked = useLive("tracked");
  const agents = useLive("agents");
  const vms = useLive("vms");
  // Only what the row shows: the explore topic changes many times a second while a run goes.
  const exploreRunning = useLiveValue((topics) => topics.explore.run !== null && topics.explore.run.status === "running");
  const exploreWaiting = useLiveValue((topics) => topics.explore.found.length);

  const pending = inbox.filter((draft) => draft.status === "pending").length;
  const running = vms.filter((vm) => vm.status === "running").length;
  // Issues opened in tracked repos in the last three days.
  const newSince = Date.now() - 3 * 24 * 60 * 60 * 1000;
  let trackedNew = 0;
  for (const repo of tracked.items) {
    const check = repo.check;
    if (check !== null) {
      trackedNew += check.issues.filter((issue) => new Date(issue.created_at).getTime() > newSince).length;
    }
  }
  const openJobs = jobs.filter((job) => job.status === "queued" || job.status === "working" || job.status === "waiting_on_user").length;

  // No color transition: picking a page should show at once, not fade in.
  const row = "flex h-7 items-center gap-2 rounded-sm px-2 hover:bg-sidebar-accent";
  // The count fades out and the + fades in, in the same spot, while the row is hovered or the + has focus.
  const count = "ml-auto text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0";
  const plus =
    "absolute right-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100";

  // The open page: an accent wash, and its icon in the accent (the icon is the row's first svg, or its link's).
  const selected = "bg-selected text-foreground hover:bg-selected [&>a>svg]:text-primary [&>svg]:text-primary";

  return (
    <nav className="flex w-52 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <a
          href="#/explore"
          className={cn(row, "pl-6", props.page === "explore" && selected)}
          title={`${exploreWaiting} found repos wait for your approve or reject${exploreRunning ? "; Explore is running" : ""}`}
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
          title={trackedNew > 0 ? `${trackedNew} issues opened in the last 3 days in ${tracked.items.length} tracked repos` : `${tracked.items.length} tracked repos`}
        >
          <Eye className="size-4 text-muted-foreground" />
          Tracked
          {trackedNew > 0 ? (
            <span className="ml-auto font-medium text-primary tabular-nums">{trackedNew} new</span>
          ) : (
            <span className="ml-auto text-muted-foreground tabular-nums">{tracked.items.length}</span>
          )}
        </a>

        <a href="#/issues" className={cn(row, "pl-6", props.page === "issues" && selected)}>
          <CircleDot className="size-4 text-muted-foreground" />
          Issues
          <span className="ml-auto text-muted-foreground tabular-nums">{issues.items.length}</span>
        </a>

        {/* The work: what runs (jobs), who runs it (agents) and where (VMs). */}
        <div className="-mx-1.5 my-1.5 border-t" />

        <div className={cn(row, "group relative p-0", props.page === "jobs" && selected)}>
          <a href="#/jobs" className="flex h-7 min-w-0 flex-1 items-center gap-2 pr-2 pl-6">
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
            className="flex h-7 w-6 shrink-0 items-center justify-center text-muted-foreground"
            aria-label={agentsOpen ? "Fold agents" : "Unfold agents"}
            onClick={() => setAgentsOpen(!agentsOpen)}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", agentsOpen && "rotate-90")} />
          </button>
          <a href="#/agents" className="flex h-7 min-w-0 flex-1 items-center gap-2 pr-2">
            <Bot className="size-4 text-muted-foreground" />
            Agents
            <span className={count}>{agents.length}</span>
          </a>
          <button type="button" className={plus} aria-label="New agent" title="New agent" onClick={() => setNewAgent(true)}>
            <Plus className="size-3.5" />
          </button>
        </div>
        {agentsOpen &&
          agents.map((agent) => (
            <a
              key={agent.id}
              href={`#/agents/${agent.id}`}
              className={cn(row, "pl-12", props.page === "agents" && props.id === agent.id && selected)}
              title={agent.activity}
            >
              <StatusDot tone={AGENT_TONE[agent.status]} />
              <span className="truncate">{agent.name}</span>
              {agent.status === "in_queue" && <span className="ml-auto text-muted-foreground tabular-nums">#{agent.place}</span>}
            </a>
          ))}

        <div className="-mx-1.5 my-1.5 border-t" />

        <div className={cn(row, "group relative gap-0 px-0", props.page === "vms" && props.id === null && selected)}>
          <button
            type="button"
            className="flex h-7 w-6 shrink-0 items-center justify-center text-muted-foreground"
            aria-label={vmsOpen ? "Fold VMs" : "Unfold VMs"}
            onClick={() => setVMsOpen(!vmsOpen)}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", vmsOpen && "rotate-90")} />
          </button>
          <a href="#/vms" className="flex h-7 min-w-0 flex-1 items-center gap-2 pr-2">
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
            <a key={vm.name} href={`#/vms/${vm.name}`} className={cn(row, "pl-12", props.page === "vms" && props.id === vm.name && selected)}>
              <StatusDot tone={VM_TONE[vm.status]} />
              <span className="truncate">{vm.name}</span>
              <span className="ml-auto text-muted-foreground">{vm.status !== "running" ? "off" : vm.holder !== null ? "busy" : "free"}</span>
            </a>
          ))}
      </div>

      <div className="border-t p-1.5">
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
        <button type="button" className={cn(row, "w-full pl-6")} onClick={props.onOpenSettings}>
          <Settings className="size-4 text-muted-foreground" />
          Settings
        </button>
      </div>

      {newJob && <NewJobDialog onClose={() => setNewJob(false)} />}
      {newAgent && <NewAgentDialog onClose={() => setNewAgent(false)} />}
      <NewVMDialog open={newVM} onOpenChange={setNewVM} />
    </nav>
  );
}
