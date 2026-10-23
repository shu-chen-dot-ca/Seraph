/*
The left tree, like Proxmox's resource tree. Every line is a link to a page:
Inbox (pending drafts), Issues, Jobs (open / all), Repos, Tracked (new issues in the repos the user keeps an eye on),
Agents (one child per agent) and VMs (one child per VM).
Counts and status dots come straight from the live store, so the tree updates itself.
The chevrons only fold Agents / VMs; clicking a name opens that page.
Hovering Jobs, Agents or VMs fades its count into a + that makes a new one right there:
New job opens NewJobDialog, + on Agents makes an agent and opens it, + on VMs opens NewVMDialog.
*/

import { Bot, ChevronRight, CircleDot, Eye, FolderGit2, Inbox, ListTodo, Monitor, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import NewJobDialog from "@/NewJobDialog";
import NewVMDialog from "@/NewVMDialog";

import { AGENT_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { api, useLive } from "@/live";
import { cn } from "@/lib/utils";

export default function Sidebar(props: { page: string; id: string | null }) {
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [vmsOpen, setVMsOpen] = useState(true);
  const [newJob, setNewJob] = useState(false);
  const [newVM, setNewVM] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const inbox = useLive("inbox");
  const issues = useLive("issues");
  const jobs = useLive("jobs");
  const repos = useLive("repos");
  const tracked = useLive("tracked");
  const agents = useLive("agents");
  const vms = useLive("vms");

  const pending = inbox.filter((draft) => draft.status === "pending").length;
  const running = vms.filter((vm) => vm.status === "running").length;
  // Issues opened in tracked repos since the user last marked them seen.
  let trackedNew = 0;
  for (const repo of tracked.items) {
    const check = repo.check;
    if (check !== null) {
      trackedNew += check.issues.filter((issue) => issue.created_at > check.seen_at).length;
    }
  }
  const openJobs = jobs.filter((job) => job.status === "queued" || job.status === "working" || job.status === "waiting_on_user").length;

  const row = "flex h-7 items-center gap-2 rounded-sm px-2 hover:bg-sidebar-accent";
  // The count fades out and the + fades in, in the same spot, while the row is hovered or the + has focus.
  const count = "ml-auto text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0 group-focus-within:opacity-0";
  const plus =
    "absolute right-1 flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100";

  async function createAgent() {
    setCreatingAgent(true);
    try {
      const agent = await api<{ id: string }>("/api/agents", { method: "POST", body: { name: "" } });
      window.location.hash = `#/agents/${agent.id}`;
    } catch (err) {
      toast.error(`Could not create an agent: ${err instanceof Error ? err.message : err}`);
    }
    setCreatingAgent(false);
  }
  const selected = "bg-selected text-foreground hover:bg-selected";

  return (
    <nav className="w-52 shrink-0 overflow-y-auto border-r bg-sidebar p-1.5 text-sidebar-foreground select-none">
      <a href="#/inbox" className={cn(row, "pl-6", props.page === "inbox" && selected)}>
        <Inbox className="size-4 text-muted-foreground" />
        Inbox
        <span className={cn("ml-auto tabular-nums", pending > 0 ? "font-medium text-primary" : "text-muted-foreground")}>{pending}</span>
      </a>

      <a href="#/issues" className={cn(row, "pl-6", props.page === "issues" && selected)}>
        <CircleDot className="size-4 text-muted-foreground" />
        Issues
        <span className="ml-auto text-muted-foreground tabular-nums">{issues.items.length}</span>
      </a>

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

      <a href="#/repos" className={cn(row, "pl-6", props.page === "repos" && selected)}>
        <FolderGit2 className="size-4 text-muted-foreground" />
        Repos
        <span className="ml-auto text-muted-foreground tabular-nums">{repos.items.length}</span>
      </a>

      <a
        href="#/tracked"
        className={cn(row, "pl-6", props.page === "tracked" && selected)}
        title={trackedNew > 0 ? `${trackedNew} new issues in ${tracked.items.length} tracked repos` : `${tracked.items.length} tracked repos`}
      >
        <Eye className="size-4 text-muted-foreground" />
        Tracked
        {trackedNew > 0 ? (
          <span className="ml-auto font-medium text-primary tabular-nums">{trackedNew} new</span>
        ) : (
          <span className="ml-auto text-muted-foreground tabular-nums">{tracked.items.length}</span>
        )}
      </a>

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
        <button type="button" className={plus} aria-label="New agent" title="New agent" disabled={creatingAgent} onClick={createAgent}>
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

      {newJob && <NewJobDialog onClose={() => setNewJob(false)} />}
      <NewVMDialog open={newVM} onOpenChange={setNewVM} />
    </nav>
  );
}
