/*
Make a job by hand: a title, what to do, the agent that does it (or a new one) and its VM.
"Add job" posts /api/jobs, which creates a "task" job and wakes the agent.

The agent and VM pickers work like AssignDialog's: an agent that is queued for or holding a VM can't
switch VMs, so the VM select is locked to that VM; picking an agent with a target VM preselects it;
"No VM" is only offered when the agent has no target VM (the backend reads "no VM" as "keep its VM").
*/

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Job } from "@/live";

const NEW_AGENT = "__new__";
const NO_VM = "__none__";

export default function NewJobDialog(props: { onClose: () => void }) {
  const agents = useLive("agents");
  const vms = useLive("vms");

  // Start with an idle agent if there is one (it can start right away), else the first agent, else a new one.
  const first = agents.find((agent) => agent.status === "idle") ?? agents[0];
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agentId, setAgentId] = useState(first !== undefined ? first.id : NEW_AGENT);
  const [vmName, setVMName] = useState(first?.target_vm ?? vms[0]?.name ?? NO_VM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const agent = agents.find((each) => each.id === agentId);
  const locked = agent !== undefined && (agent.status === "in_queue" || agent.status === "using_vm");
  const chosenVM = locked ? (agent.vm ?? agent.target_vm ?? NO_VM) : vmName;

  const agentNames: Record<string, string> = {};
  for (const each of agents) {
    agentNames[each.id] = each.name;
  }

  function pickAgent(value: string) {
    setAgentId(value);
    const picked = agents.find((each) => each.id === value);
    if (picked !== undefined && picked.target_vm !== null) {
      setVMName(picked.target_vm);
    }
  }

  async function submit() {
    if (title.trim() === "") {
      setError("Give the job a title.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const job = await api<Job>("/api/jobs", {
        method: "POST",
        body: {
          title: title.trim(),
          instructions: instructions.trim(),
          agent: agentId === NEW_AGENT ? null : agentId,
          vm: chosenVM === NO_VM ? null : chosenVM,
        },
      });
      toast.success(`Added ${job.id} for ${agentNames[job.agent] ?? "a new agent"}`);
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>The agent gets it right away; if it needs its VM, it queues for it.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground">Title</label>
          <Input autoFocus placeholder="e.g. Find 10 good first issues in Python CLI tools" value={title} onChange={(event) => setTitle(event.target.value)} />

          <label className="self-start pt-1.5 text-muted-foreground">Instructions</label>
          <Textarea
            placeholder="What to do, in as much detail as you like"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-24 max-h-64"
          />

          <label className="text-muted-foreground">Agent</label>
          <Select value={agentId} onValueChange={pickAgent}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={NEW_AGENT}>New agent</SelectItem>
              {agents.map((each) => (
                <SelectItem key={each.id} value={each.id}>
                  <StatusDot tone={AGENT_TONE[each.status]} />
                  {each.name}
                  <span className="text-muted-foreground">
                    {each.status === "idle" && "idle"}
                    {each.status === "working" && "working"}
                    {each.status === "in_queue" && `in queue #${each.place} · ${each.vm}`}
                    {each.status === "using_vm" && `using ${each.vm}`}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <label className="text-muted-foreground">VM</label>
          <Select value={chosenVM} onValueChange={setVMName} disabled={locked}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {(agent === undefined || agent.target_vm === null || chosenVM === NO_VM) && <SelectItem value={NO_VM}>No VM</SelectItem>}
              {vms.map((vm) => (
                <SelectItem key={vm.name} value={vm.name}>
                  <StatusDot tone={VM_TONE[vm.status]} />
                  {vm.name}
                  <span className="text-muted-foreground">
                    {vm.status}
                    {vm.holder === "user" && " · held by you"}
                    {vm.holder !== null && vm.holder !== "user" && ` · held by ${agentNames[vm.holder] ?? vm.holder}`}
                    {vm.queue.length > 0 && ` · ${vm.queue.length} waiting`}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {locked && (
            <p className="col-start-2 text-xs text-muted-foreground">
              {agent.name} is {agent.status === "using_vm" ? "using" : "queued for"} {chosenVM}, so its VM can't change until it releases it.
            </p>
          )}
          {!locked && chosenVM === NO_VM && <p className="col-start-2 text-xs text-muted-foreground">Fine for jobs that only read GitHub, like searching for issues.</p>}
        </div>

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Add job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
