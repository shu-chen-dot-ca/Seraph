/*
The Dashboard tab's left list, with the same rows as Home's (Sidebar.tsx). Every line is a link to a page; the open one
is marked:
- Pull requests (#/dashboard/pulls, also #/dashboard): your own pull requests, Open and Closed, and Actions: what agents
  put on GitHub (PullRequests.tsx, plain).
- Issues (#/dashboard/issues, IssueBoard.tsx): the Issues list as a board, Open to Finished, with how many issues.
- Repository (#/dashboard/repos, RepositoryCards.tsx): the repos on the Repos page as cards, with how many are there.
- Agents (#/dashboard/agents, AgentList.tsx): the agents in a table, Open and Closed, with how many are open (on an
  issue in Catalog, In progress, Review or Open PR on the Issues board). Like Home's Agents line without its fold (no line per agent) and without its +. An
  agent's chat (#/agents/<id>) stays on this tab when opened from here (App.tsx), and keeps this line marked.
- Problems (#/dashboard/problems, Problems.tsx): what went wrong in how the app made agents work, as they reported it,
  with how many are open.
- Virtual Machine: the VMs page (#/vms), with running / all; the chevron folds its VMs. One child per VM, with its
  status (off, busy or free) like on Home; a click opens its page (#/vms/<name>). The VM pages are the same as Home's
  and stay on this tab when opened from here (App.tsx).
In phone mode (App.tsx) the list is in the Menu instead, above Home's.
*/

import { BookMarked, Bot, ChevronRight, CircleDot, GitPullRequest, Monitor, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { useLive } from "@/live";
import { cn } from "@/lib/utils";

export default function DashboardNav(props: { page: string; id: string | null }) {
  const [vmsOpen, setVMsOpen] = useState(true);
  const repos = useLive("repos");
  const issues = useLive("issues");
  const vms = useLive("vms");
  const jobs = useLive("jobs");
  const prs = useLive("prs");
  const problems = useLive("problems");
  const running = vms.filter((vm) => vm.status === "running").length;
  // The open agents, the same as on the Agents page (AgentList.tsx): a job on an issue that waits in the queue, works,
  // waits on you or is paused, or waits on maintainers while its pull request is open (or not read yet); or an open
  // pull request of yours the agent follows.
  const openAgents: string[] = [];
  for (const job of jobs) {
    if (job.issue === null) {
      continue;
    }
    let isOpen = job.status === "queued" || job.status === "working" || job.status === "waiting_on_user" || job.status === "paused";
    if (job.status === "waiting_on_maintainers") {
      const pr = prs.items.find((each) => each.job === job.id);
      isOpen = pr === undefined || pr.state === "open";
    }
    if (isOpen && !openAgents.includes(job.agent)) {
      openAgents.push(job.agent);
    }
  }
  for (const pr of prs.items) {
    if (pr.relation === "author" && pr.state === "open" && pr.agent !== null && !openAgents.includes(pr.agent)) {
      openAgents.push(pr.agent);
    }
  }

  // The same rows as the sidebar's (Sidebar.tsx).
  const row = "flex h-8 items-center gap-2 rounded-md px-2 font-medium hover:bg-sidebar-accent hover:text-foreground";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>a>svg]:text-primary [&>svg]:text-primary";

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <a href="#/dashboard/pulls" className={cn(row, "pl-6", props.page === "dashboard" && (props.id === null || props.id === "pulls") && selected)}>
          <GitPullRequest className="size-4 text-muted-foreground" />
          Pull requests
        </a>

        <a href="#/dashboard/issues" className={cn(row, "pl-6", props.page === "dashboard" && props.id === "issues" && selected)}>
          <CircleDot className="size-4 text-muted-foreground" />
          Issues
          <span className="ml-auto text-muted-foreground tabular-nums">{issues.items.length}</span>
        </a>

        <a href="#/dashboard/repos" className={cn(row, "pl-6", props.page === "dashboard" && props.id === "repos" && selected)}>
          <BookMarked className="size-4 text-muted-foreground" />
          Repository
          <span className="ml-auto text-muted-foreground tabular-nums">{repos.items.length}</span>
        </a>

        <a
          href="#/dashboard/agents"
          className={cn(row, "pl-6", ((props.page === "dashboard" && props.id === "agents") || (props.page === "agents" && props.id !== null)) && selected)}
        >
          <Bot className="size-4 text-muted-foreground" />
          Agents
          <span className="ml-auto text-muted-foreground tabular-nums">{openAgents.length}</span>
        </a>

        <a href="#/dashboard/problems" className={cn(row, "pl-6", props.page === "dashboard" && props.id === "problems" && selected)}>
          <TriangleAlert className="size-4 text-muted-foreground" />
          Problems
          <span className="ml-auto text-muted-foreground tabular-nums">{problems.filter((problem) => problem.closed_at === null).length}</span>
        </a>

        <div className={cn(row, "gap-0 px-0", props.page === "vms" && props.id === null && selected)}>
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
            Virtual Machine
            <span className="ml-auto text-muted-foreground tabular-nums">
              {running}/{vms.length}
            </span>
          </a>
        </div>
        {vmsOpen &&
          vms.map((vm) => (
            <a
              key={vm.name}
              href={`#/vms/${encodeURIComponent(vm.name)}`}
              className={cn(row, "pl-6", props.page === "vms" && props.id === vm.name && selected)}
            >
              <StatusDot tone={VM_TONE[vm.status]} />
              <span className="truncate">{vm.name}</span>
              <span className="ml-auto text-muted-foreground tabular-nums">
                {vm.status !== "running" ? "off" : vm.desktops.every((desktop) => desktop.holder !== null) ? "busy" : "free"}
              </span>
            </a>
          ))}
      </div>
    </nav>
  );
}
