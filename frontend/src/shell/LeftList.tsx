import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { useLive } from "@/live";
import { cn } from "@/lib/utils";
import { useInbox } from "@/model/inbox";
import { groupProjects, projectItems, useProjects, type Project } from "@/model/projects";
import { useWorkItems } from "@/model/work";
import { href, type Route } from "@/routes";

/*
The left list on a computer, the row of tabs at the bottom on a phone.
- Dashboard, with how many questions (amber) and approvals wait, and how many notifications are unread.
- Repositories: opens the page with all of them (pages/ProjectsPage.tsx). Under it the ones you pinned there, in that
  page's order (private ones first), each with how many things in it wait for you. Its arrow folds them away or opens them again,
  remembered in this browser. On a phone it is one tab, without the pinned ones.
- Agents and Machines.
*/

const FOLDED_STORAGE = "repositories-folded";

type Item = { link: string; label: string; current: boolean; counts: { n: number; tone: "warn" | "primary" | "muted" }[]; computer?: boolean };

function Link(props: { item: Item; className?: string }) {
  const item = props.item;
  return (
    <a
      href={item.link}
      title={item.label}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground max-md:shrink-0 max-md:flex-col max-md:gap-0.5 max-md:px-2 max-md:py-1 max-md:text-[11px]",
        item.current && "bg-sidebar-accent font-medium text-foreground",
        item.computer && "max-md:hidden",
        props.className,
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
  const layout = useLive("repo_groups");
  const { questions, approvals } = useInbox();
  const notifications = useLive("notifications");
  // Whether the pinned ones are folded away in this browser. Storage can be blocked: then they start open.
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLDED_STORAGE) === "yes";
    } catch {
      return false;
    }
  });
  const route = props.route;
  const unread = notifications.items.filter((item) => item.unread).length;
  const onProject = route.page === "project" || route.page === "work" ? route.repo.toLowerCase() : null;

  function fold() {
    setFolded(!folded);
    try {
      localStorage.setItem(FOLDED_STORAGE, folded ? "no" : "yes");
    } catch {
      // Storage blocked: the fold just isn't kept.
    }
  }

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

  // In the Repositories page's order: Private, then Open source, each by its groups, then Ungrouped.
  const pinned: Project[] = [];
  for (const section of groupProjects(projects, layout)) {
    for (const group of section.groups) {
      for (const project of group.projects) {
        if (layout.pinned.includes(project.key)) {
          pinned.push(project);
        }
      }
    }
  }
  const shown = folded ? [] : pinned;

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
  // Current on its page, and on a repository's that isn't shown under it.
  const repositories: Item = {
    link: href.projects(),
    label: "Repositories",
    current: route.page === "projects" || (onProject !== null && !shown.some((project) => project.key === onProject)),
    counts: [],
  };
  const agents: Item = { link: href.agents(), label: "Agents", current: route.page === "agents" || route.page === "agent", counts: [] };
  const machines: Item = { link: href.machines(), label: "Machines", current: route.page === "machines" || route.page === "machine" || route.page === "phone-vm", counts: [] };

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-px overflow-auto border-r bg-sidebar p-1.5 max-md:order-2 max-md:w-auto max-md:flex-row max-md:justify-around max-md:border-t max-md:border-r-0">
      <Link item={dashboard} />
      {/* On a phone the row is just its tab. */}
      <div className="flex items-center gap-px max-md:contents">
        <Link item={repositories} className="md:flex-1" />
        {pinned.length > 0 && (
          <button
            type="button"
            aria-label={folded ? "Show pinned repositories" : "Hide pinned repositories"}
            onClick={fold}
            className="rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground max-md:hidden"
          >
            <ChevronRight className={cn("size-3 transition-transform", !folded && "rotate-90")} />
          </button>
        )}
      </div>
      {shown.map((project) => (
        <Link key={project.key} item={projectItem(project)} className="pl-4" />
      ))}
      <div className="my-1.5 border-t max-md:hidden" />
      <Link item={agents} />
      <Link item={machines} />
    </nav>
  );
}
