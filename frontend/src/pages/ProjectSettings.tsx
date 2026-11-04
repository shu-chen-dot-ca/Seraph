import { useState } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/live";
import type { Project } from "@/model/projects";
import { href } from "@/routes";

/*
A project's Settings tab.
- Private (a Workflow repo): whether workers take new issues, how many workers, where pull requests live (in Seraph,
  or on GitHub), and who merges (you, or the review agent). Remove project archives its agents (its VM stays).
- Open source: whether it is watched for new issues (the Tracked list). Remove project takes it and its open issues
  out of the lists (nothing is said on GitHub).
*/

function WorkflowSettings(props: { project: Project }) {
  const workflow = props.project.workflow!;
  const [on, setOn] = useState(workflow.on);
  const [agents, setAgents] = useState(workflow.agents);
  const [prsOn, setPrsOn] = useState(workflow.prs_on);
  const [decides, setDecides] = useState(workflow.decides);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const changed = on !== workflow.on || agents !== workflow.agents || prsOn !== workflow.prs_on || decides !== workflow.decides;

  async function save() {
    setSaving(true);
    try {
      await api(`/api/workflow/${workflow.repo}`, { method: "PUT", body: { on: on, agents: agents, prs_on: prsOn, decides: decides } });
      toast.success("Saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }

  return (
    <div className="flex max-w-xl flex-col gap-4 p-4">
      <dl className="grid grid-cols-[160px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <dt className="text-muted-foreground">Take new issues</dt>
        <dd>
          <Switch checked={on} onCheckedChange={setOn} aria-label="Take new issues" />
        </dd>
        <dt className="text-muted-foreground">Workers</dt>
        <dd>
          <select value={agents} onChange={(event) => setAgents(Number(event.target.value))} className="h-7 rounded-md border bg-background px-1.5">
            {[1, 2, 3].map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </dd>
        <dt className="text-muted-foreground">Pull requests</dt>
        <dd>
          <select value={prsOn} onChange={(event) => setPrsOn(event.target.value as "seraph" | "github")} className="h-7 rounded-md border bg-background px-1.5">
            <option value="seraph">In Seraph</option>
            <option value="github">On GitHub</option>
          </select>
        </dd>
        <dt className="text-muted-foreground">Who merges</dt>
        <dd>
          <select value={decides} onChange={(event) => setDecides(event.target.value as "you" | "agent")} className="h-7 rounded-md border bg-background px-1.5">
            <option value="you">You</option>
            <option value="agent">The review agent</option>
          </select>
        </dd>
        <dt className="text-muted-foreground">Machine</dt>
        <dd>
          {workflow.vm !== null ? (
            <a href={href.machine(workflow.vm)} className="text-primary hover:underline">
              {workflow.vm}
            </a>
          ) : (
            "None yet"
          )}
        </dd>
      </dl>
      <div className="flex gap-2">
        <Button size="sm" disabled={!changed || saving} onClick={save}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRemoving(true)}>
          Remove project
        </Button>
      </div>
      {removing && (
        <ConfirmDialog
          title={`Remove ${workflow.repo}?`}
          confirm="Remove"
          danger
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api(`/api/workflow/${workflow.repo}`, { method: "DELETE" });
            window.location.hash = href.projects();
          }}
        >
          <p>Its agents are archived and stop taking issues. Its VM stays. Nothing changes on GitHub.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function OpenSourceSettings(props: { project: Project }) {
  const project = props.project;
  const [removing, setRemoving] = useState(false);

  async function watch(on: boolean) {
    try {
      if (on) {
        await api("/api/tracked", { method: "POST", body: { name: project.repo } });
      } else {
        await api("/api/tracked/remove", { method: "POST", body: { names: [project.tracked!.full_name] } });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4 p-4">
      <dl className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <dt className="text-muted-foreground">Watch for new issues</dt>
        <dd>
          <Switch checked={project.tracked !== null} onCheckedChange={watch} aria-label="Watch for new issues" />
        </dd>
        <dt className="text-muted-foreground">Follow-ups</dt>
        <dd className="text-muted-foreground">After a pull request is sent, its agent drafts every reply and new version; you approve each.</dd>
      </dl>
      {(project.listed !== null || project.tracked !== null) && (
        <div>
          <Button size="sm" variant="outline" onClick={() => setRemoving(true)}>
            Remove project
          </Button>
        </div>
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${project.repo}?`}
          confirm="Remove"
          danger
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api("/api/repos/remove", { method: "POST", body: { names: [project.listed?.full_name ?? project.repo], issues: true } });
            window.location.hash = href.projects();
          }}
        >
          <p>It and its open issues leave the lists, and it isn't watched anymore. Work already done stays. Nothing is said on GitHub.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function ProjectSettings(props: { project: Project }) {
  if (props.project.workflow !== null) {
    return <WorkflowSettings project={props.project} />;
  }
  if (props.project.kind === "private") {
    return <p className="p-4 text-muted-foreground">This project's settings aren't on this page yet.</p>;
  }
  return <OpenSourceSettings project={props.project} />;
}
