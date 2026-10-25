/*
Give an issue to an agent: pick the agent (or a new one), the VM it should work on, and optional instructions.
"Add job" posts /api/issues/assign, which creates a fix_issue job and wakes the agent.

An agent that is queued for or holding a VM can't switch VMs, so while such an agent is picked the VM
select is locked to that VM. Picking an agent with a target VM preselects that VM. "Let the agent choose" is
only offered when the agent has no target VM (the backend reads "no VM" as "keep its target VM"): the agent
then picks the VM that suits the job itself (vms_list, choose_vm).
*/

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type IssueItem, type Job } from "@/live";

const NEW_AGENT = "__new__";
const NO_VM = "__none__";

export default function AssignDialog(props: { issue: IssueItem; onClose: () => void }) {
  // Archived agents aren't offered (the Agents page brings them back).
  const agents = useLive("agents").filter((agent) => agent.archived_at === null);
  const vms = useLive("vms");

  // Start with an idle agent if there is one (it can start right away), else the first agent, else a new one.
  const first = agents.find((agent) => agent.status === "idle") ?? agents[0];
  const [agentId, setAgentId] = useState(first !== undefined ? first.id : NEW_AGENT);
  const [vmName, setVMName] = useState(first?.target_vm ?? NO_VM);
  const [instructions, setInstructions] = useState("");
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
    setVMName(picked !== undefined && picked.target_vm !== null ? picked.target_vm : NO_VM);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const job = await api<Job>("/api/issues/assign", {
        method: "POST",
        body: {
          issue: props.issue.id,
          agent: agentId === NEW_AGENT ? null : agentId,
          vm: chosenVM === NO_VM ? null : chosenVM,
          instructions: instructions.trim(),
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
      <DialogContent className="sm:max-w-md">
        {/* min-w-0 lets the truncated title shrink; without it a long issue title widens the dialog's grid past its box */}
        <DialogHeader className="min-w-0">
          <DialogTitle>
            Assign {props.issue.repo}#{props.issue.number}
          </DialogTitle>
          <DialogDescription className="truncate">{props.issue.title}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
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
              {(agent === undefined || agent.target_vm === null || chosenVM === NO_VM) && <SelectItem value={NO_VM}>Let the agent choose</SelectItem>}
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
          {!locked && vms.length === 0 && <p className="col-start-2 text-xs text-muted-foreground">No VMs yet. Create one on the VMs page.</p>}

          <label className="self-start pt-1.5 text-muted-foreground">Instructions</label>
          <Textarea
            placeholder="Optional, e.g. keep the change small"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
            className="max-h-48"
          />
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
