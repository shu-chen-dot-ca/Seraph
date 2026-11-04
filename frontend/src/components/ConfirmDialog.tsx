import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/*
The one "Are you sure?" every action that changes something asks: a title, what will happen, and the button that does
it. Enter confirms (not inside a text box, where Enter is a new line). While onConfirm runs the button spins; when it
throws, the error shows in the dialog and it stays open. Mounting it opens it; onClose closes it.
*/

export default function ConfirmDialog(props: {
  title: string;
  children?: ReactNode;
  confirm: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    if (busy || props.disabled) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await props.onConfirm();
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        onKeyDown={(event) => {
          if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            confirm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription className="sr-only">{props.title}</DialogDescription>
        </DialogHeader>
        {props.children && <div className="flex flex-col gap-3">{props.children}</div>}
        {error !== "" && <p className="border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button size="sm" variant={props.danger ? "destructive" : "default"} disabled={busy || props.disabled} onClick={confirm}>
            {busy && <Loader2 className="animate-spin" />}
            {props.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
