/*
The Notes tab of a VM page: what is set up in this VM, so the next agent (and you) know before using it, e.g.
"openclaw in ~/openclaw: built, on main. Added the matrix plugin for issue 4120."

Agents write them: the one holding the VM adds a note for what it set up or changed on top of the plain project, and
removes notes that are no longer true. Every agent sees them when it picks a VM, and again when the VM becomes its
turn; it still checks the VM itself before relying on them. Oldest first, each with who wrote it (an agent, a link
to it, or You), when, and for an agent's note the desktop it was on (each desktop has its own home folder, so
~/openclaw on desktop 2 is /home/desktop2/openclaw).

You can add your own (the box at the bottom; Ctrl+Enter adds it too), e.g. something you installed by hand or a rule
for agents ("leave ~/demo as it is"). Agents can't remove your notes. Remove (on hover) takes any note off, at once.
A fork starts with a copy of its source's notes. The VMs overview shows the latest ones in each VM's Notes card.
The notes come from the live "vms" topic.
*/

import { Loader2, Plus, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive } from "@/live";

export default function VMNotes(props: { name: string }) {
  const vms = useLive("vms");
  const agents = useLive("agents");
  const vm = vms.find((each) => each.name === props.name);
  const [text, setText] = useState("");
  // "add", or the id of the note being removed.
  const [busy, setBusy] = useState("");

  if (vm === undefined) {
    return <div className="p-3 text-muted-foreground">No VM named {props.name}.</div>;
  }

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  async function addNote() {
    setBusy("add");
    try {
      await api(`/api/vms/${encodeURIComponent(props.name)}/notes`, { method: "POST", body: { text: text } });
      setText("");
    } catch (err) {
      toast.error(`Could not add the note: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function removeNote(id: string) {
    setBusy(id);
    try {
      await api(`/api/vms/${encodeURIComponent(props.name)}/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      toast.error(`Could not remove the note: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl p-4">
        {vm.notes.length === 0 && (
          <p className="pb-3 text-muted-foreground">No notes yet. Agents note here what they set up in {vm.name}, so the next one knows.</p>
        )}
        {vm.notes.map((note) => (
          <div key={note.id} className="group border-b py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {note.by === "user" && (
                <span className="flex items-center gap-1 font-medium text-foreground">
                  <User className="size-3.5" /> You
                </span>
              )}
              {note.by !== "user" && (
                <a href={`#/agents/${note.by}`} className="font-medium text-primary hover:underline">
                  {agentNames[note.by] ?? note.by}
                </a>
              )}
              <span>{new Date(note.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
              {note.desktop !== undefined && <span>Desktop {note.desktop}</span>}
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                disabled={busy !== ""}
                onClick={() => removeNote(note.id)}
              >
                {busy === note.id && <Loader2 className="animate-spin" />}
                Remove
              </Button>
            </div>
            <div className="mt-0.5 whitespace-pre-wrap">{note.text}</div>
          </div>
        ))}

        <div className="mt-3 space-y-2">
          <Textarea
            placeholder={`A note on what is set up in ${vm.name}, for the agents`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && text.trim() !== "" && busy === "") {
                event.preventDefault();
                addNote();
              }
            }}
          />
          <Button size="sm" disabled={text.trim() === "" || busy !== ""} onClick={addNote}>
            {busy === "add" ? <Loader2 className="animate-spin" /> : <Plus />} Add note
          </Button>
        </div>
      </div>
    </div>
  );
}
