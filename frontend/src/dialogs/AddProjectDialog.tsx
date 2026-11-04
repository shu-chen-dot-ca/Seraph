import { useState } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import { Input } from "@/components/ui/input";
import { api } from "@/live";
import { href } from "@/routes";

/*
Add a project by its GitHub link, or go find open-source ones.
- Open source (someone else's): it joins the Repos list (POST /api/repos/add); find its issues on its page.
- Private (yours): agents develop it one issue at a time (POST /api/workflow): this makes it a VM and its agents, so
  it takes a minute. Pull requests stay in Seraph and you decide every merge; both can be changed in its Settings.
Find open-source projects opens the page where agents look for good ones.
*/

export default function AddProjectDialog(props: { onClose: () => void }) {
  const [link, setLink] = useState("");
  const [kind, setKind] = useState<"open source" | "private">("open source");
  const match = link.trim().match(/github\.com\/([^/\s]+\/[^/\s#?]+)/);
  const repo = match !== null ? match[1].replace(/\.git$/, "") : null;

  async function add() {
    if (repo === null) {
      return;
    }
    if (kind === "open source") {
      await api("/api/repos/add", { method: "POST", body: { link: link.trim() } });
      toast.success(`${repo} is a project now. Find issues on its page.`);
    } else {
      await api("/api/workflow", { method: "POST", body: { url: link.trim(), prs_on: "seraph", decides: "you" } });
      toast.success(`${repo} is a project now. Its VM and agents are being set up.`);
    }
    window.location.hash = href.project(repo);
  }

  return (
    <ConfirmDialog title="Add or find projects" confirm="Add" disabled={repo === null} onClose={props.onClose} onConfirm={add}>
      <Input autoFocus value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://github.com/owner/name" />
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" checked={kind === "open source"} onChange={() => setKind("open source")} className="accent-[var(--primary)]" />
          Open source: someone else's project, where agents fix issues and you send the pull requests
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="kind" checked={kind === "private"} onChange={() => setKind("private")} className="accent-[var(--primary)]" />
          Private: yours, agents develop it one issue at a time
        </label>
      </div>
      <p className="text-muted-foreground">
        Or{" "}
        <a href={href.find()} onClick={props.onClose} className="text-primary hover:underline">
          find open-source projects
        </a>
        : agents look for ones that merge outside pull requests and welcome newcomers.
      </p>
    </ConfirmDialog>
  );
}
