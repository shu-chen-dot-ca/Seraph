import { useState } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive } from "@/live";
import { href } from "@/routes";

/*
New issue in one of your private projects (a Workflow repo): say what should change in plain words. The first line is
its title, the rest its goal; its worker writes the requirements and how to check them before it starts
(POST /api/workflow/<repo>/issues). It shows in the project's Open column right away.
*/

export default function NewIssueDialog(props: { repo?: string; onClose: () => void }) {
  const workflow = useLive("workflow");
  const [repo, setRepo] = useState(props.repo ?? workflow[0]?.repo ?? "");
  const [text, setText] = useState("");

  async function create() {
    const lines = text.trim().split("\n");
    const title = lines[0].slice(0, 120);
    const goal = lines.slice(1).join("\n").trim() || title;
    await api(`/api/workflow/${repo}/issues`, { method: "POST", body: { title: title, goal: goal, requirements: [], validation: "" } });
    toast.success("Added to Open. A worker writes it up and takes it.");
    window.location.hash = href.project(repo);
  }

  if (workflow.length === 0) {
    return (
      <ConfirmDialog
        title="New issue"
        confirm="Add a project"
        onClose={props.onClose}
        onConfirm={() => {
          window.location.hash = href.projects();
        }}
      >
        <p>New issues go to your own projects, and you have none yet. Add one with Add or find projects.</p>
      </ConfirmDialog>
    );
  }

  return (
    <ConfirmDialog title="New issue" confirm="Create" disabled={text.trim() === "" || repo === ""} onClose={props.onClose} onConfirm={create}>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Project</span>
        <select value={repo} onChange={(event) => setRepo(event.target.value)} className="h-8 rounded-md border bg-background px-2">
          {workflow.map((each) => (
            <option key={each.repo} value={each.repo}>
              {each.repo}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">What should change? Plain words are fine. The first line is the title.</span>
        <Textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="The phone menu should close after I pick a page" className="min-h-24" />
      </label>
    </ConfirmDialog>
  );
}
