/*
Add a paper to reproduce (the Papers page): its PDF, or a link to it, an optional title and instructions, the agent
that does it (or a new one) and its VM. "Add paper" posts /api/jobs/paper, which keeps the PDF in the agent's
artifacts (papers/) and makes a reproduce_paper job for it.

A file wins over a link. A link is downloaded by the app: a PDF's own address, or an arXiv page (arxiv.org/abs/...).
Some sites (medRxiv, for one) turn apps away; then download it in the browser and add the file.
The title is what the Papers page shows; left empty, it is the file's name.

The agent and VM pickers work like NewJobDialog's: an agent that is queued for or holding a VM can't switch VMs, so
the VM select is locked to that VM; picking an agent with a target VM preselects it; "Let the agent choose" is only
offered when the agent has no target VM.
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

export default function NewPaperDialog(props: { onClose: () => void }) {
  const agents = useLive("agents");
  const vms = useLive("vms");

  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agentId, setAgentId] = useState(NEW_AGENT);
  const [agentName, setAgentName] = useState("");
  const [vmName, setVMName] = useState(NO_VM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const agent = agents.find((each) => each.id === agentId);
  const locked = agent !== undefined && (agent.status === "in_queue" || agent.status === "in_priority" || agent.status === "using_vm");
  const chosenVM = locked ? (agent.vm ?? agent.target_vm ?? NO_VM) : vmName;

  // The name a new agent gets when Agent name is left empty: the first free "agent-N".
  const takenAgentNames = agents.map((each) => each.name);
  let agentNumber = 1;
  while (takenAgentNames.includes(`agent-${agentNumber}`)) {
    agentNumber += 1;
  }
  const defaultAgentName = `agent-${agentNumber}`;

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
    if (file === null && link.trim() === "") {
      setError("Add the paper's PDF, or a link to it.");
      return;
    }
    const newAgent = agentName.trim() === "" ? defaultAgentName : agentName.trim();
    if (agentId === NEW_AGENT && takenAgentNames.includes(newAgent)) {
      setError(`There is already an agent named ${newAgent}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      // The PDF goes in the request as base64 (a data URL without its "data:application/pdf;base64," start).
      let pdf = "";
      if (file !== null) {
        pdf = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
      }
      const job = await api<Job>("/api/jobs/paper", {
        method: "POST",
        body: {
          title: title.trim(),
          pdf: pdf,
          file_name: file !== null ? file.name : "",
          link: file !== null ? "" : link.trim(),
          instructions: instructions.trim(),
          agent: agentId === NEW_AGENT ? null : agentId,
          agent_name: agentId === NEW_AGENT ? agentName.trim() : "",
          vm: chosenVM === NO_VM ? null : chosenVM,
        },
      });
      const name = agentId === NEW_AGENT ? newAgent : (agentNames[job.agent] ?? job.agent);
      toast.success(`Added ${job.title.replace(/^Reproduce /, "")} for ${name}`);
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
          <DialogTitle>Add paper</DialogTitle>
          <DialogDescription>The agent reads it, rebuilds it in the VM, checks its numbers and claims, and puts a report in the Inbox.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="text-muted-foreground">PDF</label>
          <Input type="file" accept="application/pdf,.pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />

          <label className="text-muted-foreground">Link</label>
          <Input
            placeholder="Or a link, e.g. https://arxiv.org/abs/2401.01234"
            value={link}
            disabled={file !== null}
            spellCheck={false}
            onChange={(event) => setLink(event.target.value)}
          />

          <label className="text-muted-foreground">Title</label>
          <Input placeholder={file !== null ? file.name.replace(/\.pdf$/i, "") : "e.g. VALORIS"} value={title} onChange={(event) => setTitle(event.target.value)} />

          <label className="self-start pt-1.5 text-muted-foreground">Instructions</label>
          <Textarea
            placeholder="What to focus on, if anything (e.g. check the privacy claims)"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
            className="min-h-20 max-h-64"
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
              {(agent === undefined || agent.target_vm === null || chosenVM === NO_VM) && <SelectItem value={NO_VM}>Let the agent choose</SelectItem>}
              {vms.map((vm) => (
                <SelectItem key={vm.name} value={vm.name}>
                  <StatusDot tone={VM_TONE[vm.status]} />
                  {vm.name}
                  <span className="text-muted-foreground">
                    {vm.status}
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
          {!locked && vms.length === 0 && <p className="col-start-2 text-xs text-muted-foreground">There are no VMs yet: make one on the VMs page.</p>}
        </div>

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            Add paper
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
