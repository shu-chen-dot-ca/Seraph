/*
A repository's Releases tab on the Workspace tab (Repository.tsx with live): plan the next release, make it, and follow
it going live (github_searcher/projects.py: release_info, plan, release; backend/projects_api.py). Read from GitHub as
you when the tab opens, after every change, and on Refresh.
- Next release: the version it will be (from the merged pull requests' titles: a feat moves the middle number up, else
  the last one), the pull requests merged since the last release, grouped as in its notes (Features, Fixes, Other
  changes), and Release, which asks first (Enter confirms): the GitHub release, with those notes, made as you. On the
  app's own repo the live copy (./live.sh) then gets it ready, checks it on a copy of your data and offers it as Update
  in the header; once installed it is taken back by itself when it goes wrong in its first ten minutes (deploy/switch.sh).
- Planned: the issues in the next release (GitHub's milestone "Next release"): workers take them before the others.
  Remove takes one out; Add issue puts an open issue in.
- Installed, on the app's own repo: the version that runs, one being made ready or failing its check, and the last one
  taken back, with why (the live store's "updates"; the dev copy only says it installs nothing).
- Releases: the ones before, the newest first, each with its notes and a link to it on GitHub.
*/

import { ChevronDown, ExternalLink, Loader2, Plus, RefreshCw, Rocket, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/ui/markdown";
import { StatusDot } from "@/components/ui/status-dot";
import { api, useLive } from "@/live";
import { timeAgo } from "@/lib/utils";

// What GET /api/projects/<repo>/release gives (projects.py release_info).
type ReleaseInfo = {
  releases: { tag: string; name: string; url: string; at: string; notes: string }[];
  default_branch: string;
  prs: { number: number; title: string; url: string; at: string; kind: "feat" | "fix" | "other" }[];
  next: string | null;
  notes: string;
  milestone: number | null;
  planned: { number: number; title: string; url: string; state: "open" | "closed" }[];
};

const SECTIONS: [string, string][] = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["other", "Other changes"],
];

export default function Releases(props: { repo: string }) {
  const projects = useLive("projects");
  const updates = useLive("updates");
  const project = projects.find((each) => each.repo.toLowerCase() === props.repo.toLowerCase());
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  // The request on its way: "release", "add:<n>" or "remove:<n>".
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState(false);
  // The repo's open issues, for Add issue; null until its menu first opens.
  const [openIssues, setOpenIssues] = useState<{ number: number; title: string }[] | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    api<ReleaseInfo>(`/api/projects/${props.repo}/release`)
      .then((result) => {
        if (current) {
          setInfo(result);
          setError("");
        }
      })
      .catch((err) => {
        if (current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [props.repo, reload]);

  async function loadIssues() {
    try {
      const result = await api<{ items: { number: number; title: string }[] }>(`/api/your_repositories/${props.repo}/issues?state=open&fresh=1`);
      setOpenIssues(result.items);
    } catch (err) {
      toast.error(`Could not read the issues: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function plan(number: number, add: boolean) {
    setBusy(`${add ? "add" : "remove"}:${number}`);
    try {
      await api(`/api/projects/${props.repo}/plan`, { method: "POST", body: { number, add } });
      setReload((count) => count + 1);
    } catch (err) {
      toast.error(`Could not change the plan: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function release() {
    setBusy("release");
    try {
      const result = await api<{ tag: string; url: string }>(`/api/projects/${props.repo}/release`, { method: "POST" });
      toast.success(`Released ${result.tag}`, { action: { label: "Open", onClick: () => window.open(result.url, "_blank", "noopener,noreferrer") } });
      setReload((count) => count + 1);
    } catch (err) {
      toast.error(`Could not release: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  const heading = "flex items-center gap-2 px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground";
  const row = "flex min-w-0 items-center gap-2 px-3 py-2";
  const plannedNumbers = info === null ? [] : info.planned.map((issue) => issue.number);

  return (
    <div className="max-w-5xl pb-6">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="font-semibold">Next release</span>
        {info !== null && info.next !== null && <span className="font-mono">{info.next}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setReload((count) => count + 1)}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
          <Button size="sm" disabled={info === null || info.next === null || busy !== ""} onClick={() => setConfirming(true)}>
            {busy === "release" ? <Loader2 className="animate-spin" /> : <Rocket />} Release {info?.next ?? ""}
          </Button>
        </div>
      </div>
      {error !== "" && <div className="border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read it from GitHub: {error}</div>}
      {info === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}

      {info !== null && (
        <>
          <div className={heading}>
            Merged since {info.releases.length > 0 ? info.releases[0].tag : "the start"} <span className="tabular-nums">{info.prs.length}</span>
          </div>
          <div className="border-y">
            {info.prs.length === 0 && <div className="px-3 py-2 text-muted-foreground">Nothing was merged since the last release.</div>}
            {SECTIONS.map(([kind, label]) => {
              const prs = info.prs.filter((pr) => pr.kind === kind);
              if (prs.length === 0) {
                return null;
              }
              return (
                <div key={kind}>
                  <div className="px-3 pt-2 text-xs text-muted-foreground">{label}</div>
                  {prs.map((pr) => (
                    <div key={pr.number} className={row}>
                      <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                        {pr.title} <span className="text-muted-foreground">#{pr.number}</span>
                      </a>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(pr.at)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          <div className={heading}>
            Planned <span className="tabular-nums">{info.planned.length}</span>
            <DropdownMenu onOpenChange={(open) => open && openIssues === null && loadIssues()}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="ml-auto h-7">
                  <Plus /> Add issue <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
                {openIssues === null && <DropdownMenuLabel className="text-muted-foreground">Loading…</DropdownMenuLabel>}
                {openIssues !== null && openIssues.filter((issue) => !plannedNumbers.includes(issue.number)).length === 0 && (
                  <DropdownMenuLabel className="text-muted-foreground">No other open issues.</DropdownMenuLabel>
                )}
                {openIssues !== null &&
                  openIssues
                    .filter((issue) => !plannedNumbers.includes(issue.number))
                    .map((issue) => (
                      <DropdownMenuItem key={issue.number} onSelect={() => plan(issue.number, true)}>
                        <span className="min-w-0 truncate">{issue.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">#{issue.number}</span>
                      </DropdownMenuItem>
                    ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="divide-y border-y">
            {info.planned.length === 0 && <div className="px-3 py-2 text-muted-foreground">No issues planned. Workers take the oldest open issue first.</div>}
            {info.planned.map((issue) => (
              <div key={issue.number} className={row}>
                <StatusDot tone={issue.state === "open" ? "green" : "gray"} />
                <a href={issue.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                  {issue.title} <span className="text-muted-foreground">#{issue.number}</span>
                </a>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{issue.state === "open" ? "Open" : "Closed"}</span>
                <Button size="sm" variant="ghost" className="h-7 shrink-0" disabled={busy !== ""} title="Take it out of the next release" onClick={() => plan(issue.number, false)}>
                  {busy === `remove:${issue.number}` ? <Loader2 className="animate-spin" /> : <X />} Remove
                </Button>
              </div>
            ))}
          </div>
        </>
      )}

      {project !== undefined && project.app && (
        <>
          <div className={heading}>Installed</div>
          <div className="space-y-1 border-y px-3 py-2">
            {!updates.live && <div className="text-muted-foreground">This is your working code (./run.sh): releases install on the live copy (./live.sh).</div>}
            {updates.live && (
              <>
                <div>
                  Running <span className="font-mono">{updates.running}</span>
                  {updates.switched_at !== null && <span className="text-muted-foreground">, since {timeAgo(updates.switched_at)}</span>}
                </div>
                {updates.preparing !== null && <div className="text-muted-foreground">Getting {updates.preparing} ready and checking it on a copy of your data…</div>}
                {updates.ready !== null && !updates.restarting && <div>{updates.ready} is ready: Update in the header installs it.</div>}
                {updates.restarting && <div className="text-muted-foreground">Installing {updates.ready ?? ""}: the app restarts in a moment.</div>}
                {updates.error !== "" && <div className="text-destructive">{updates.error}</div>}
                {updates.failed !== null && (
                  <div className="text-warn">
                    {updates.failed} was taken back{updates.failed_reason !== "" ? `: ${updates.failed_reason}` : "."}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {info !== null && info.releases.length > 0 && (
        <>
          <div className={heading}>Releases</div>
          <div className="divide-y border-y">
            {info.releases.map((each) => (
              <details key={each.tag} className="px-3 py-2">
                <summary className="flex cursor-pointer items-center gap-2">
                  <span className="font-mono">{each.tag}</span>
                  {each.name !== each.tag && <span className="min-w-0 truncate">{each.name}</span>}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(each.at)}</span>
                  <a href={each.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" title="Open it on GitHub">
                    <ExternalLink className="size-3.5" />
                  </a>
                </summary>
                {each.notes !== "" ? <Markdown text={each.notes} repo={props.repo} className="mt-2" /> : <p className="mt-2 text-muted-foreground">No notes.</p>}
              </details>
            ))}
          </div>
        </>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Release {info?.next}?</AlertDialogTitle>
            <AlertDialogDescription>
              The GitHub release {info?.next} is made on {info?.default_branch}, as you, with the {info?.prs.length} pull requests merged since the last one in its
              notes.
              {project?.app && " The live copy then checks it on a copy of your data and offers it as Update; once installed, it is taken back by itself if it goes wrong."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={release}>Release {info?.next}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
