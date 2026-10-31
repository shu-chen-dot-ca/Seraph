/*
One of your repositories or a repo you starred (#/github/repo?repo=owner/name), opened from Your repositories or
Starred in the GitHub tab's left list (GitHubNav.tsx): like the repo's page on GitHub, without browsing its code. Read
fresh from GitHub, with your sign-in (it may be private), each time a tab opens (backend/your_repositories_api.py);
Refresh reads it again.
The bar on top: the repo's name (a lock when private; opens it on GitHub), tabs Overview, Issues, Pull requests (with
how many are open) and Actions (tab=issues|pulls|actions in the address), and on the right Star or Unstar with how many
stars it has (one click, like on GitHub; a repo you unstar leaves Starred at once, its page stays open until you go)
and Refresh.
- Overview: the description, stars and forks, the newest commits on the default branch (each with whether its
  checks passed, who made it and when; a click opens it on GitHub), then the README.
- Issues and Pull requests: tabs Open and Closed (state=closed) with how many, a box that filters by title and number,
  and the newest 50, the newest change first, like GitHub's lists. An issue row: its state, title, labels, number, who
  opened it and when, who it is assigned to, comments. A PR row: its state (open, draft, merged, closed), title,
  labels, number, author, branch, checks (passed, failed, running), review (approved, changes asked for, waiting for a
  review) and comments. A click opens it in the thread pop-up (ThreadDialog.tsx, open=owner/name%23n), where you
  comment. Closing the pop-up reads the list again.
- Actions: the newest GitHub Actions runs: passed, failed, cancelled, running or waiting, the workflow, what it ran
  for, the branch, what started it, who and when. A click opens the run on GitHub.
*/

import {
  BookMarked,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  Lock,
  MessageSquare,
  RefreshCw,
  Star,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import ThreadDialog from "@/ThreadDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

// What GET /api/your_repositories/<repo>/<tab> gives (github_searcher/your_repositories.py).
type RepoCommit = { sha: string; message: string; at: string; url: string; login: string | null; name: string; checks: "passed" | "failed" | "running" | "none" };

type RepoOverview = {
  description: string;
  url: string;
  private: boolean;
  homepage: string;
  stars: number;
  forks: number;
  default_branch: string;
  readme: string;
  commits: RepoCommit[];
};

type RepoLabel = { name: string; color: string };

type RepoIssue = {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  reason: string | null;
  author: string;
  created_at: string;
  updated_at: string;
  labels: RepoLabel[];
  assignees: string[];
  comments: number;
};

type RepoPull = {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  branch: string;
  created_at: string;
  updated_at: string;
  review: "approved" | "changes_requested" | "review_required" | "none";
  checks: "passed" | "failed" | "running" | "none";
  labels: RepoLabel[];
  comments: number;
};

// state: GitHub's conclusion once done (success, failure, cancelled, skipped, ...), else running or waiting.
type RepoRun = { id: number; workflow: string; title: string; number: number; event: string; branch: string; state: string; actor: string; at: string; url: string };

const CHECKS_TEXT: Record<string, string> = { passed: "Checks passed", failed: "Checks failed", running: "Checks running", none: "" };
const CHECKS_COLOR: Record<string, string> = { passed: "text-ok", failed: "text-destructive", running: "text-warn", none: "" };
const REVIEW_TEXT: Record<string, string> = { approved: "Approved", changes_requested: "Changes asked for", review_required: "Waiting for a review", none: "" };
const REVIEW_COLOR: Record<string, string> = { approved: "text-ok", changes_requested: "text-warn", review_required: "", none: "" };
const RUN_TEXT: Record<string, string> = {
  success: "Passed",
  failure: "Failed",
  timed_out: "Timed out",
  startup_failure: "Failed to start",
  cancelled: "Cancelled",
  skipped: "Skipped",
  neutral: "Neutral",
  stale: "Stale",
  running: "Running",
  waiting: "Waiting",
};
const FAILED = ["failure", "timed_out", "startup_failure"];
const TABS = ["issues", "pulls", "actions"];

export default function Repository(props: { repo: string; tab: string; state: string; open: string | null }) {
  const yourRepos = useLive("your_repos");
  const [overview, setOverview] = useState<RepoOverview | null>(null);
  const [issues, setIssues] = useState<{ items: RepoIssue[]; open: number; closed: number } | null>(null);
  const [pulls, setPulls] = useState<{ items: RepoPull[]; open: number; closed: number } | null>(null);
  const [runs, setRuns] = useState<{ items: RepoRun[] } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Goes up to read the tab again (Refresh, a closed pop-up).
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("");
  const [starring, setStarring] = useState(false);

  const tab = TABS.includes(props.tab) ? props.tab : "overview";
  const listed = yourRepos.repos.find((each) => each.name === props.repo) ?? yourRepos.starred.find((each) => each.name === props.repo);
  const starred = listed !== undefined && listed.starred;
  const stars = listed?.stars ?? overview?.stars ?? 0;
  const base = `#/github/repo?repo=${encodeURIComponent(props.repo)}`;
  let listHash = base;
  if (tab !== "overview") {
    listHash += `&tab=${tab}`;
  }
  if (props.state === "closed") {
    listHash += "&state=closed";
  }

  // Read the open tab from GitHub: when it opens, and on Refresh. A late answer for another tab is dropped.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    let path = tab;
    if (tab === "actions") {
      path = "runs";
    }
    api<never>(`/api/your_repositories/${props.repo}/${path}?state=${props.state}`)
      .then((result) => {
        if (!current) {
          return;
        }
        if (tab === "overview") {
          setOverview(result);
        } else if (tab === "issues") {
          setIssues(result);
        } else if (tab === "pulls") {
          setPulls(result);
        } else {
          setRuns(result);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (current) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [props.repo, tab, props.state, reload]);

  // One click, like on GitHub. The left list follows at once (the backend reads the lists again).
  async function toggleStar() {
    setStarring(true);
    try {
      const result = await api<{ done: string }>("/api/your_repositories/act", { method: "POST", body: { repo: props.repo, action: starred ? "unstar" : "star" } });
      toast.success(result.done);
    } catch (err) {
      toast.error(`Could not ${starred ? "unstar" : "star"} it: ${err instanceof Error ? err.message : err}`);
    }
    setStarring(false);
  }

  const needle = filter.trim().toLowerCase().replace(/^#/, "");
  const issueRows = (issues?.items ?? []).filter((each) => needle === "" || each.title.toLowerCase().includes(needle) || String(each.number) === needle);
  const pullRows = (pulls?.items ?? []).filter((each) => needle === "" || each.title.toLowerCase().includes(needle) || String(each.number) === needle);
  const counts = tab === "issues" ? issues : pulls;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <a
          href={`https://github.com/${props.repo}`}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
          title="Open on GitHub"
        >
          {listed !== undefined && listed.private ? <Lock className="size-4 shrink-0 text-muted-foreground" /> : <BookMarked className="size-4 shrink-0 text-muted-foreground" />}
          <span className="truncate">{props.repo}</span>
        </a>
        <Tabs value={tab} onValueChange={(value) => (window.location.hash = value === "overview" ? base : `${base}&tab=${value}`)}>
          <TabsList>
            <TabsTrigger value="overview" className="px-2.5">
              Overview
            </TabsTrigger>
            <TabsTrigger value="issues" className="px-2.5">
              Issues {listed !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{listed.open_issues}</span>}
            </TabsTrigger>
            <TabsTrigger value="pulls" className="px-2.5">
              Pull requests {listed !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{listed.open_prs}</span>}
            </TabsTrigger>
            <TabsTrigger value="actions" className="px-2.5">
              Actions
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={starring || yourRepos.login === null} onClick={toggleStar}>
            {starring ? <Loader2 className="animate-spin" /> : <Star className={cn(starred && "fill-current text-warn")} />}
            {starred ? "Unstar" : "Star"}
            <span className="text-xs text-muted-foreground tabular-nums">{stars}</span>
          </Button>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setReload((count) => count + 1)}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
        </div>
      </div>

      {(tab === "issues" || tab === "pulls") && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <Tabs value={props.state} onValueChange={(value) => (window.location.hash = value === "closed" ? `${base}&tab=${tab}&state=closed` : `${base}&tab=${tab}`)}>
            <TabsList>
              <TabsTrigger value="open" className="px-2.5">
                Open <span className="text-xs text-muted-foreground tabular-nums">{counts?.open ?? ""}</span>
              </TabsTrigger>
              <TabsTrigger value="closed" className="px-2.5">
                Closed <span className="text-xs text-muted-foreground tabular-nums">{counts?.closed ?? ""}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Input
            className="w-52"
            placeholder={tab === "pulls" ? "Filter pull requests" : "Filter issues"}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      {error !== "" && <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read it from GitHub: {error}</div>}

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" && overview === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {tab === "overview" && overview !== null && (
          <div className="max-w-4xl space-y-4 p-4">
            <div className="space-y-1">
              {overview.description !== "" && <p>{overview.description}</p>}
              <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                {overview.private && <span>Private</span>}
                <span className="flex items-center gap-1">
                  <Star className="size-3" /> {overview.stars}
                </span>
                <span>{overview.forks === 1 ? "1 fork" : `${overview.forks} forks`}</span>
                {overview.homepage !== "" && (
                  <a href={overview.homepage} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                    {overview.homepage} <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>

            <section>
              <div className="mb-1 font-medium">Latest commits{overview.default_branch !== "" && ` on ${overview.default_branch}`}</div>
              {overview.commits.length === 0 && <div className="text-muted-foreground">No commits yet.</div>}
              <div className="rounded-md border">
                {overview.commits.map((commit) => (
                  <a
                    key={commit.sha}
                    href={commit.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent/50"
                  >
                    {commit.checks === "passed" && <CircleCheck className="size-3.5 shrink-0 text-ok" />}
                    {commit.checks === "failed" && <CircleX className="size-3.5 shrink-0 text-destructive" />}
                    {commit.checks === "running" && <CircleDashed className="size-3.5 shrink-0 text-warn" />}
                    {commit.checks === "none" && <span className="size-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{commit.message}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {commit.login ?? commit.name} · {timeAgo(commit.at)}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                  </a>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-1 font-medium">README</div>
              <div className="rounded-md border px-4 py-3">
                {overview.readme === "" ? (
                  <span className="text-muted-foreground">No README.</span>
                ) : (
                  <Markdown text={overview.readme} repo={props.repo} gitRef={overview.default_branch} base="" issueRefs />
                )}
              </div>
            </section>
          </div>
        )}

        {tab === "issues" && issues === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {tab === "issues" && issues !== null && issueRows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">{needle !== "" ? "Nothing matches the filter." : props.state === "closed" ? "No closed issues." : "No open issues."}</div>
        )}
        {tab === "issues" &&
          issueRows.map((issue) => {
            let icon = <CircleDot className="size-4 shrink-0 text-ok" />;
            if (issue.state === "closed" && (issue.reason === "not_planned" || issue.reason === "duplicate")) {
              icon = <CircleSlash className="size-4 shrink-0 text-muted-foreground" />;
            } else if (issue.state === "closed") {
              icon = <CircleCheck className="size-4 shrink-0 text-violet-500" />;
            }
            return (
              <div
                key={issue.id}
                className={cn("flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50", issue.id === props.open && "bg-selected hover:bg-selected")}
                onClick={() => (window.location.hash = `${listHash}&open=${encodeURIComponent(issue.id)}`)}
              >
                <span className="mt-px">{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium">{issue.title}</span>
                    {issue.labels.map((label) => (
                      <Badge key={label.name} variant="outline" className="py-0">
                        {label.name}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>
                      #{issue.number} opened {timeAgo(issue.created_at)} by {issue.author}
                    </span>
                    {issue.assignees.length > 0 && <span>Assigned to {issue.assignees.join(", ")}</span>}
                    <span>updated {timeAgo(issue.updated_at)}</span>
                  </div>
                </div>
                {issue.comments > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="size-3" /> {issue.comments}
                  </span>
                )}
              </div>
            );
          })}

        {tab === "pulls" && pulls === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {tab === "pulls" && pulls !== null && pullRows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            {needle !== "" ? "Nothing matches the filter." : props.state === "closed" ? "No closed pull requests." : "No open pull requests."}
          </div>
        )}
        {tab === "pulls" &&
          pullRows.map((pull) => {
            let icon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
            if (pull.state === "open" && pull.draft) {
              icon = <GitPullRequestDraft className="size-4 shrink-0 text-muted-foreground" />;
            } else if (pull.state === "merged") {
              icon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
            } else if (pull.state === "closed") {
              icon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
            }
            return (
              <div
                key={pull.id}
                className={cn("flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50", pull.id === props.open && "bg-selected hover:bg-selected")}
                onClick={() => (window.location.hash = `${listHash}&open=${encodeURIComponent(pull.id)}`)}
              >
                <span className="mt-px">{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium">{pull.title}</span>
                    {pull.labels.map((label) => (
                      <Badge key={label.name} variant="outline" className="py-0">
                        {label.name}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>
                      #{pull.number} opened {timeAgo(pull.created_at)} by {pull.author}
                    </span>
                    <span className="font-mono">{pull.branch}</span>
                    {pull.state === "open" && CHECKS_TEXT[pull.checks] !== "" && <span className={CHECKS_COLOR[pull.checks]}>{CHECKS_TEXT[pull.checks]}</span>}
                    {pull.state === "open" && REVIEW_TEXT[pull.review] !== "" && <span className={REVIEW_COLOR[pull.review]}>{REVIEW_TEXT[pull.review]}</span>}
                    <span>updated {timeAgo(pull.updated_at)}</span>
                  </div>
                </div>
                {pull.comments > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="size-3" /> {pull.comments}
                  </span>
                )}
              </div>
            );
          })}

        {tab === "actions" && runs === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {tab === "actions" && runs !== null && runs.items.length === 0 && <div className="px-3 py-2 text-muted-foreground">No GitHub Actions runs.</div>}
        {tab === "actions" &&
          runs !== null &&
          runs.items.map((run) => {
            let icon = <CircleDashed className="size-4 shrink-0 text-muted-foreground" />;
            if (run.state === "success") {
              icon = <CircleCheck className="size-4 shrink-0 text-ok" />;
            } else if (FAILED.includes(run.state)) {
              icon = <CircleX className="size-4 shrink-0 text-destructive" />;
            } else if (run.state === "running") {
              icon = <Loader2 className="size-4 shrink-0 animate-spin text-warn" />;
            } else if (run.state === "waiting") {
              icon = <Clock className="size-4 shrink-0 text-warn" />;
            }
            return (
              <div
                key={run.id}
                className="flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50"
                onClick={() => window.open(run.url, "_blank", "noopener,noreferrer")}
              >
                <span className="mt-px">{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{run.title || run.workflow}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{RUN_TEXT[run.state] ?? run.state}</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="text-foreground">
                      {run.workflow} #{run.number}
                    </span>
                    {run.branch !== "" && <span className="font-mono">{run.branch}</span>}
                    <span>
                      {run.event} by {run.actor}, {timeAgo(run.at)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      <ThreadDialog
        id={props.open}
        onClose={() => {
          window.location.hash = listHash;
          setReload((count) => count + 1);
        }}
      />
    </div>
  );
}
