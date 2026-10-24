/*
Fork a stopped VM: a new VM that starts as an exact copy of it. Its disk (everything installed and cloned),
CPU, memory, disk size, internet setting and env variables come along; nobody holds it and nobody waits for it.

POST /api/vms/<name>/fork answers at once; the fork shows up in the VM list as "creating" and runs on its
own after about a minute. The source can start again as soon as the copy is made (seconds).
*/

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type VMOptions } from "@/live";

export default function ForkVMDialog(props: { vm: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The first free name (vm1, vm2, ...) to start with.
  useEffect(() => {
    let stopped = false;
    api<VMOptions>("/api/vms/options")
      .then((answer) => {
        if (!stopped) {
          setName((current) => current || answer.next_name);
        }
      })
      .catch(() => {
        // Then the user types a name.
      });
    return () => {
      stopped = true;
    };
  }, []);

  const nameValid = /^[a-z][a-z0-9-]{0,30}$/.test(name);

  async function submit() {
    if (!nameValid || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/vms/${encodeURIComponent(props.vm)}/fork`, { method: "POST", body: { name } });
      toast.success(`Forking ${props.vm} into ${name}. It runs in about a minute.`);
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
          <DialogTitle>Fork {props.vm}</DialogTitle>
          <DialogDescription>
            A new VM that starts as an exact copy of {props.vm}: everything on its disk, its CPU, memory, internet setting and env variables.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-x-3 gap-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="fork-vm-name" className="text-muted-foreground">
            Name
          </label>
          <Input
            id="fork-vm-name"
            value={name}
            spellCheck={false}
            autoFocus
            aria-invalid={!nameValid}
            onChange={(event) => setName(event.target.value.trim().toLowerCase())}
          />
          {!nameValid && <p className="col-start-2 text-xs text-destructive">Lowercase letters, digits and dashes; starts with a letter.</p>}
          <button type="submit" className="hidden" />
        </form>
        {error !== "" && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!nameValid || busy}>
            {busy && <Loader2 className="animate-spin" />} Fork
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
