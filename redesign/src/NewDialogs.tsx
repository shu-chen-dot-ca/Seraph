import { useState } from "react";

import AssignDialog from "@/AssignDialog";
import { Button } from "@/components/ui/button";
import Dialog from "@/Dialog";
import { AGENTS, FOUND_PROJECTS, type OpenIssue } from "@/data";
import { href, toast } from "@/links";
import { cn } from "@/lib/utils";
import { allIssues, allProjects, useStore } from "@/store";

/*
The pop-ups behind New in the header and Add or find projects in the left list: one place to start anything.
- Fix an issue: pick an open issue from any project, then Assign it.
- New issue: say what should change in plain words; it lands in the project's Open column and an agent writes it up.
- Ask an agent: write to any agent; you land in its chat.
- Add or find projects: add a repository by its link, or let agents find good open-source ones.
*/

export function FixIssueDialog(props: { onClose: () => void }) {
  const { store } = useStore();
  const [chosen, setChosen] = useState<OpenIssue | null>(null);
  if (chosen) {
    return <AssignDialog issue={chosen} onClose={props.onClose} />;
  }
  const issues = allIssues(store).filter((issue) => !store.assigned[issue.id]);
  return (
    <Dialog title="Fix an issue" onClose={props.onClose}>
      <p className="text-muted-foreground">Open issues nobody works on yet, from every project. Pick one to assign it.</p>
      <div className="flex flex-col gap-1">
        {issues.map((issue) => (
          <button key={issue.id} type="button" onClick={() => setChosen(issue)} className="flex flex-col rounded-md border px-3 py-2 text-left hover:border-primary">
            <span className="font-medium">{issue.title}</span>
            <span className="text-xs text-muted-foreground">
              {issue.ref} · {issue.level}
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export function NewIssueDialog(props: { onClose: () => void; project?: string }) {
  const { store, update } = useStore();
  const projects = allProjects(store);
  const [project, setProject] = useState(props.project ?? projects[0].id);
  const [text, setText] = useState("");

  function create() {
    const id = `i-new-${store.issues.length + 1}`;
    const title = text.trim().split("\n")[0].slice(0, 80);
    const issue = { id, short: project, ref: `${project} · new`, title, plain: text.trim(), level: "Not sized yet", opened: "now", minutes: 0 };
    update((before) => ({ ...before, issues: [...before.issues, issue] }));
    const where = projects.find((each) => each.id === project);
    if (where?.group === "Open source") {
      toast("It's in Open. An agent writes it up; posting it on GitHub waits for your approval.");
    } else {
      toast("It's in Open. An agent writes it up as a proper issue.");
    }
    window.location.hash = href("project", project);
    props.onClose();
  }

  return (
    <Dialog title="New issue" confirm="Create" disabled={text.trim() === ""} onConfirm={create} onClose={props.onClose}>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Project</span>
        <select value={project} onChange={(event) => setProject(event.target.value)} className="h-8 rounded-md border bg-background px-2">
          {projects.map((each) => (
            <option key={each.id} value={each.id}>
              {each.full}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">What should change? Plain words are fine.</span>
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="e.g. The phone menu should close after I pick a page"
          className="min-h-24 resize-y rounded-md border bg-background px-2.5 py-2 outline-none focus-visible:border-ring"
        />
      </label>
    </Dialog>
  );
}

export function AskAgentDialog(props: { onClose: () => void }) {
  const { update } = useStore();
  const [agent, setAgent] = useState(Object.keys(AGENTS)[0]);
  const [text, setText] = useState("");

  function send() {
    update((store) => ({ ...store, messages: { ...store.messages, [agent]: [...(store.messages[agent] ?? []), text.trim()] } }));
    window.location.hash = href("agent", agent);
    props.onClose();
  }

  return (
    <Dialog title="Ask an agent" confirm="Send" disabled={text.trim() === ""} onConfirm={send} onClose={props.onClose}>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Agent</span>
        <select value={agent} onChange={(event) => setAgent(event.target.value)} className="h-8 rounded-md border bg-background px-2">
          {Object.keys(AGENTS).map((id) => (
            <option key={id} value={id}>
              {id} · {AGENTS[id].status}
            </option>
          ))}
        </select>
      </label>
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Your message"
        className="min-h-24 resize-y rounded-md border bg-background px-2.5 py-2 outline-none focus-visible:border-ring"
      />
    </Dialog>
  );
}

export function AddProjectDialog(props: { onClose: () => void }) {
  const { store, update } = useStore();
  const [tab, setTab] = useState<"link" | "find">("link");
  const [link, setLink] = useState("");
  const [group, setGroup] = useState<"Open source" | "Private">("Open source");
  const [found, setFound] = useState(false);
  const match = link.trim().match(/github\.com\/([^/\s]+\/[^/\s]+)/);

  function add(full: string, kind: "Open source" | "Private") {
    const id = full.split("/")[1];
    if (!allProjects(store).some((each) => each.id === id)) {
      update((before) => ({ ...before, projects: [...before.projects, { id, full, group: kind }] }));
    }
    toast(`${full} is a project now. Find issues on its page to fill its Open column.`);
    window.location.hash = href("project", id);
    props.onClose();
  }

  const tabClass = (on: boolean) =>
    cn(
      "relative px-2 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground",
      on && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
    );

  return (
    <Dialog
      title="Add or find projects"
      confirm={tab === "link" ? "Add" : undefined}
      disabled={!match}
      onConfirm={() => match && add(match[1], group)}
      onClose={props.onClose}
    >
      <div className="flex gap-1 border-b">
        <button type="button" className={tabClass(tab === "link")} onClick={() => setTab("link")}>
          Add by link
        </button>
        <button type="button" className={tabClass(tab === "find")} onClick={() => setTab("find")}>
          Find open-source projects
        </button>
      </div>
      {tab === "link" && (
        <>
          <input
            autoFocus
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://github.com/owner/name"
            className="h-8 rounded-md border bg-background px-2.5 outline-none focus-visible:border-ring"
          />
          <div className="flex gap-4">
            {(["Open source", "Private"] as const).map((kind) => (
              <label key={kind} className="flex items-center gap-1.5">
                <input type="radio" name="group" checked={group === kind} onChange={() => setGroup(kind)} className="accent-[var(--primary)]" />
                {kind === "Private" ? "Private (yours)" : "Open source (someone else's)"}
              </label>
            ))}
          </div>
        </>
      )}
      {tab === "find" && !found && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground">Agents look for projects that merge outside pull requests, answer newcomers, and allow AI-written fixes.</p>
          <Button size="sm" onClick={() => setFound(true)}>
            Find
          </Button>
        </div>
      )}
      {tab === "find" && found && (
        <div className="flex flex-col gap-1.5">
          {FOUND_PROJECTS.map((project) => (
            <div key={project.full} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
              <span className="flex flex-col">
                <span className="font-medium">{project.full}</span>
                <span className="text-xs text-muted-foreground">{project.line}</span>
              </span>
              <Button size="xs" variant="outline" onClick={() => add(project.full, "Open source")}>
                Add
              </Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
