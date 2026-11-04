import { Plus } from "lucide-react";
import { useState } from "react";

import AddProjectDialog from "@/dialogs/AddProjectDialog";
import { useLive } from "@/live";
import { cn } from "@/lib/utils";
import { useInbox } from "@/model/inbox";
import { projectItems, useProjects, type Project } from "@/model/projects";
import { useWorkItems } from "@/model/work";
import { href, type Route } from "@/routes";

/*
The left list on a computer, the row of tabs at the bottom on a phone.
- Dashboard, with how many questions (amber) and approvals wait, and how many notifications are unread.
- The projects: Private, then Open source, each with how many things in it wait for you; Add or find projects.
  On a phone they are one Projects tab instead.
- Team and Machines.
*/

type Item = { link: string; label: string; current: boolean; counts: { n: number; tone: "warn" | "primary" | "muted" }[]; computer?: boolean; phone?: boolean };

function Link(props: { item: Item }) {
  const item = props.item;
  return (
    <a
      href={item.link}
      title={item.label}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground max-md:shrink-0 max-md:flex-col max-md:gap-0.5 max-md:px-3 max-md:py-1 max-md:text-[11px]",
        item.current && "bg-sidebar-accent font-medium text-foreground",
        item.computer && "max-md:hidden",
        item.phone && "md:hidden",
      )}
    >
      <span className="truncate">{item.label}</span>
      <span className="flex gap-1">
        {item.counts
          .filter((count) => count.n > 0)
          .map((count, index) => (
            <span
              key={index}
              className={cn(
                "min-w-4.5 rounded-full px-1.5 text-center text-xs leading-4.5 font-medium tabular-nums",
                count.tone === "warn" && "bg-warn text-background",
                count.tone === "primary" && "bg-primary text-primary-foreground",
                count.tone === "muted" && "bg-muted text-muted-foreground",
              )}
            >
              {count.n}
            </span>
          ))}
      </span>
    </a>
  );
}

export default function LeftList(props: { route: Route }) {
  const items = useWorkItems();
  const projects = useProjects(items);
  const { questions, approvals } = useInbox();
  const notifications = useLive("notifications");
  const [adding, setAdding] = useState(false);
  const route = props.route;
  const unread = notifications.items.filter((item) => item.unread).length;
  const onProject = route.page === "project" || route.page === "work" ? route.repo.toLowerCase() : null;

  function projectItem(project: Project): Item {
    const waiting = projectItems(project, items).filter((item) => item.waiting !== null || item.waitingPR !== null).length;
    return {
      link: href.project(project.repo),
      label: project.repo,
      current: onProject === project.key,
      counts: [{ n: waiting, tone: "primary" }],
      computer: true,
    };
  }

  const dashboard: Item = {
    link: href.dashboard(),
    label: "Dashboard",
    current: route.page === "dashboard" || route.page === "inbox-item",
    counts: [
      { n: questions.length, tone: "warn" },
      { n: approvals.length, tone: "primary" },
      { n: unread, tone: "muted" },
    ],
  };
  const projectsItem: Item = { link: href.projects(), label: "Projects", current: route.page === "projects" || onProject !== null, counts: [], phone: true };
  const team: Item = { link: href.team(), label: "Team", current: route.page === "team" || route.page === "agent", counts: [] };
  const machines: Item = { link: href.machines(), label: "Machines", current: route.page === "machines" || route.page === "machine" || route.page === "phone-vm", counts: [] };
  const privateProjects = projects.filter((project) => project.kind === "private");
  const openSource = projects.filter((project) => project.kind === "open source");

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-px overflow-auto border-r bg-sidebar p-1.5 max-md:order-2 max-md:w-auto max-md:flex-row max-md:justify-around max-md:border-t max-md:border-r-0">
      <Link item={dashboard} />
      <Link item={projectsItem} />
      {privateProjects.length > 0 && <div className="px-2 pt-3 pb-1 text-[11px] text-muted-foreground max-md:hidden">Private</div>}
      {privateProjects.map((project) => (
        <Link key={project.key} item={projectItem(project)} />
      ))}
      {openSource.length > 0 && <div className="px-2 pt-3 pb-1 text-[11px] text-muted-foreground max-md:hidden">Open source</div>}
      {openSource.map((project) => (
        <Link key={project.key} item={projectItem(project)} />
      ))}
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-foreground max-md:hidden"
      >
        <Plus className="size-3.5" /> Add or find projects
      </button>
      <div className="my-1.5 border-t max-md:hidden" />
      <Link item={team} />
      <Link item={machines} />
      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
    </nav>
  );
}
