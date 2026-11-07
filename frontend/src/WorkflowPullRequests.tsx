/*
A Workflow repository's Pull requests tab (Workflow.tsx): Open (the ones waiting for a decision first, then the ones
the review agent is on) and Closed (merged, rejected, closed on GitHub), the newest first. Each row says in one plain
line what changes (the review agent's summary; the title until it has one), with its number, area, who made it and when,
the review agent's advice (Merge or Don't merge) or decision, and how big it is (lines added and removed, the bar
against the biggest in the list). PullRequestRow is also the Overview's.

One pull request (open=<number>) shows, in order:
- what changes, then its title, who made it, its issue and its GitHub page;
- the decision: Merge and Reject while it waits for you (Reject also while it is in review), or who merged or rejected it
  and why; when the review agent decides, that it carries its advice out;
- the review agent's review: its advice, what you must know, what it checked, and its own pictures;
- what it is for: its issue's goal, requirements and how to check;
- the worker's account (Overview.tsx: problem, cause, fix, what could go wrong, its checklist, what it also tested, the
  before and after pictures); one opened on GitHub by hand shows its description instead;
- Files changed, a bar per file (lines added and removed), then its test runs, then the code itself, folded.
Merge asks first; Reject asks why, and whether to close its issue too.
*/

import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import Overview from "@/Overview";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Draft, type WorkflowPR, type WorkflowPRParts, type WorkflowRepo } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

// Chart colors (validated: blue and orange stay apart for color-blind readers, in both themes). Added lines are blue,
// removed ones orange.
const ADDED = "bg-[#2a78d6] dark:bg-[#3987e5]";
const REMOVED = "bg-[#eb6834] dark:bg-[#d95926]";
// The Files changed chart shows this many files; the rest are summed up under it.
const FILES_SHOWN = 15;
// The code is shown up to this many lines.
const DIFF_LINES = 4000;

export default function WorkflowPullRequests(props: { record: WorkflowRepo; base: string; state: "open" | "closed"; open: string | null }) {
  const record = props.record;
  const agents = useLive("agents");
  const names: Record<string, string> = {};
  for (const agent of agents) {
    names[agent.id] = agent.name;
  }
  const all = Object.values(record.prs);
  const openList = all
    .filter((pr) => pr.state === "review" || pr.state === "waiting")
    .sort((a, b) => (a.state === b.state ? b.created_at.localeCompare(a.created_at) : a.state === "waiting" ? -1 : 1));
  const closedList = all.filter((pr) => pr.state !== "review" && pr.state !== "waiting").sort((a, b) => b.at.localeCompare(a.at));
  const shown = props.state === "closed" ? closedList : openList;
  const max = Math.max(1, ...shown.map((pr) => pr.added + pr.removed));

  if (props.open !== null && record.prs[props.open] !== undefined) {
    return <PullRequestView key={props.open} record={record} pr={record.prs[props.open]} base={props.base} names={names} />;
  }

  return (
    <div className="pb-6">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Tabs value={props.state} onValueChange={(value) => (window.location.hash = value === "closed" ? `${props.base}&tab=pulls&state=closed` : `${props.base}&tab=pulls`)}>
          <TabsList>
            <TabsTrigger value="open" className="px-2.5">
              Open <span className="text-xs text-muted-foreground tabular-nums">{openList.length}</span>
            </TabsTrigger>
            <TabsTrigger value="closed" className="px-2.5">
              Closed <span className="text-xs text-muted-foreground tabular-nums">{closedList.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="divide-y border-b">
        {shown.length === 0 && (
          <div className="px-3 py-3 text-muted-foreground">{props.state === "closed" ? "No closed pull requests yet." : "No open pull requests: workers make them from the issues."}</div>
        )}
        {shown.map((pr) => (
          <PullRequestRow key={pr.number} record={record} pr={pr} base={props.base} names={names} max={max} />
        ))}
      </div>
    </div>
  );
}

export function PullRequestRow(props: { record: WorkflowRepo; pr: WorkflowPR; base: string; names: Record<string, string>; max: number }) {
  const pr = props.pr;
  const summary = pr.review !== null && pr.review.summary !== "" ? pr.review.summary : "";
  const by = pr.by === "you" ? `you${pr.author !== null ? ` (@${pr.author})` : ""}` : (props.names[pr.by] ?? "a worker");
  const width = Math.max(4, Math.round(((pr.added + pr.removed) / props.max) * 48));
  const addedWidth = pr.added + pr.removed === 0 ? 0 : Math.round((pr.added / (pr.added + pr.removed)) * width);
  let icon = <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />;
  if (pr.state === "waiting") {
    icon = <GitPullRequest className="size-4 shrink-0 text-primary" />;
  } else if (pr.state === "merged") {
    icon = <GitMerge className="size-4 shrink-0 text-muted-foreground" />;
  } else if (pr.state === "rejected" || pr.state === "closed") {
    icon = <GitPullRequestClosed className="size-4 shrink-0 text-muted-foreground" />;
  }

  return (
    <a href={`${props.base}&tab=pulls&open=${pr.number}`} className="flex min-w-0 items-center gap-2.5 px-3 py-2 hover:bg-accent/50">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate">{summary || pr.title}</div>
        <div className="truncate text-xs text-muted-foreground">
          #{pr.number}
          {summary !== "" && <span className="font-mono"> · {pr.title}</span>} · {by} · {timeAgo(pr.created_at)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {pr.state === "review" && (
          <Badge variant="outline" className="py-0">
            In review
          </Badge>
        )}
        {pr.state === "waiting" && pr.review !== null && pr.review.advice === "merge" && (
          <Badge variant="ok" className="py-0">
            Merge
          </Badge>
        )}
        {pr.state === "waiting" && pr.review !== null && pr.review.advice === "dont_merge" && (
          <Badge variant="bad" className="py-0">
            Don't merge
          </Badge>
        )}
        {pr.state === "merged" && <span className="text-xs text-muted-foreground">Merged {pr.decision?.by === "agent" ? "by the review agent" : ""}</span>}
        {pr.state === "rejected" && <span className="text-xs text-muted-foreground">Rejected {pr.decision?.by === "agent" ? "by the review agent" : ""}</span>}
        {pr.state === "closed" && <span className="text-xs text-muted-foreground">Closed on GitHub</span>}
        <span className="w-20 text-right font-mono text-xs tabular-nums max-md:hidden">
          <span className="text-ok">+{pr.added}</span> <span className="text-destructive">−{pr.removed}</span>
        </span>
        <span className="flex h-2 w-12 items-center gap-[2px] max-md:hidden" title={`${pr.added} lines added, ${pr.removed} removed`}>
          {addedWidth > 0 && <span className={cn("h-2 rounded-l-[2px]", ADDED)} style={{ width: addedWidth }} />}
          {width - addedWidth > 0 && <span className={cn("h-2 rounded-r-[2px]", REMOVED)} style={{ width: width - addedWidth }} />}
        </span>
      </div>
    </a>
  );
}

function PullRequestView(props: { record: WorkflowRepo; pr: WorkflowPR; base: string; names: Record<string, string> }) {
  const record = props.record;
  const pr = props.pr;
  const [parts, setParts] = useState<WorkflowPRParts | null>(null);
  const [busy, setBusy] = useState("");
  const [merging, setMerging] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [closeIssue, setCloseIssue] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [allFiles, setAllFiles] = useState(false);

  // What it is made of; read again when it changes (a new review, a new version read from GitHub).
  useEffect(() => {
    let current = true;
    api<{ pr: WorkflowPR; parts: WorkflowPRParts }>(`/api/workflow/${record.repo}/pulls/${pr.number}`)
      .then((data) => {
        if (current) {
          setParts(data.parts);
        }
      })
      .catch((err) => toast.error(`Could not load #${pr.number}: ${err instanceof Error ? err.message : err}`));
    return () => {
      current = false;
    };
  }, [record.repo, pr.number, pr.at]);

  async function merge() {
    setBusy("merge");
    try {
      await api(`/api/workflow/${record.repo}/pulls/${pr.number}/merge`, { method: "POST" });
      toast.success(`Merged #${pr.number}`);
    } catch (err) {
      toast.error(`Could not merge it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function reject() {
    setBusy("reject");
    try {
      await api(`/api/workflow/${record.repo}/pulls/${pr.number}/reject`, { method: "POST", body: { reason: reason, close_issue: closeIssue } });
      toast.success(`Rejected #${pr.number}`);
      setRejecting(false);
      setReason("");
    } catch (err) {
      toast.error(`Could not reject it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  const issue = pr.issue !== null ? record.issues[String(pr.issue)] : undefined;
  const review = pr.review;
  const by = pr.by === "you" ? `you${pr.author !== null ? ` (@${pr.author})` : ""}` : (props.names[pr.by] ?? "a worker");
  const decider = pr.decision?.by === "agent" ? "the review agent" : "you";
  const files = [...pr.files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const shownFiles = allFiles ? files : files.slice(0, FILES_SHOWN);
  const fileMax = Math.max(1, ...files.map((file) => file.added + file.removed));
  const tests = parts?.tests;
  const section = "space-y-2 border-t px-4 py-3";
  const title = "text-[15px] font-semibold";

  // The code, file by file, as far as DIFF_LINES.
  const diffLines = (parts?.diff ?? "").split("\n");
  const cut = diffLines.length > DIFF_LINES;

  return (
    <div className="pb-8">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Button size="sm" variant="ghost" asChild>
          <a href={`${props.base}&tab=pulls${pr.state === "review" || pr.state === "waiting" ? "" : "&state=closed"}`}>
            <ArrowLeft /> Pull requests
          </a>
        </Button>
      </div>

      <div className="space-y-1 px-4 py-3">
        <h2 className="text-base font-semibold">{review !== null && review.summary !== "" ? review.summary : pr.title}</h2>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
          <span className="font-mono text-xs">{pr.title}</span>
          <span>·</span>
          <span>
            #{pr.number} by {by}, {timeAgo(pr.created_at)}
          </span>
          {issue !== undefined && (
            <>
              <span>·</span>
              <a href={`${props.base}&tab=issues&open=${issue.number}`} className="hover:underline">
                for #{issue.number} {issue.title}
              </a>
            </>
          )}
          {pr.url !== null && (
            <a href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
              GitHub <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
        {pr.state === "waiting" && record.decides === "you" && (
          <>
            <Button disabled={busy !== ""} onClick={() => setMerging(true)}>
              {busy === "merge" ? <Loader2 className="animate-spin" /> : <GitMerge />} Merge
            </Button>
            <Button variant="outline" disabled={busy !== ""} onClick={() => setRejecting(true)}>
              <X /> Reject
            </Button>
            {pr.checks !== null && pr.checks !== "none" && <span className="text-xs text-muted-foreground">Checks on GitHub: {pr.checks}</span>}
          </>
        )}
        {pr.state === "waiting" && record.decides === "agent" && (
          <span className="text-muted-foreground">The review agent decides on this repository: its advice is carried out{pr.github !== null ? " once GitHub's checks are done" : ""}.</span>
        )}
        {pr.state === "review" && (
          <>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> The review agent is reviewing it.
            </span>
            <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== ""} onClick={() => setRejecting(true)}>
              <X /> Reject
            </Button>
          </>
        )}
        {pr.state === "merged" && pr.decision !== null && (
          <span>
            Merged by {decider} {timeAgo(pr.decision.at)}.
          </span>
        )}
        {pr.state === "rejected" && pr.decision !== null && (
          <span>
            Rejected by {decider} {timeAgo(pr.decision.at)}
            {pr.decision.reason ? `: ${pr.decision.reason}` : "."}
          </span>
        )}
        {pr.state === "closed" && <span>Closed on GitHub.</span>}
        {pr.error !== "" && <div className="w-full text-destructive">The last merge failed: {pr.error}</div>}
      </div>

      {review !== null && review.advice !== null && (
        <div className={section}>
          <div className="flex items-center gap-2">
            <span className={title}>Review agent</span>
            {review.advice === "merge" ? <Badge variant="ok">Merge</Badge> : <Badge variant="bad">Don't merge</Badge>}
            <span className="text-xs text-muted-foreground">{timeAgo(review.at)}</span>
          </div>
          {review.important.length > 0 && (
            <div className={cn("rounded-md border px-3 py-2", review.advice === "dont_merge" ? "border-destructive/40 bg-destructive/5" : "bg-muted/30")}>
              <div className="mb-1 font-medium">What you should know</div>
              <ul className="list-disc space-y-1 pl-5">
                {review.important.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 max-md:grid-cols-1">
            <span className="font-medium">What it checked</span>
            <span className="max-w-3xl whitespace-pre-wrap">{review.checked}</span>
          </div>
          {review.evidence.length > 0 && (
            <div className="-mx-4">
              <Overview draft={{ kind: "comment", overview: {}, evidence: review.evidence, body: "", repo: record.repo } as unknown as Draft} files={0} added={0} removed={0} />
            </div>
          )}
        </div>
      )}

      {issue !== undefined && (
        <div className={section}>
          <div className={title}>What it is for</div>
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 max-md:grid-cols-1">
            <span className="font-medium">Goal</span>
            <span className="max-w-3xl">{issue.goal || issue.title}</span>
            {issue.requirements.length > 0 && (
              <>
                <span className="font-medium">Requirements</span>
                <ul className="max-w-3xl list-disc space-y-1 pl-4">
                  {issue.requirements.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
            {issue.validation !== "" && (
              <>
                <span className="font-medium">How to check</span>
                <span className="max-w-3xl whitespace-pre-wrap">{issue.validation}</span>
              </>
            )}
          </div>
        </div>
      )}

      {parts === null && (
        <div className="flex items-center gap-1.5 border-t px-4 py-3 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      )}
      {parts !== null && parts.overview !== undefined && (
        <div className="border-t">
          <div className={cn(title, "px-4 pt-3")}>From its worker</div>
          <Overview
            draft={{ kind: "pr", overview: parts.overview, evidence: parts.evidence ?? [], body: "", repo: record.repo } as unknown as Draft}
            files={pr.files.length}
            added={pr.added}
            removed={pr.removed}
          />
        </div>
      )}
      {parts !== null && parts.overview === undefined && parts.body.trim() !== "" && (
        <div className={section}>
          <div className={title}>Its description</div>
          <Markdown text={parts.body} repo={record.repo} githubImagesOnly />
        </div>
      )}

      {files.length > 0 && (
        <div className={section}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={title}>Files changed</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {files.length} {files.length === 1 ? "file" : "files"}, {pr.added} lines added, {pr.removed} removed
            </span>
            <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className={cn("size-2.5 rounded-[2px]", ADDED)} /> Added lines
              </span>
              <span className="flex items-center gap-1">
                <span className={cn("size-2.5 rounded-[2px]", REMOVED)} /> Removed lines
              </span>
            </span>
          </div>
          <div className="space-y-1">
            {shownFiles.map((file) => (
              <div
                key={file.path}
                className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 rounded-sm px-1 py-0.5 hover:bg-accent/50 max-md:grid-cols-1 max-md:gap-0.5"
                title={`${file.path}: ${file.added} lines added, ${file.removed} removed`}
              >
                <span className="truncate font-mono text-xs" dir="rtl">
                  {file.path}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="flex h-3 min-w-0 flex-1 items-center gap-[2px]">
                    {file.added > 0 && <span className={cn("h-3 shrink-0 rounded-l-[2px]", ADDED, file.removed === 0 && "rounded-r-[4px]")} style={{ width: `${(file.added / fileMax) * 85}%` }} />}
                    {file.removed > 0 && <span className={cn("h-3 shrink-0 rounded-r-[4px]", REMOVED, file.added === 0 && "rounded-l-[2px]")} style={{ width: `${(file.removed / fileMax) * 85}%` }} />}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    +{file.added} −{file.removed}
                  </span>
                </span>
              </div>
            ))}
          </div>
          {files.length > FILES_SHOWN && (
            <Button size="xs" variant="ghost" onClick={() => setAllFiles(!allFiles)}>
              {allFiles ? "Show fewer" : `Show all ${files.length} files`}
            </Button>
          )}
        </div>
      )}

      {tests !== undefined && tests.after !== null && (
        <div className={section}>
          <div className={title}>Tests</div>
          <div>
            {tests.before !== null && tests.before.passed ? "Passed on the code before the change, and " : ""}
            {tests.after.passed ? "passed with the change" : "failed with the change"}, {tests.after.scope === "focused" ? "the tests that cover it" : "the official checks"}:{" "}
            <code className="font-mono text-xs">{tests.after.command}</code>
          </div>
        </div>
      )}

      {parts !== null && parts.diff !== "" && (
        <div className={section}>
          <button type="button" className="flex items-center gap-1 font-semibold hover:underline" onClick={() => setCodeOpen(!codeOpen)}>
            {codeOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} The code
          </button>
          {codeOpen && (
            <div className="overflow-x-auto rounded-md border font-mono text-xs leading-5">
              {diffLines.slice(0, DIFF_LINES).map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    "px-2 whitespace-pre",
                    line.startsWith("diff --git ") && "mt-2 border-y bg-muted/60 py-1 font-semibold first:mt-0 first:border-t-0",
                    line.startsWith("@@") && "bg-muted/40 text-muted-foreground",
                    line.startsWith("+") && !line.startsWith("+++") && "bg-ok/12",
                    line.startsWith("-") && !line.startsWith("---") && "bg-destructive/12",
                  )}
                >
                  {line.startsWith("diff --git ") ? line.split(" b/").slice(-1)[0] : line || " "}
                </div>
              ))}
              {cut && <div className="border-t px-2 py-1 text-muted-foreground">Cut at {DIFF_LINES.toLocaleString()} lines.</div>}
            </div>
          )}
        </div>
      )}

      <AlertDialog open={merging} onOpenChange={setMerging}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge #{pr.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pr.github !== null
                ? `It is squash-merged on GitHub as you: one commit on the default branch, titled "${pr.title}".`
                : `Its change goes onto ${record.repo}'s default branch on GitHub as one commit, as you, titled "${pr.title}".`}
              {review !== null && review.advice === "dont_merge" && " The review agent advised not to merge it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={merge}>Merge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reject #{pr.number}?</DialogTitle>
            <DialogDescription>
              {pr.by === "you"
                ? "It is closed on GitHub."
                : `${pr.github !== null ? "It is closed on GitHub. " : ""}Its worker hears why and makes it again, unless you close the issue too.`}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Why, for the worker: what is wrong or missing."
            className="min-h-24"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {issue !== undefined && issue.state === "open" && (
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-primary" checked={closeIssue} onChange={(event) => setCloseIssue(event.target.checked)} />
              Close #{issue.number} too: it isn't wanted
            </label>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button disabled={busy !== ""} onClick={reject}>
              {busy === "reject" && <Loader2 className="animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
