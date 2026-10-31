/*
Settings → About: the version of the app that runs, and its updates (github_searcher/updates.py).

The live copy (deploy/install.sh) checks GitHub for a newer release every 15 minutes and gets it ready in the
background; Update in the header (UpdateDialog.tsx) then restarts on it. Check for updates asks GitHub now.
Previous version (asks first) goes back to the release before this one, with your data as it was just before the
update; what changed since then is kept in a copy in ~/seraph/backups, not deleted. The dev copy (./run.sh) has no
updates.
*/

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api, useLive } from "@/live";
import { timeAgo } from "@/lib/utils";

export default function About() {
  const updates = useLive("updates");
  const [confirming, setConfirming] = useState(false);

  async function check() {
    try {
      await api("/api/updates/check", { method: "POST" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function goBack() {
    setConfirming(false);
    try {
      await api("/api/updates/previous", { method: "POST" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  let state = "Not checked yet.";
  if (updates.restarting) {
    state = "Restarting…";
  } else if (updates.preparing !== null) {
    state = `Getting ${updates.preparing} ready…`;
  } else if (updates.checking) {
    state = "Checking for updates…";
  } else if (updates.ready !== null) {
    state = `${updates.ready} is ready: Update in the header restarts on it.`;
  } else if (updates.checked_at !== null && updates.latest === null) {
    state = "No release on GitHub yet.";
  } else if (updates.checked_at !== null) {
    state = `Up to date. Checked ${timeAgo(updates.checked_at)}.`;
  }
  const busy = updates.checking || updates.restarting;

  return (
    <section>
      <div className="mb-2 font-medium">About</div>
      {!updates.live && <p className="text-muted-foreground">Seraph, the dev copy. Updates are for the live copy (deploy/install.sh).</p>}
      {updates.live && (
        <div className="space-y-2">
          <div>
            Seraph {updates.running}
            {updates.switched_at !== null && <span className="ml-2 text-xs text-muted-foreground">Updated {timeAgo(updates.switched_at)}</span>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {state}
          </div>
          {updates.error !== "" && <p className="border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{updates.error}</p>}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={check} disabled={busy}>
              Check for updates
            </Button>
            {updates.previous !== null && (
              <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={busy}>
                Previous version
              </Button>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Go back to {updates.previous}?</AlertDialogTitle>
            <AlertDialogDescription>
              The app restarts on {updates.previous}, with your data as it was just before you updated
              {updates.switched_at !== null ? ` (${timeAgo(updates.switched_at)})` : ""}. Drafts, jobs and chats from since then are kept in a
              copy in ~/seraph/backups, not deleted. VMs keep running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={goBack}>Go back</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
