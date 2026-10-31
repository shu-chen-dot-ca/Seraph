/*
New issue, in one of your repositories or stars (the New issue button on its page, Repository.tsx): a title and a
description (markdown, like on GitHub), then Submit new issue, which asks "Open this issue as @you?" and opens it on
GitHub as you (github_searcher/your_repositories.py). Once it is open, a message says so with Open (on GitHub), and the
pop-up closes. Cancel, Esc or a click outside closes it; what you wrote is kept until it is sent.
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/live";

export default function NewIssueDialog(props: { repo: string; login: string; open: boolean; onClose: () => void; onOpened: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const result = await api<{ done: string; url: string | null }>("/api/your_repositories/act", {
        method: "POST",
        body: { repo: props.repo, action: "new_issue", fields: { title: title, body: body } },
      });
      toast.success(result.done, {
        action: result.url !== null ? { label: "Open", onClick: () => window.open(result.url ?? "", "_blank", "noopener,noreferrer") } : undefined,
      });
      setTitle("");
      setBody("");
      props.onOpened();
      props.onClose();
    } catch (err) {
      toast.error(`Could not open it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent aria-describedby={undefined} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New issue in {props.repo}</DialogTitle>
        </DialogHeader>
        <Input placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea
          placeholder="Description. Markdown works, like on GitHub."
          className="min-h-48"
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={title.trim() === "" || busy} onClick={() => setConfirmOpen(true)}>
            {busy && <Loader2 className="animate-spin" />}
            Submit new issue
          </Button>
        </DialogFooter>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Open this issue as @{props.login}?</AlertDialogTitle>
              <AlertDialogDescription>
                It is opened in {props.repo} on GitHub, with the title and description you wrote. Everyone who can see the repo can see it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={submit}>Submit new issue</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
