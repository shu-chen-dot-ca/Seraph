/*
The PRs page (#/prs): your PRs on GitHub and how each one stands (github_searcher/pr_tracking.py). It lists every PR
the Inbox's Approve sent, and your other PRs on other people's projects (the ones you sent by hand, found with your
GitHub account from Settings), the newest change first. Tabs: Open, Merged, Closed, All.
The header says when they were last read from GitHub (every few minutes on its own, and right after Approve sends
one) and has Check now.
Each row, like GitHub's own PR list: the state (open, draft, merged, closed), the title, the repo and number, when
it last changed, and in plain words where it stands:
- Checks: "Waiting for a maintainer to approve the checks" (GitHub runs nothing for a first-time contributor's PR
  until a maintainer clicks approve, so this is normal and only needs waiting), running, passed, failed, or none.
- Review: approved, changes asked for, reviewed with comments, or not reviewed yet.
- How many comments and who wrote the latest (a maintainer, a bot, you), and the issue it fixes, open or closed.
A click opens the row in place: each reviewer's latest review, the latest comment's text, the labels, the issues it
fixes with who they are assigned to, why the last read failed (if it did), and links: the PR on GitHub, the draft it
was sent from in the Inbox, and its job.
*/

import { ChevronRight, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { since, useNow } from "@/components/ui/job-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type TrackedPR } from "@/live";
import { cn } from "@/lib/utils";

const TABS = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const CHECKS_TEXT: Record<string, string> = {
  waiting: "Waiting for a maintainer to approve the checks",
  running: "Checks running",
  passed: "Checks passed",
  failed: "Checks failed",
  none: "No checks",
};
const CHECKS_COLOR: Record<string, string> = { waiting: "text-warn", running: "text-warn", passed: "text-ok", failed: "text-destructive", none: "" };

const REVIEW_TEXT: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Changes asked for",
  commented: "Reviewed with comments",
  none: "Not reviewed yet",
};
const REVIEW_COLOR: Record<string, string> = { approved: "text-ok", changes_requested: "text-warn", commented: "", none: "" };

const REVIEW_STATE: Record<string, string> = {
  approved: "approved",
  changes_requested: "asked for changes",
  commented: "commented",
  dismissed: "review dismissed",
};

// Who someone is, in plain words, from GitHub's role for them.
function who(login: string, role: string, pr: TrackedPR): string {
  if (login === pr.author) {
    return "you";
  }
  if (role === "BOT") {
    return `${login} (bot)`;
  }
  if (role === "OWNER" || role === "MEMBER" || role === "COLLABORATOR") {
    return `${login} (maintainer)`;
  }
  return login;
}

export default function PRs() {
  const prs = useLive("prs");
  const loaded = useLoaded("prs");
  const [tab, setTab] = useState("open");
  const [open, setOpen] = useState<string[]>([]);
  const now = useNow();

  const counts: Record<string, number> = { all: prs.items.length };
  for (const item of TABS) {
    if (item.value !== "all") {
      counts[item.value] = prs.items.filter((pr) => pr.state === item.value).length;
    }
  }
  const rows = prs.items.filter((pr) => tab === "all" || pr.state === tab);

  function toggle(id: string) {
    if (open.includes(id)) {
      setOpen(open.filter((other) => other !== id));
      return;
    }
    setOpen([...open, id]);
  }

  async function checkNow() {
    try {
      await api("/api/prs/refresh", { method: "POST" });
    } catch (err) {
      toast.error(`Could not check the PRs: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {TABS.map((item) => (
              <TabsTrigger key={item.value} value={item.value} className="px-2.5">
                {item.label}
                <span className="text-xs text-muted-foreground tabular-nums">{counts[item.value]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className={cn("ml-auto text-xs text-muted-foreground", prs.error !== null && "text-destructive")} title={prs.error ?? undefined}>
          {prs.error !== null ? "Could not search for your PRs" : prs.checked_at !== null ? `Checked ${since(prs.checked_at, now)} ago` : ""}
        </span>
        <Button size="sm" variant="outline" disabled={prs.refreshing} onClick={checkNow}>
          {prs.refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check now
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && prs.items.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            No PRs yet. A PR you approve in the Inbox shows here once it is on GitHub; with your GitHub account connected in Settings, so do the
            ones you sent by hand.
          </div>
        )}
        {loaded && prs.items.length > 0 && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">None here.</div>}

        {rows.map((pr) => {
          const isOpen = open.includes(pr.id);
          let icon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
          if (pr.state === "open" && pr.draft) {
            icon = <GitPullRequestDraft className="size-4 shrink-0 text-muted-foreground" />;
          } else if (pr.state === "merged") {
            icon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
          } else if (pr.state === "closed") {
            icon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
          }
          return (
            <div key={pr.id} className="border-b">
              <div className={cn("flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/50", isOpen && "bg-accent/40")} onClick={() => toggle(pr.id)}>
                <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                <span className="mt-px">{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium">{pr.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {pr.state === "merged" && pr.closed_at !== null ? `merged ${since(pr.closed_at, now)} ago` : `updated ${since(pr.updated_at, now)} ago`}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="text-foreground">
                      {pr.repo} #{pr.number}
                    </span>
                    {pr.state === "open" && <span className={CHECKS_COLOR[pr.checks]}>{CHECKS_TEXT[pr.checks]}</span>}
                    {pr.state === "open" && <span className={REVIEW_COLOR[pr.review]}>{REVIEW_TEXT[pr.review]}</span>}
                    {pr.state === "merged" && pr.merged_by !== null && <span className="text-ok">Merged by {pr.merged_by}</span>}
                    {pr.state === "closed" && <span className="text-destructive">Closed without merging</span>}
                    <span>
                      {pr.comments === 1 ? "1 comment" : `${pr.comments} comments`}
                      {pr.last_comment !== null && `, the latest by ${who(pr.last_comment.login, pr.last_comment.role, pr)} ${since(pr.last_comment.at, now)} ago`}
                    </span>
                    {pr.issues.map((issue) => (
                      <span key={issue.number}>
                        Fixes #{issue.number}, {issue.state === "open" ? "still open" : "closed"}
                      </span>
                    ))}
                    {pr.error !== null && <span className="text-destructive">Last check failed</span>}
                  </div>
                </div>
              </div>

              {isOpen && (
                <div className="space-y-2 px-3 pb-3 pl-[52px] text-xs">
                  {pr.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {pr.labels.map((label) => (
                        <Badge key={label} variant="outline">
                          {label}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {pr.state === "open" && pr.checks === "waiting" && (
                    <div className="text-muted-foreground">
                      GitHub doesn't run a project's checks on a first-time contributor's PR until a maintainer approves them ({pr.waiting_runs}{" "}
                      {pr.waiting_runs === 1 ? "run waits" : "runs wait"}). Nothing is wrong: it waits for a maintainer. Once one of your PRs is merged
                      there, your next ones run right away.
                    </div>
                  )}
                  <div>
                    <div className="font-medium">Reviews</div>
                    {pr.reviewers.length === 0 && <div className="text-muted-foreground">Nobody reviewed it yet.</div>}
                    {pr.reviewers.map((reviewer) => (
                      <div key={reviewer.login}>
                        {who(reviewer.login, reviewer.role, pr)}: {REVIEW_STATE[reviewer.state] ?? reviewer.state}, {since(reviewer.at, now)} ago
                      </div>
                    ))}
                  </div>
                  {pr.last_comment !== null && (
                    <div>
                      <div className="font-medium">
                        Latest comment, by {who(pr.last_comment.login, pr.last_comment.role, pr)}, {since(pr.last_comment.at, now)} ago
                      </div>
                      <div className="text-muted-foreground">{pr.last_comment.text}</div>
                    </div>
                  )}
                  {pr.issues.length > 0 && (
                    <div>
                      <div className="font-medium">Fixes</div>
                      {pr.issues.map((issue) => (
                        <div key={issue.number}>
                          <a href={issue.url} target="_blank" rel="noreferrer" className="hover:underline">
                            #{issue.number} {issue.title}
                          </a>
                          <span className="text-muted-foreground">
                            {" "}
                            ({issue.state === "open" ? "open" : issue.reason === "not_planned" ? "closed as not planned" : "closed"}
                            {issue.assignees.length > 0 && `, assigned to ${issue.assignees.join(", ")}`})
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {pr.error !== null && <div className="text-destructive">The last check failed: {pr.error}</div>}
                  <div className="flex gap-3">
                    <a href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                      Open on GitHub <ExternalLink className="size-3" />
                    </a>
                    {pr.draft_id !== null && (
                      <a href={`#/inbox/${pr.draft_id}`} className="hover:underline">
                        Its draft
                      </a>
                    )}
                    {pr.job !== null && (
                      <a href={`#/jobs/${pr.job}`} className="hover:underline">
                        Its job
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
