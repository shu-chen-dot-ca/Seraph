import { useState } from "react";

import AssignDialog from "@/AssignDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { IssueItem } from "@/live";
import { useWorkItems } from "@/model/work";

/*
Fix an issue (New in the header): every open issue nobody works on, from every project's Open column. Picking one
opens Assign (AssignDialog.tsx: who and on which VM), which starts the agent.
*/

export default function FixIssueDialog(props: { onClose: () => void }) {
  const items = useWorkItems();
  const [chosen, setChosen] = useState<IssueItem | null>(null);
  if (chosen !== null) {
    return <AssignDialog issue={chosen} onClose={props.onClose} />;
  }
  const open = [...items.values()].filter((item) => item.stage === "open" && item.issue !== null).sort((a, b) => a.repo.localeCompare(b.repo));
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Fix an issue</DialogTitle>
          <DialogDescription>Open issues nobody works on. Pick one to assign it.</DialogDescription>
        </DialogHeader>
        {open.length === 0 && <p className="text-muted-foreground">No open issues. Find some on an open-source project's page.</p>}
        <div className="flex flex-col gap-1">
          {open.map((item) => (
            <button key={item.key} type="button" onClick={() => setChosen(item.issue)} className="flex flex-col rounded-md border px-3 py-2 text-left hover:border-primary">
              <span className="font-medium">{item.title}</span>
              <span className="text-xs text-muted-foreground">
                {item.repo} #{item.number}
                {item.issue?.tags?.merge && ` · ${item.issue.tags.merge}`}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
