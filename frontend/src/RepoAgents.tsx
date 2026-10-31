/*
A repository's Agents tab on the Workspace tab (Repository.tsx with live, from Home.tsx; the tab a repo opens on): every
agent working with the repo, laid out like a chat app's list of chats.

Which VMs have the repo set up comes from their notes: a VM has it when one of its notes names the repo as owner/name
(agents write their notes that way, github_searcher/agent/prompt.md; you can add one yourself on the VM's Notes tab).
The agents working with the repo: the repo's own agent, every agent with a job on the repo, and every agent that has
one of those VMs as its target VM, waits for it or holds it. Newest first; archived ones last, marked so.

Left: the VMs that have the repo set up (each a link to its page), or a line that none has, and New agent, which makes
an agent with the next free name ("agent-N"), sets the first of those VMs as its target VM and opens its chat (only
when one has it). Under them one card per agent: where it stands (idle, working, in the VM's queue, using the VM and
which desktop) and when it last did something; the job it is on, with how far that is and its headline in everyday
words, or else what it did last. The open one is marked. Right: the open agent's chat (AgentChat.tsx, compact), where
you talk to it; at first the first agent's.
On a narrow screen (a phone) one side shows at a time: the cards, or the open agent's chat with Agents (back to the
cards) above it.
Everything comes from the live store (agents, jobs and VMs), so the cards move on their own while agents work.
*/

import { ChevronLeft, Loader2, Monitor, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import AgentChat from "@/AgentChat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JobProgressBar, currentJob, since, stuckFor, useNow } from "@/components/ui/job-progress";
import { AGENT_TONE, StatusDot } from "@/components/ui/status-dot";
import { api, useLive, useLiveValue, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

export default function RepoAgents(props: { repo: string }) {
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  // The VMs that have the repo set up, one name per line: one of their notes names it as owner/name, not as part of a
  // longer name. Only the names, since the VM list changes every second while a VM runs.
  const vmText = useLiveValue((topics) => {
    const pattern = new RegExp(`(?<![\\w.-])${props.repo.replaceAll(".", "\\.")}(?![\\w.-])`, "i");
    return topics.vms
      .filter((vm) => vm.notes.some((note) => pattern.test(note.text)))
      .map((vm) => vm.name)
      .join("\n");
  });
  const vmNames = vmText === "" ? [] : vmText.split("\n");
  const loaded = useLoaded("agents");
  const now = useNow();
  // The agent whose chat is open; null: none picked yet (the first one's shows, except on a phone).
  const [selected, setSelected] = useState<string | null>(null);
  // New agent's requests are on their way.
  const [creating, setCreating] = useState(false);

  // The repo's own agent, the agents with a job on the repo, and the agents linked to a VM that has it set up. Newest
  // first; archived ones last.
  const jobAgents = jobs.filter((job) => job.repo !== null && job.repo.toLowerCase() === props.repo.toLowerCase()).map((job) => job.agent);
  const all = agents
    .filter(
      (agent) =>
        agent.repo === props.repo ||
        jobAgents.includes(agent.id) ||
        (agent.target_vm !== null && vmNames.includes(agent.target_vm)) ||
        (agent.vm !== null && vmNames.includes(agent.vm)),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const list = [...all.filter((agent) => agent.archived_at === null), ...all.filter((agent) => agent.archived_at !== null)];
  const picked = list.find((agent) => agent.id === selected);
  const shown = picked !== undefined ? picked : list[0];

  // No name: the backend gives it the next free "agent-N". Then the first VM that has the repo set up becomes its
  // target VM.
  async function createAgent() {
    if (vmNames.length === 0 || creating) {
      return;
    }
    const vmName = vmNames[0];
    setCreating(true);
    try {
      const agent = await api<{ id: string }>("/api/agents", { method: "POST", body: { name: "" } });
      try {
        await api(`/api/agents/${agent.id}/target_vm`, { method: "PUT", body: { vm: vmName } });
      } catch (err) {
        toast.error(`The agent was made, but ${vmName} could not be set as its target VM: ${err instanceof Error ? err.message : err}`);
      }
      setSelected(agent.id);
    } catch (err) {
      toast.error(`Could not make an agent: ${err instanceof Error ? err.message : err}`);
    }
    setCreating(false);
  }

  if (!loaded) {
    return <div className="p-3 text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-full">
      <div className={cn("flex w-80 shrink-0 flex-col border-r max-md:w-full max-md:border-r-0", picked !== undefined && "max-md:hidden")}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
          {vmNames.length === 0 && (
            <span className="min-w-0 truncate text-muted-foreground" title={`A VM has it once one of its notes names ${props.repo} (the VM's Notes tab)`}>
              No VM has this repo set up
            </span>
          )}
          {vmNames.map((name) => (
            <a
              key={name}
              href={`#/vms/${encodeURIComponent(name)}`}
              className="flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
              title="Open the VM's page"
            >
              <Monitor className="size-4 shrink-0" />
              <span className="truncate">{name}</span>
            </a>
          ))}
          <Button size="sm" variant="outline" className="ml-auto shrink-0" disabled={vmNames.length === 0 || creating} onClick={createAgent}>
            {creating ? <Loader2 className="animate-spin" /> : <Plus />} New agent
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {list.map((agent) => {
            const job = currentJob(agent.id, jobs);
            const stuck = stuckFor(agent, now);
            return (
              <button
                key={agent.id}
                type="button"
                className={cn(
                  "block w-full rounded-lg border bg-card p-3 text-left hover:bg-accent/50",
                  agent.id === shown?.id && "md:border-primary/40 md:bg-selected md:ring-1 md:ring-primary/15 md:ring-inset md:hover:bg-selected",
                  agent.archived_at !== null && "text-muted-foreground",
                )}
                onClick={() => setSelected(agent.id)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot tone={stuck !== "" ? "amber" : (AGENT_TONE[agent.status] ?? "gray")} />
                  <span className="min-w-0 truncate font-semibold">{agent.name}</span>
                  {agent.archived_at !== null && (
                    <Badge variant="secondary" className="py-0">
                      Archived
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{agent.last_event_at !== null ? `${since(agent.last_event_at, now)} ago` : ""}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {agent.status === "idle" && "idle"}
                  {agent.status === "working" && "working"}
                  {agent.status === "in_queue" && `in queue #${agent.place} · ${agent.vm}`}
                  {agent.status === "in_priority" && `in priority #${agent.place} · ${agent.vm}`}
                  {agent.status === "using_vm" && `using ${agent.vm}`}
                  {agent.status === "using_vm" && agent.desktop !== null && ` · desktop ${agent.desktop}`}
                  {agent.busy && agent.status !== "working" && " · working"}
                  {stuck !== "" && <span className="text-warn"> · no activity for {stuck}</span>}
                </div>
                {job !== undefined && (
                  <div className="mt-2 space-y-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <JobProgressBar job={job} className="shrink-0" />
                      <span className="truncate" title={job.title}>
                        {job.title}
                      </span>
                    </div>
                    {job.headline !== "" && <p className="line-clamp-2 text-xs text-foreground/80">{job.headline}</p>}
                  </div>
                )}
                {job === undefined && agent.activity !== "" && (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground" title={agent.activity}>
                    {agent.activity}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn("flex min-w-0 flex-1 flex-col", picked === undefined && "max-md:hidden")}>
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-muted-foreground hover:text-foreground md:hidden"
          onClick={() => setSelected(null)}
        >
          <ChevronLeft className="size-4" /> Agents
        </button>
        <div className="min-h-0 flex-1">{shown !== undefined && <AgentChat key={shown.id} agentId={shown.id} compact />}</div>
      </div>
    </div>
  );
}
