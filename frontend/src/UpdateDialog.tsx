/*
The Update dialog, from Update in the header once a newer release is ready (github_searcher/updates.py: the live copy
checks GitHub every 15 minutes and gets a new release ready in the background). It shows what's new (the release's
notes on GitHub), then Restart or Later.

Restart waits for a moment when no agent is in the middle of a tool call (up to a minute), then the app restarts on
the new release. VMs, and the runs in them, keep going; agents carry on where they were. The header says Restarting…,
and every open page reloads into the new version at the same place (live.ts). If the new release doesn't start within
a minute, the app goes back to this one by itself, and this dialog says so the next time.
*/

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { api, useLive } from "@/live";

export default function UpdateDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const updates = useLive("updates");
  const [starting, setStarting] = useState(false);

  async function restart() {
    setStarting(true);
    try {
      await api("/api/updates/restart", { method: "POST" });
      props.onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setStarting(false);
  }

  // The notes are the latest release's: the one that is ready.
  let notes = "";
  if (updates.latest !== null && updates.latest.tag === updates.ready) {
    notes = updates.latest.notes.trim();
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update to {updates.ready}</DialogTitle>
          <DialogDescription>
            You have {updates.running}. The app restarts on the new version: agents pause for a few seconds and carry on, and VMs keep
            running.
          </DialogDescription>
        </DialogHeader>
        {updates.failed !== null && updates.failed === updates.ready && (
          <p className="border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">
            The last try didn't start within a minute, so the app went back to {updates.running}. Its log: journalctl --user -u seraph
          </p>
        )}
        {notes !== "" && <Markdown text={notes} />}
        {notes === "" && <p className="text-muted-foreground">This release has no notes.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Later
          </Button>
          <Button onClick={restart} disabled={starting || updates.ready === null}>
            {starting && <Loader2 className="animate-spin" />} Restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
