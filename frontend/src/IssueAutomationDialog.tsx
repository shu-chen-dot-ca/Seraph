/*
One issue's level of automation, opened by the ⋯ on its card on the Dashboard's Issues board (IssueBoard.tsx). Only the
settings for now: nothing acts on them yet, and they are kept in this browser (localStorage "automation:issue:<id>"), like
a repo's (AutomationDialog.tsx).

The repo's Level of automation is each of its issues' default; this changes it for this issue only, nothing about the
repo: Questions, Comments and Pull requests. Take issues is the repo's only (AutomationDialog.tsx). It opens on what the issue has now (its own, else the repo's).
Save keeps them for the issue; Use repo default (only once the issue has its own) drops them, so the repo's count again.
Cancel, Esc or the X drop the changes.
*/

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SelectBox } from "@/components/ui/row-selection";

// What agents do on an issue without asking you: the same keys as a repo's Level of automation.
export type Level = { questions: boolean; comments: boolean; pull_requests: boolean };

export default function IssueAutomationDialog(props: { id: string; name: string; level: Level; own: boolean; onClose: () => void }) {
  const key = `automation:issue:${props.id}`;
  const [questions, setQuestions] = useState(props.level.questions);
  const [comments, setComments] = useState(props.level.comments);
  const [pullRequests, setPullRequests] = useState(props.level.pull_requests);

  function save() {
    const next: Level = { questions: questions, comments: comments, pull_requests: pullRequests };
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      toast.error("Could not save: this browser keeps nothing (a private window?)");
      return;
    }
    props.onClose();
  }

  function useDefault() {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing was kept.
    }
    props.onClose();
  }

  const option = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent";

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{props.name}</DialogTitle>
        </DialogHeader>

        <div>
          <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Level of automation</div>
          <button type="button" className={option} onClick={() => setQuestions(!questions)}>
            <SelectBox checked={questions} />
            Questions
          </button>
          <button type="button" className={option} onClick={() => setComments(!comments)}>
            <SelectBox checked={comments} />
            Comments
          </button>
          <button type="button" className={option} onClick={() => setPullRequests(!pullRequests)}>
            <SelectBox checked={pullRequests} />
            Pull requests
          </button>
        </div>

        <DialogFooter>
          {props.own && (
            <Button variant="outline" className="sm:mr-auto" onClick={useDefault}>
              Use repo default
            </Button>
          )}
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
