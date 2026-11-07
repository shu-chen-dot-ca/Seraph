/*
The Workflow tab's left list (App.tsx shows it instead of the sidebar on the Workflow tab, with the same look): its
repositories, each with how many pull requests wait for your decision there, the open one marked (with none picked, the
first, which the page shows). Add repository, pinned at the bottom, opens AddRepositoryDialog. In phone mode it is in
the Menu instead, under the other tabs' lists.
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
  const row = "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 font-medium hover:bg-sidebar-accent hover:text-foreground";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>svg]:text-primary";
  const icon = "size-4 shrink-0 text-muted-foreground";
  const shown = props.repo ?? (repos.length > 0 ? repos[0].repo : "");

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="px-2 pt-1 pb-1 text-xs font-medium text-muted-foreground">Repositories</div>
        {repos.length === 0 && <div className="px-2 py-1 text-muted-foreground">None yet</div>}
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
      </div>

      <div className="border-t p-2">
        <button type="button" className={row} onClick={() => setAdding(true)}>
          <Plus className={icon} />
          Add repository
        </button>
      </div>
      <AddRepositoryDialog open={adding} onClose={() => setAdding(false)} />
    </nav>
  );
}
