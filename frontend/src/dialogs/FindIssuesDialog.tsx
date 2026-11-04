import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, useLive } from "@/live";
import type { Project } from "@/model/projects";

/*
Find issues for an open-source project: its free issues on GitHub (from the last check of the Tracked list, which
reads every watched project's open issues), so you can put good ones in the project's Open column (Add to Open), where
Assign gives one to an agent. A project that isn't watched yet can be (Watch this project); Check now reads its issues
again. Issues already in Open aren't offered again.
*/

export default function FindIssuesDialog(props: { project: Project; onClose: () => void }) {
  const tracked = useLive("tracked").items.find((repo) => repo.full_name.toLowerCase() === props.project.key);
  const inOpen = useLive("issues").items.filter((issue) => issue.repo.toLowerCase() === props.project.key);
  const [busy, setBusy] = useState("");

  async function run(key: string, path: string, body: unknown, done: string) {
    setBusy(key);
    try {
      await api(path, { method: "POST", body: body });
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setBusy("");
  }

  const free = (tracked?.check?.issues ?? []).filter(
    (issue) => issue.assignees === 0 && (issue.tags?.status ?? "free") === "free" && !inOpen.some((each) => each.number === issue.number),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Find issues in {props.project.repo}</DialogTitle>
          <DialogDescription>Free issues on GitHub. Add good ones to Open, then assign them.</DialogDescription>
        </DialogHeader>
        {tracked === undefined && (
          <div className="flex flex-col items-start gap-2">
            <p>This project isn't watched yet. Watching it reads its open issues now and again every day.</p>
            <Button size="sm" disabled={busy !== ""} onClick={() => run("watch", "/api/tracked", { name: props.project.repo }, "Watching it. Its issues show here in a moment.")}>
              {busy === "watch" && <Loader2 className="animate-spin" />}
              Watch this project
            </Button>
          </div>
        )}
        {tracked !== undefined && (
          <>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{tracked.check === null ? "Not read yet." : `${free.length} free issues.`}</span>
              <Button size="xs" variant="outline" disabled={busy !== ""} onClick={() => run("check", "/api/tracked/check", { name: tracked.full_name }, "Reading its issues again.")}>
                {busy === "check" && <Loader2 className="animate-spin" />}
                Check now
              </Button>
            </div>
            <div className="flex flex-col gap-1.5">
              {free.map((issue) => (
                <div key={issue.number} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
                  <span className="flex min-w-0 flex-col">
                    <a href={issue.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {issue.title}
                    </a>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      #{issue.number} · {issue.comments} comments
                      {issue.tags?.merge && <Badge variant={issue.tags.merge === "likely" ? "ok" : "secondary"}>{issue.tags.merge}</Badge>}
                    </span>
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== ""}
                    onClick={() => run(`add${issue.number}`, "/api/tracked/add_issue", { repo: tracked.full_name, number: issue.number }, `#${issue.number} is in Open.`)}
                  >
                    {busy === `add${issue.number}` && <Loader2 className="animate-spin" />}
                    Add to Open
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
