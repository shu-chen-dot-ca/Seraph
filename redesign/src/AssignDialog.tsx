import { useState } from "react";

import Dialog from "@/Dialog";
import { AGENTS, VMS, WORK_BY_ID, type OpenIssue } from "@/data";
import { toast } from "@/links";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";

/*
Assign: who works on an open issue, and on which machine. The agents that already know the project come first, then
a new one. The machine list says which have a free desktop. Once assigned, the issue moves to In progress.
*/

export default function AssignDialog(props: { issue: OpenIssue; onClose: () => void }) {
  const { update } = useStore();
  const known = Object.keys(AGENTS).filter((id) => WORK_BY_ID[AGENTS[id].work].short === props.issue.short && !id.includes("review") && id !== "seraph-chat");
  const newAgent = `${props.issue.short.toLowerCase()}-${known.length + 1}`;
  const [agent, setAgent] = useState(known.find((id) => AGENTS[id].status === "Idle") ?? newAgent);
  const [vm, setVm] = useState("vm1");
  const [note, setNote] = useState("");

  function assign() {
    update((store) => ({ ...store, assigned: { ...store.assigned, [props.issue.id]: { agent, vm } } }));
    toast(`${agent} starts on ${props.issue.ref}, on ${vm}. It's in In progress.`);
    props.onClose();
  }

  const option = (on: boolean) => cn("flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 hover:border-input", on && "border-primary bg-selected hover:border-primary");

  return (
    <Dialog title={`Assign ${props.issue.ref}`} confirm="Assign" onConfirm={assign} onClose={props.onClose}>
      <p className="text-muted-foreground">{props.issue.title}</p>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">Who</div>
        {[...known, newAgent].map((id) => (
          <label key={id} className={option(agent === id)}>
            <input type="radio" name="agent" checked={agent === id} onChange={() => setAgent(id)} className="mt-0.5 accent-[var(--primary)]" />
            <span className="flex flex-col">
              <span className="font-medium">{id === newAgent ? `New agent (${id})` : id}</span>
              <span className="text-xs text-muted-foreground">{id === newAgent ? "Starts fresh" : `${AGENTS[id].status} · knows this project`}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">Where</div>
        {Object.keys(VMS).map((name) => {
          const free = VMS[name].desktops.filter((desk) => desk.holder === null).length;
          let line = free > 0 ? `${free} desktop free` : `Busy · ${VMS[name].waiting.length} waiting`;
          if (VMS[name].status === "Stopped") {
            line = "Stopped · starts it";
          }
          return (
            <label key={name} className={option(vm === name)}>
              <input type="radio" name="vm" checked={vm === name} onChange={() => setVm(name)} className="mt-0.5 accent-[var(--primary)]" />
              <span className="flex flex-col">
                <span className="font-medium">{name}</span>
                <span className="text-xs text-muted-foreground">{line}</span>
              </span>
            </label>
          );
        })}
      </div>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Anything the agent should know (optional)"
        className="min-h-14 resize-y rounded-md border bg-background px-2.5 py-2 outline-none focus-visible:border-ring"
      />
    </Dialog>
  );
}
