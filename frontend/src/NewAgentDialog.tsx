/*
The New agent dialog: just a name. Its placeholder is the name the agent gets when the field is left empty
(the first free "agent-N", as the backend picks it); a typed name is used instead.
"Create" posts /api/agents and opens the new agent's page.
*/

import { Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, useLive } from "@/live";

export default function NewAgentDialog(props: { onClose: () => void }) {
  const agents = useLive("agents");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The name the agent gets when Name is left empty: the first free "agent-N".
  const takenNames = agents.map((each) => each.name);
  let number = 1;
  while (takenNames.includes(`agent-${number}`)) {
    number += 1;
  }
  const defaultName = `agent-${number}`;

  async function submit() {
    if (busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const agent = await api<{ id: string }>("/api/agents", { method: "POST", body: { name: name.trim() } });
      window.location.hash = `#/agents/${agent.id}`;
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
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>It starts idle. Give it a job from the Jobs or Issues page, or chat with it.</DialogDescription>
        </DialogHeader>

        <form
          className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 gap-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="new-agent-name" className="text-muted-foreground">
            Name
          </label>
          <Input id="new-agent-name" autoFocus placeholder={defaultName} value={name} onChange={(event) => setName(event.target.value)} />
          {/* Lets Enter in the field submit the form. */}
          <button type="submit" className="hidden" />
        </form>

        {error !== "" && <p className="text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
