/*
Make a job by hand: a title, what to do, the agent that does it (or a new one) and its VM (or a new one).
"Add job" posts /api/jobs, which creates a "task" job and wakes the agent.

The agent starts as "New agent", with an Agent name row under it. Its placeholder is the name the agent gets
when the row is left empty (the first free "agent-N", as the backend picks it); a typed name is used instead.

The VM starts as "Let the agent choose", or "New VM" when there are no VMs yet (then "Let the agent choose" is
greyed out: there is nothing to choose from). "New VM" has a VM name row
that works the same way (the first free "vmN"). The VM is made first (POST /api/vms, with the default image,
CPUs, memory and disk from /api/vms/options), then the job is added for it; the VM takes about a minute to start.

The agent and VM pickers work like AssignDialog's: an agent that is queued for or holding a VM can't
switch VMs, so the VM select is locked to that VM; picking an agent with a target VM preselects it;
"Let the agent choose" is only offered when the agent has no target VM (the backend reads "no VM" as "keep its
VM"); the agent then picks the VM that suits the job itself, if the job needs one.
*/

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, StatusDot, VM_TONE } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Job, type VMOptions } from "@/live";

const NEW_AGENT = "__new__";
const NEW_VM = "__new_vm__";
const NO_VM = "__none__";

export default function NewJobDialog(props: { onClose: () => void }) {
  const agents = useLive("agents");
  const vms = useLive("vms");

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agentId, setAgentId] = useState(NEW_AGENT);
  const [agentName, setAgentName] = useState("");
  // "" = not picked: "New VM" while there are no VMs, else "Let the agent choose".
  const [vmName, setVMName] = useState("");
  const [newVMName, setNewVMName] = useState("");
  const [options, setOptions] = useState<VMOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The default CPUs, memory and disk for a new VM.
  useEffect(() => {
    api<VMOptions>("/api/vms/options")
      .then(setOptions)
      .catch((err) => setError(`Could not load the VM options: ${err instanceof Error ? err.message : err}`));
  }, []);

  const agent = agents.find((each) => each.id === agentId);
  const locked = agent !== undefined && (agent.status === "in_queue" || agent.status === "in_priority" || agent.status === "using_vm");
  let pickedVM = vmName;
  if (pickedVM === "") {
    pickedVM = vms.length === 0 ? NEW_VM : NO_VM;
  }
  const chosenVM = locked ? (agent.vm ?? agent.target_vm ?? NO_VM) : pickedVM;

  const agentNames: Record<string, string> = {};
  for (const each of agents) {
    agentNames[each.id] = each.name;
  }

  // The name a new agent gets when Agent name is left empty: the first free "agent-N".
  const takenAgentNames = agents.map((each) => each.name);
  let agentNumber = 1;
  while (takenAgentNames.includes(`agent-${agentNumber}`)) {
    agentNumber += 1;
  }
  const defaultAgentName = `agent-${agentNumber}`;

  // The name a new VM gets when VM name is left empty: the first free "vmN".
  const takenVMNames = vms.map((vm) => vm.name);
  let vmNumber = 1;
  while (takenVMNames.includes(`vm${vmNumber}`)) {
    vmNumber += 1;
  }
  const defaultVMName = `vm${vmNumber}`;

  function pickAgent(value: string) {
    setAgentId(value);
    const picked = agents.find((each) => each.id === value);
    setVMName(picked !== undefined && picked.target_vm !== null ? picked.target_vm : "");
  }

  async function submit() {
    const newAgent = agentName.trim() === "" ? defaultAgentName : agentName.trim();
    const newVM = newVMName.trim() === "" ? defaultVMName : newVMName.trim();
    if (title.trim() === "") {
      setError("Give the job a title.");
      return;
    }
    // Checked here too, so a taken name doesn't leave a new VM behind with no job.
    if (agentId === NEW_AGENT && takenAgentNames.includes(newAgent)) {
      setError(`There is already an agent named ${newAgent}.`);
      return;
    }
    if (chosenVM === NEW_VM && options === null) {
      setError("The VM options haven't loaded yet.");
      return;
    }
    if (chosenVM === NEW_VM && !/^[a-z][a-z0-9-]{0,30}$/.test(newVM)) {
      setError("A VM name has only lowercase letters, digits and dashes, and starts with a letter.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let vm = chosenVM === NO_VM ? null : chosenVM;
      if (chosenVM === NEW_VM && options !== null) {
        await api("/api/vms", {
          method: "POST",
          body: { name: newVM, image: "", cpus: options.cpus_default, memory_gb: options.memory_gb_default, disk_gb: options.disk_gb_default },
        });
        vm = newVM;
        // If adding the job fails, trying again uses this VM instead of making another.
        setVMName(newVM);
      }
      const job = await api<Job>("/api/jobs", {
        method: "POST",
        body: {
          title: title.trim(),
          instructions: instructions.trim(),
          agent: agentId === NEW_AGENT ? null : agentId,
          agent_name: agentId === NEW_AGENT ? agentName.trim() : "",
          vm: vm,
        },
      });
      let name = agentNames[job.agent];
      if (agentId === NEW_AGENT) {
        name = newAgent;
      }
      if (chosenVM === NEW_VM) {
        toast.success(`Added ${job.id} for ${name}. Creating ${newVM}, it takes about a minute.`);
      } else {
        toast.success(`Added ${job.id} for ${name}`);
      }
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
              {agents.filter((each) => each.archived_at === null).map((each) => (
                <SelectItem key={each.id} value={each.id}>
                  <StatusDot tone={AGENT_TONE[each.status]} />
                  {each.name}
                  <span className="text-muted-foreground">
                    {each.status === "idle" && "idle"}
                    {each.status === "working" && "working"}
                    {each.status === "in_queue" && `in queue #${each.place} · ${each.vm}`}
                    {each.status === "in_priority" && `in priority #${each.place} · ${each.vm}`}
                    {each.status === "using_vm" && `using ${each.vm}`}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {agentId === NEW_AGENT && (
            <>
              <label className="text-muted-foreground">Agent name</label>
              <Input placeholder={defaultAgentName} value={agentName} onChange={(event) => setAgentName(event.target.value)} />
            </>
          )}

          <label className="text-muted-foreground">VM</label>
          <Select value={chosenVM} onValueChange={setVMName} disabled={locked}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={NEW_VM}>New VM</SelectItem>
              {/* Greyed out while there are no VMs: there is nothing to choose from. */}
              {(agent === undefined || agent.target_vm === null || chosenVM === NO_VM) && (
                <SelectItem value={NO_VM} disabled={vms.length === 0}>
                  Let the agent choose
                </SelectItem>
              )}
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
          {!locked && chosenVM === NO_VM && (
            <p className="col-start-2 text-xs text-muted-foreground">It picks the VM whose image suits the job, or none for jobs that only read GitHub.</p>
          )}

          {chosenVM === NEW_VM && (
            <>
              <label className="text-muted-foreground">VM name</label>
              <Input
                placeholder={defaultVMName}
                value={newVMName}
                spellCheck={false}
                onChange={(event) => setNewVMName(event.target.value.trim().toLowerCase())}
              />
              {options !== null && (
                <p className="col-start-2 text-xs text-muted-foreground">
                  From the default image, with {options.cpus_default} CPUs, {options.memory_gb_default} GB memory and {options.disk_gb_default} GB disk. It
                  takes about a minute to start.
                </p>
              )}
            </>
          )}
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
