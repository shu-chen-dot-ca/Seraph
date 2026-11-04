/*
Projects: every repository you work on, private (your own, which agents develop through a Workflow repo or a
project) or open source (someone else's, where agents fix issues and you send the pull requests). The backend keeps
several lists of repos; a project is any repo in one of them:

- private: the Workflow repos and the projects;
- open source: the Repos list, the Tracked list (watched for new issues), and any repo that has work on it (an issue
  in the Issues list, a job, a pull request), minus the private ones.

Each project's board shows its work items by stage (model/work.ts). Names are matched in lower case; the spelling
shown is the first one found.
*/

import { useMemo } from "react";

import { useLive, type ListedRepo, type Project as DevProject, type TrackedRepo, type WorkflowRepo } from "@/live";
import { DONE_STAGES, type Stage, type WorkItem } from "@/model/work";

export type ProjectKind = "private" | "open source";

export type Project = {
  repo: string; // "owner/name", as shown
  key: string; // lower case
  kind: ProjectKind;
  workflow: WorkflowRepo | null;
  dev: DevProject | null; // a project from the Development tab
  listed: ListedRepo | null; // in the Repos list
  tracked: TrackedRepo | null; // watched for new issues
};

// The board's columns, left to right. Open source has Sent: the pull request is on someone else's project.
export const COLUMNS: Record<ProjectKind, { title: string; stages: Stage[] }[]> = {
  private: [
    { title: "Open", stages: ["open"] },
    { title: "In progress", stages: ["working"] },
    { title: "In review", stages: ["review"] },
    { title: "Approval", stages: ["approval"] },
    { title: "Done", stages: DONE_STAGES },
  ],
  "open source": [
    { title: "Open", stages: ["open"] },
    { title: "In progress", stages: ["working"] },
    { title: "In review", stages: ["review"] },
    { title: "Approval", stages: ["approval"] },
    { title: "Sent", stages: ["sent"] },
    { title: "Done", stages: DONE_STAGES },
  ],
};

type Inputs = {
  workflow: WorkflowRepo[];
  dev: DevProject[];
  listed: ListedRepo[];
  tracked: TrackedRepo[];
  items: Map<string, WorkItem>;
};

export function buildProjects(inputs: Inputs): Project[] {
  const projects = new Map<string, Project>();

  function ensure(repo: string, kind: ProjectKind): Project {
    const key = repo.toLowerCase();
    let project = projects.get(key);
    if (project === undefined) {
      project = { repo: repo, key: key, kind: kind, workflow: null, dev: null, listed: null, tracked: null };
      projects.set(key, project);
    }
    return project;
  }

  for (const repo of inputs.workflow) {
    ensure(repo.repo, "private").workflow = repo;
  }
  for (const repo of inputs.dev) {
    ensure(repo.repo, "private").dev = repo;
  }
  for (const repo of inputs.listed) {
    ensure(repo.full_name, "open source").listed = repo;
  }
  for (const repo of inputs.tracked) {
    ensure(repo.full_name, "open source").tracked = repo;
  }
  for (const item of inputs.items.values()) {
    ensure(item.repo, "open source");
  }
  return [...projects.values()].sort((a, b) => a.repo.localeCompare(b.repo, undefined, { sensitivity: "base" }));
}

export function useProjects(items: Map<string, WorkItem>): Project[] {
  const workflow = useLive("workflow");
  const dev = useLive("projects");
  const listed = useLive("repos");
  const tracked = useLive("tracked");
  return useMemo(
    () => buildProjects({ workflow: workflow, dev: dev, listed: listed.items, tracked: tracked.items, items: items }),
    [workflow, dev, listed, tracked, items],
  );
}

// A project's work items, newest change first.
export function projectItems(project: Project, items: Map<string, WorkItem>): WorkItem[] {
  return [...items.values()].filter((item) => item.repo.toLowerCase() === project.key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
