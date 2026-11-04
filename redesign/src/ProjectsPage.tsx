import { useState } from "react";

import AssignDialog from "@/AssignDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PageHeader from "@/PageHeader";
import { AGENTS, DRAFT_BY_ID, WORK, WORK_BY_ID, type OpenIssue, type Project } from "@/data";
import { Go, href, toast } from "@/links";
import { cn } from "@/lib/utils";
import { AddProjectDialog, NewIssueDialog } from "@/NewDialogs";
import { allIssues, allProjects, openDrafts, useStore, workNow, type Store } from "@/store";

/*
A project is a repository, private (yours) or open source (someone else's). Each project has one page where you, in
charge, see all its issues from open to done at once, as a board (picked in round 2): Open holds the issues nobody
works on yet (Assign starts one), then In progress, In review, Approval, Sent (open source only) and Done. What
waits on you in this project is at the top. New issue (private) or Find issues (open source) adds to Open.
*/

// One card on the board: an open issue or a work item.
type Card = { id: string; title: string; ref: string; column: string; line: string; minutes: number; link: string; waits: string; issue: OpenIssue | null };

const COLUMNS: Record<Project["group"], string[]> = {
  Private: ["Open", "In progress", "In review", "Approval", "Done"],
  "Open source": ["Open", "In progress", "In review", "Approval", "Sent", "Done"],
};
const STAGE_COLUMN: Record<string, string> = {
  working: "In progress",
  review: "In review",
  approval: "Approval",
  sent: "Sent",
  merged: "Done",
  cancelled: "Done",
};

function projectCards(project: Project, store: Store): Card[] {
  const cards: Card[] = allIssues(store)
    .filter((issue) => issue.short === project.id)
    .map((issue) => {
      const assigned = store.assigned[issue.id];
      return {
        id: issue.id,
        title: issue.title,
        ref: issue.ref,
        column: assigned ? "In progress" : "Open",
        line: assigned ? `${assigned.agent} · starting on ${assigned.vm}` : `${issue.level} · nobody on it`,
        minutes: issue.minutes,
        link: `#/p/${project.id}/${issue.id}`,
        waits: "",
        issue: assigned ? null : issue,
      };
    });
  for (const base of WORK.filter((each) => each.short === project.id)) {
    const work = workNow(base, store);
    cards.push({
      id: work.id,
      title: work.title,
      ref: work.ref,
      column: STAGE_COLUMN[work.stage],
      line: `${work.agent} · ${work.step}`,
      minutes: work.minutes,
      link: href("work", work.id),
      waits: work.draft ? DRAFT_BY_ID[work.draft].group : "",
      issue: null,
    });
  }
  return cards;
}

export function ProjectList() {
  const { store } = useStore();
  const [adding, setAdding] = useState(false);
  const groups: Project["group"][] = ["Private", "Open source"];
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
      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
      {groups.map((group) => (
        <div key={group}>
          <div className="px-4 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group}</div>
          {allProjects(store)
            .filter((project) => project.group === group)
            .map((project) => {
              const cards = projectCards(project, store);
              const waiting = cards.filter((card) => card.waits !== "").length;
              return (
                <a key={project.id} href={href("project", project.id)} className="flex items-center gap-3 border-b px-4 py-2 hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate font-medium">{project.full}</span>
                  {waiting > 0 && <Badge>{waiting} waiting for you</Badge>}
                  <span className="w-16 text-right text-xs text-muted-foreground">{cards.filter((card) => card.column !== "Done").length} open</span>
                </a>
              );
            })}
        </div>
      ))}
    </div>
  );
}

export function ProjectPage(props: { id: string }) {
  const { store } = useStore();
  const [tab, setTab] = useState("issues");
  const [assigning, setAssigning] = useState<OpenIssue | null>(null);
  const [newIssue, setNewIssue] = useState(false);
  const project = allProjects(store).find((each) => each.id === props.id);
  if (!project) {
    return <PageHeader title="Not found" back />;
  }
  const cards = projectCards(project, store);
  const waiting = [...openDrafts(store, "question"), ...openDrafts(store, "approval")].filter((draft) => WORK_BY_ID[draft.work].short === project.id);
  const agents = Object.keys(AGENTS).filter((id) => cards.some((card) => card.id === AGENTS[id].work || AGENTS[id].recent.includes(card.id)));
  const tabs = [
    ["issues", "Issues"],
    ["agents", "Agents"],
  ];
  if (project.group === "Private") {
    tabs.push(["releases", "Releases"]);
  }
  tabs.push(["settings", "Settings"]);

  let action = (
    <Button size="sm" variant="outline" onClick={() => toast("Agents are looking for good free issues here. New ones show up in Open.")}>
      Find issues
    </Button>
  );
  if (project.group === "Private") {
    action = (
      <Button size="sm" variant="outline" onClick={() => setNewIssue(true)}>
        New issue
      </Button>
    );
  }

  return (
    <div>
      <PageHeader
        title={project.full}
        meta={
          <span className="flex items-center gap-1.5">
            <Badge variant="secondary">{project.group}</Badge>
            {cards.filter((card) => card.column !== "Done").length} open
          </span>
        }
        right={action}
      />
      {waiting.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
          <span className="text-muted-foreground">Waiting for you:</span>
          {waiting.map((draft) => (
            <Go key={draft.id} kind="draft" id={draft.id}>
              {draft.ask}
            </Go>
          ))}
        </div>
      )}
      <div className="flex gap-1 border-b px-3">
        {tabs.map((each) => (
          <button
            key={each[0]}
            type="button"
            onClick={() => setTab(each[0])}
            className={cn(
              "relative px-2 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground",
              tab === each[0] && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
            )}
          >
            {each[1]}
          </button>
        ))}
      </div>

      {tab === "issues" && (
        <div className="flex items-start gap-3 overflow-x-auto p-4">
          {COLUMNS[project.group].map((column) => {
            const inColumn = cards.filter((card) => card.column === column).sort((a, b) => a.minutes - b.minutes);
            return (
              <div key={column} className="flex w-60 shrink-0 flex-col gap-2 rounded-lg bg-muted p-2">
                <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                  <span>{column}</span>
                  <span className="tabular-nums">{inColumn.length}</span>
                </div>
                {inColumn.length === 0 && <div className="px-1 pb-1 text-xs text-muted-foreground">None</div>}
                {inColumn.map((card) => (
                  <div key={card.id} className="flex flex-col gap-1 rounded-md border bg-card p-2.5 hover:border-input">
                    <a href={card.link} className="line-clamp-2 font-medium hover:underline">
                      {card.title}
                    </a>
                    <span className="text-xs text-muted-foreground">{card.ref}</span>
                    <span className="text-xs text-muted-foreground">{card.line}</span>
                    {card.waits === "question" && (
                      <Badge variant="warn" className="mt-0.5">
                        Question for you
                      </Badge>
                    )}
                    {card.waits === "approval" && <Badge className="mt-0.5">Approval for you</Badge>}
                    {card.issue && (
                      <Button size="xs" variant="outline" className="mt-1 self-start" onClick={() => setAssigning(card.issue)}>
                        Assign
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {tab === "agents" && (
        <div>
          {agents.length === 0 && <div className="px-4 py-8 text-center text-muted-foreground">No agent has worked here yet. Assign an issue to start one.</div>}
          {agents.map((id) => (
            <a key={id} href={href("agent", id)} className="flex items-center gap-3 border-b px-4 py-2 hover:bg-accent">
              <span className="w-36 truncate font-medium">{id}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{AGENTS[id].note}</span>
              <span className="text-xs text-muted-foreground">{AGENTS[id].status}</span>
            </a>
          ))}
        </div>
      )}
      {tab === "releases" && (
        <div className="flex max-w-3xl flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
            <div>
              <div className="font-medium">Next: v0.3.0</div>
              <p className="text-muted-foreground">2 merged since v0.2.0. Rolls back by itself if errors show up in the first 10 minutes.</p>
            </div>
            <Button size="sm" onClick={() => toast("Release v0.3.0: the real app asks “Are you sure?” first, then installs and watches it.")}>
              Release
            </Button>
          </div>
          <div className="rounded-lg border bg-card px-3 py-2 text-muted-foreground">v0.2.0 · Nov 1 · running</div>
        </div>
      )}
      {tab === "settings" && (
        <dl className="grid max-w-xl grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-3 p-4">
          {project.group === "Private" && (
            <>
              <dt className="text-muted-foreground">Who merges</dt>
              <dd>
                <select className="h-7 rounded-md border bg-background px-1.5">
                  <option>You</option>
                  <option>The review agent</option>
                </select>
              </dd>
              <dt className="text-muted-foreground">Workers</dt>
              <dd>
                <select defaultValue="2" className="h-7 rounded-md border bg-background px-1.5">
                  <option>1</option>
                  <option>2</option>
                  <option>3</option>
                </select>
              </dd>
            </>
          )}
          {project.group === "Open source" && (
            <>
              <dt className="text-muted-foreground">Follow-ups</dt>
              <dd>The agent drafts every reply; you approve each one</dd>
            </>
          )}
          <dt className="text-muted-foreground">Machine</dt>
          <dd>
            <Go kind="vm" id={project.group === "Private" ? "seraph-workflow" : "vm1"}>
              {project.group === "Private" ? "seraph-workflow" : "vm1"}
            </Go>
          </dd>
          <dt className="text-muted-foreground">Project</dt>
          <dd>
            <Button size="sm" variant="outline" onClick={() => toast("Remove project: asks first. Its history is kept.")}>
              Remove project
            </Button>
          </dd>
        </dl>
      )}

      {assigning && <AssignDialog issue={assigning} onClose={() => setAssigning(null)} />}
      {newIssue && <NewIssueDialog project={project.id} onClose={() => setNewIssue(false)} />}
    </div>
  );
}

export function OpenIssuePage(props: { id: string }) {
  const { store } = useStore();
  const [assigning, setAssigning] = useState(false);
  const issue = allIssues(store).find((each) => each.id === props.id);
  if (!issue) {
    return <PageHeader title="Not found" back />;
  }
  const assigned = store.assigned[issue.id];
  return (
    <div>
      <PageHeader back title={issue.title} meta={`${issue.ref} · opened ${issue.opened === "now" ? "just now" : `${issue.opened} ago`}`} right={<Badge variant="secondary">{assigned ? "In progress" : "Open"}</Badge>} />
      <div className="flex max-w-2xl flex-col gap-4 p-4">
        <p className="text-sm">{issue.plain}</p>
        <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">How hard</dt>
          <dd>{issue.level}</dd>
          <dt className="text-muted-foreground">Who's on it</dt>
          <dd>
            {assigned ? (
              <span>
                <Go kind="agent" id={assigned.agent}>
                  {assigned.agent}
                </Go>{" "}
                on{" "}
                <Go kind="vm" id={assigned.vm}>
                  {assigned.vm}
                </Go>
                , starting
              </span>
            ) : (
              "Nobody yet"
            )}
          </dd>
          <dt className="text-muted-foreground">On GitHub</dt>
          <dd className="text-muted-foreground">{issue.opened === "now" ? "Not posted yet" : `Issue ${issue.ref.split(" ")[1]} ↗`}</dd>
        </dl>
        {!assigned && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setAssigning(true)}>
              Assign
            </Button>
            <Button size="sm" variant="outline" onClick={() => toast("Remove: it leaves Open. Nothing is said on GitHub.")}>
              Remove
            </Button>
          </div>
        )}
      </div>
      {assigning && <AssignDialog issue={issue} onClose={() => setAssigning(false)} />}
    </div>
  );
}
