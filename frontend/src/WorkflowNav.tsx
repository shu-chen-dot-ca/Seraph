/*
The Workflow part of the Home tab's left list (Sidebar.tsx shows it under its Workflow heading, with the same rows): its
repositories, each with how many pull requests wait for your decision there, the open one marked (with none picked, the
first, which the page shows). Add repository, the last row, opens AddRepositoryDialog.
*/

import { BookMarked, Plus } from "lucide-react";
import { useState } from "react";

import AddRepositoryDialog from "@/AddRepositoryDialog";
import { useLive } from "@/live";
import { cn } from "@/lib/utils";

export default function WorkflowNav(props: { repo: string | null; open: boolean }) {
  const repos = useLive("workflow");
  const [adding, setAdding] = useState(false);
  // The same rows as the sidebar's (Sidebar.tsx).
  const row = "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 pl-6 font-medium hover:bg-sidebar-accent hover:text-foreground";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>svg]:text-primary";
  const icon = "size-4 shrink-0 text-muted-foreground";
  const shown = props.repo ?? (repos.length > 0 ? repos[0].repo : "");

  return (
    <>
      {repos.length === 0 && <div className="py-1 pr-2 pl-6 text-muted-foreground">None yet</div>}
      {repos.map((each) => {
        const waiting = each.decides === "you" ? Object.values(each.prs).filter((pr) => pr.state === "waiting").length : 0;
        return (
          <a
            key={each.repo}
            href={`#/workflow?repo=${encodeURIComponent(each.repo)}`}
            className={cn(row, props.open && each.repo.toLowerCase() === shown.toLowerCase() && selected)}
            title={each.repo}
          >
            <BookMarked className={icon} />
            <span className="min-w-0 flex-1 truncate">{each.repo.split("/")[1]}</span>
            {waiting > 0 && (
              <span className="min-w-4.5 shrink-0 rounded-full bg-primary px-1.5 text-center text-xs leading-4.5 font-medium text-primary-foreground tabular-nums">
                {waiting}
              </span>
            )}
          </a>
        );
      })}

      <button type="button" className={row} onClick={() => setAdding(true)}>
        <Plus className={icon} />
        Add repository
      </button>
      <AddRepositoryDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
