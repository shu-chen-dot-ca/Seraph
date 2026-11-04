import { useState } from "react";

import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import AddProjectDialog from "@/dialogs/AddProjectDialog";
import { projectItems, useProjects, type ProjectKind } from "@/model/projects";
import { DONE_STAGES, useWorkItems } from "@/model/work";
import { href } from "@/routes";

/*
Every project, private ones first, then open source: how many issues are open in each and how many wait for you.
On a computer the projects are in the left list too; this page is the phone's Projects tab.
*/

const GROUPS: { kind: ProjectKind; title: string }[] = [
  { kind: "private", title: "Private" },
  { kind: "open source", title: "Open source" },
];

export default function ProjectsPage() {
  const items = useWorkItems();
  const projects = useProjects(items);
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <PageHeader
        title="Projects"
        meta="Every repository you work on"
        right={
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            Add or find projects
          </Button>
        }
      />
      {GROUPS.map((group) => (
        <div key={group.kind}>
          <div className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.title}</div>
          {projects
            .filter((project) => project.kind === group.kind)
            .map((project) => {
              const work = projectItems(project, items);
              const open = work.filter((item) => !DONE_STAGES.includes(item.stage)).length;
              const waiting = work.filter((item) => item.waiting !== null || item.waitingPR !== null).length;
              return (
                <a key={project.key} href={href.project(project.repo)} className="flex items-center gap-3 border-b px-4 py-2 hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate font-medium">{project.repo}</span>
                  {waiting > 0 && <Badge>{waiting} waiting for you</Badge>}
                  <span className="w-16 text-right text-xs text-muted-foreground">{open} open</span>
                </a>
              );
            })}
        </div>
      ))}
      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
