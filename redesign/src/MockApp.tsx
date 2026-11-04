import { Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { AGENTS, NOTIFICATIONS, VMS, WORK, WORK_BY_ID } from "@/data";
import { InboxItem, Inbox, NotificationList } from "@/InboxPage";
import { href } from "@/links";
import { cn } from "@/lib/utils";
import { DesktopPage, MachineList, MachinePage } from "@/MachinesPage";
import { AddProjectDialog, AskAgentDialog, FixIssueDialog, NewIssueDialog } from "@/NewDialogs";
import { OpenIssuePage, ProjectList, ProjectPage } from "@/ProjectsPage";
import SettingsPage from "@/SettingsPage";
import { allIssues, allProjects, openDrafts, useStore } from "@/store";
import { AgentPage, TeamList } from "@/TeamPage";
import { WorkItem } from "@/WorkPage";

/*
The mock Seraph as picked in rounds 1 and 2: one page per project, an Inbox with Questions and Approvals tabs, project
boards, and two-line rows. The 36px header stays, like the real app's: Go to (find any issue, project, agent or VM by
name or number), New (start any kind of work from one place), and your picture (Settings, Sign out). Under it:
- the left list: Inbox, Notifications, the projects (Private, Open source, Add or find projects), Team, Machines;
- the open page.
On a narrow screen (a phone, or Phone in the top bar) the left list becomes a row of tabs at the bottom, with one
Projects tab in place of every project. Pop-ups cover only this mock (the transform on the root keeps them in).
*/

type NavItem = { link: string; label: string; match: string[]; counts?: { n: number; warn?: boolean }[]; desktop?: boolean; phone?: boolean };

export default function MockApp(props: { parts: string[] }) {
  const { store } = useStore();
  const section = props.parts[0] || "questions";
  const id = props.parts[1] ? decodeURIComponent(props.parts[1]) : null;
  const sub = props.parts[2] ? decodeURIComponent(props.parts[2]) : null;
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<"new" | "account" | null>(null);
  const [dialog, setDialog] = useState<"fix" | "issue" | "ask" | "add" | null>(null);

  const questions = openDrafts(store, "question");
  const approvals = openDrafts(store, "approval");
  const unread = NOTIFICATIONS.filter((each) => !store.read.includes(each.id)).length;
  const projects = allProjects(store);

  // The left list: what waits on you first, then the projects, then Team and Machines.
  const projectItems = (group: string): NavItem[] =>
    projects
      .filter((project) => project.group === group)
      .map((project) => {
        const waiting = [...questions, ...approvals].filter((draft) => WORK_BY_ID[draft.work].short === project.id).length;
        return { link: `#/p/${project.id}`, label: project.id, match: [`p/${project.id}`], counts: waiting ? [{ n: waiting }] : [], desktop: true };
      });
  const nav: (NavItem | string)[] = [
    {
      link: questions.length > 0 ? "#/questions" : "#/approvals",
      label: "Inbox",
      match: ["questions", "approvals"],
      counts: [
        { n: questions.length, warn: true },
        { n: approvals.length },
      ],
    },
    { link: "#/notifications", label: "Notifications", match: ["notifications"], counts: unread ? [{ n: unread, warn: false }] : [] },
    { link: "#/projects", label: "Projects", match: ["projects", ...projects.map((project) => `p/${project.id}`)], phone: true },
    "Private",
    ...projectItems("Private"),
    "Open source",
    ...projectItems("Open source"),
    "add",
    "",
    { link: "#/team", label: "Team", match: ["team"] },
    { link: "#/machines", label: "Machines", match: ["machines"] },
  ];
  const current = section === "p" ? `p/${id}` : section;

  // Go to: everything whose name or number has what you typed.
  const q = query.trim().toLowerCase();
  const results: { label: string; text: string; link: string }[] = [];
  if (q !== "") {
    for (const work of WORK) {
      if (`${work.title} ${work.ref} ${work.pr ?? ""}`.toLowerCase().includes(q)) {
        results.push({ label: "Issue", text: `${work.ref} · ${work.title}`, link: href("work", work.id) });
      }
    }
    for (const issue of allIssues(store)) {
      if (`${issue.title} ${issue.ref}`.toLowerCase().includes(q)) {
        results.push({ label: "Issue", text: `${issue.ref} · ${issue.title}`, link: `#/p/${issue.short}/${issue.id}` });
      }
    }
    for (const project of projects) {
      if (project.full.toLowerCase().includes(q)) {
        results.push({ label: "Project", text: project.full, link: href("project", project.id) });
      }
    }
    for (const name of Object.keys(AGENTS)) {
      if (name.includes(q)) {
        results.push({ label: "Agent", text: `${name} · ${AGENTS[name].note}`, link: href("agent", name) });
      }
    }
    for (const name of Object.keys(VMS)) {
      if (name.includes(q)) {
        results.push({ label: "VM", text: `${name} · ${VMS[name].status}`, link: href("vm", name) });
      }
    }
    for (const draft of [...questions, ...approvals]) {
      if (draft.ask.toLowerCase().includes(q)) {
        results.push({ label: draft.group === "question" ? "Question" : "Approval", text: draft.ask, link: href("draft", draft.id) });
      }
    }
  }

  let page: ReactNode = null;
  if (section === "questions" || section === "approvals") {
    page = id ? <InboxItem key={id} id={id} /> : <Inbox tab={section} />;
  }
  if (section === "notifications") {
    page = <NotificationList />;
  }
  if (section === "projects") {
    page = <ProjectList />;
  }
  if (section === "p" && id) {
    page = <ProjectPage key={id} id={id} />;
    if (sub && sub.startsWith("i")) {
      page = <OpenIssuePage id={sub} />;
    }
    if (sub && sub.startsWith("w")) {
      page = <WorkItem id={sub} />;
    }
  }
  if (section === "team") {
    page = id ? <AgentPage id={id} /> : <TeamList />;
  }
  if (section === "machines") {
    page = id ? <MachinePage id={id} /> : <MachineList />;
    if (id && sub) {
      page = <DesktopPage vm={id} n={Number(sub)} />;
    }
  }
  if (section === "settings") {
    page = <SettingsPage />;
  }

  return (
    <div className="@container flex h-full flex-col bg-background [transform:translateZ(0)]">
      <header className="relative flex h-9 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        <span className="mr-2 font-semibold @max-2xl:hidden">Seraph</span>
        <div className="relative mx-auto w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && results.length > 0) {
                window.location.hash = results[0].link;
                setQuery("");
              }
              if (event.key === "Escape") {
                setQuery("");
              }
            }}
            placeholder="Go to: an issue, project, agent or VM"
            aria-label="Go to"
            className="h-6 w-full rounded-md border bg-background pr-2 pl-7 text-[12.5px] outline-none focus-visible:border-ring"
          />
          {q !== "" && (
            <div className="absolute inset-x-0 top-7 z-30 max-h-72 overflow-auto rounded-lg border bg-popover p-1 shadow-overlay">
              {results.length === 0 && <div className="px-2 py-1.5 text-muted-foreground">Nothing found</div>}
              {results.slice(0, 8).map((result) => (
                <a key={result.label + result.link} href={result.link} onClick={() => setQuery("")} className="flex gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                  <span className="w-16 shrink-0 text-muted-foreground">{result.label}</span>
                  <span className="truncate">{result.text}</span>
                </a>
              ))}
            </div>
          )}
        </div>
        <Button size="xs" onClick={() => setMenu(menu === "new" ? null : "new")}>
          <Plus /> New
        </Button>
        <button
          type="button"
          onClick={() => setMenu(menu === "account" ? null : "account")}
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-semibold text-sidebar-foreground hover:ring-2 hover:ring-ring/40"
          aria-label="Your account"
        >
          S
        </button>
        {menu !== null && <div className="fixed inset-0 z-20" onClick={() => setMenu(null)} />}
        {menu === "new" && (
          <div className="absolute top-8 right-10 z-30 w-56 rounded-lg border bg-popover p-1 shadow-overlay">
            {[
              ["fix", "Fix an issue", "Pick an open issue and assign it"],
              ["issue", "New issue", "Say what should change in a project"],
              ["ask", "Ask an agent", "Write to any agent"],
            ].map((item) => (
              <button
                key={item[0]}
                type="button"
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => {
                  setMenu(null);
                  setDialog(item[0] as "fix" | "issue" | "ask");
                }}
              >
                <span>{item[1]}</span>
                <span className="text-xs text-muted-foreground">{item[2]}</span>
              </button>
            ))}
          </div>
        )}
        {menu === "account" && (
          <div className="absolute top-8 right-2 z-30 w-44 rounded-lg border bg-popover p-1 shadow-overlay">
            <a href="#/settings" onClick={() => setMenu(null)} className="block rounded-md px-2 py-1.5 hover:bg-accent">
              Settings
            </a>
            <a href="#/settings" onClick={() => setMenu(null)} className="block rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent">
              Sign out
            </a>
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 @max-2xl:flex-col">
        <nav className="flex w-44 shrink-0 flex-col gap-px overflow-auto border-r bg-sidebar p-1.5 @max-2xl:order-2 @max-2xl:w-auto @max-2xl:flex-row @max-2xl:border-t @max-2xl:border-r-0">
          {nav.map((item, index) => {
            if (item === "add") {
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => setDialog("add")}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-sidebar-accent hover:text-foreground @max-2xl:hidden"
                >
                  <Plus className="size-3.5" /> Add or find projects
                </button>
              );
            }
            if (item === "") {
              return <div key={index} className="my-1.5 border-t @max-2xl:hidden" />;
            }
            if (typeof item === "string") {
              return (
                <div key={index} className="px-2 pt-2.5 pb-1 text-[11px] text-muted-foreground @max-2xl:hidden">
                  {item}
                </div>
              );
            }
            return (
              <a
                key={item.link + item.label}
                href={item.link}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground @max-2xl:shrink-0 @max-2xl:flex-col @max-2xl:gap-0.5 @max-2xl:px-2.5 @max-2xl:py-1 @max-2xl:text-[11px]",
                  item.match.includes(current) && "bg-sidebar-accent font-medium text-foreground",
                  item.desktop && "@max-2xl:hidden",
                  item.phone && "hidden @max-2xl:flex",
                )}
              >
                <span className="truncate">{item.label}</span>
                <span className="flex gap-1">
                  {(item.counts ?? [])
                    .filter((count) => count.n > 0)
                    .map((count, at) => (
                      <span
                        key={at}
                        className={cn(
                          "min-w-4.5 rounded-full px-1.5 text-center text-xs leading-4.5 font-medium tabular-nums",
                          count.warn === true && "bg-warn text-background",
                          count.warn === undefined && "bg-primary text-primary-foreground",
                          count.warn === false && "bg-muted text-muted-foreground",
                        )}
                      >
                        {count.n}
                      </span>
                    ))}
                </span>
              </a>
            );
          })}
        </nav>
        {/* A new page starts at the top. */}
        <main key={props.parts.join("/")} className="relative min-w-0 flex-1 overflow-auto">
          <div className="min-h-full">{page}</div>
        </main>
      </div>

      {dialog === "fix" && <FixIssueDialog onClose={() => setDialog(null)} />}
      {dialog === "issue" && <NewIssueDialog onClose={() => setDialog(null)} project={section === "p" && id ? id : undefined} />}
      {dialog === "ask" && <AskAgentDialog onClose={() => setDialog(null)} />}
      {dialog === "add" && <AddProjectDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
