/*
The Workspace tab's Pull requests (#/pulls): your pull requests anywhere on GitHub, public and private, like
github.com/pulls. Read with your sign-in (github_searcher/pull_requests.py, GET /api/pull_requests); signed out, a line
says to sign in (Account, on the GitHub tab). The last answer of each view is kept in this browser (localStorage), so
the page shows at once, and GitHub's answer replaces it a moment later.
The bars on top, like GitHub's:
- Which pull requests: Created by me, Assigned to me, Mentioned or Review requests (view=assigned|mentioned|
  review-requested; none is Created by me), a box that filters by repo, title and number, and on the right when they
  were read from GitHub and Refresh.
- Tabs Open (first) and Closed (merged ones too) with how many, then Visibility (Public or Private,
  visibility=public|private), Repository (one of the repos in the list, repo=owner/name) and Sort: Newest, Oldest,
  Most commented, Least commented, Recently updated, Least recently updated (sort=created-asc|comments-desc|
  comments-asc|updated-desc|updated-asc; none is Newest). The tabs count what Visibility and Repository leave.
Everything is in the address, so a reload or back keeps it. On a narrow screen (a phone) the bars wrap.
A row, like GitHub's list: the state (open, draft, merged, closed), the repo (a lock when private), the title and
labels; under it the number, who opened it and when (or when it was merged or closed), checks and review while open,
and when it last changed; on the right how many comments. A click opens it in the thread pop-up (ThreadDialog.tsx,
open=owner/name%23n); closing it reads the list again.
PRs in archived repos are left out, like on GitHub. At most the 500 most recently updated open ones and closed ones are
read; a line says so when GitHub has more.
*/

import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, Lock, MessageSquare, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import ThreadDialog from "@/ThreadDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

// What GET /api/pull_requests gives (github_searcher/pull_requests.py).
type PullRequest = {
  id: string; // owner/name#n
  repo: string;
  private: boolean;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: { name: string; color: string }[];
  comments: number;
  review: "approved" | "changes_requested" | "review_required" | "none";
  checks: "passed" | "failed" | "running" | "none";
};

// open and closed: how many GitHub has, which may be more than were read.
type PullRequestList = { items: PullRequest[]; open: number; closed: number; login: string; at: string };

const VIEWS: Record<string, string> = { created: "Created by me", assigned: "Assigned to me", mentioned: "Mentioned", "review-requested": "Review requests" };
const SORTS: Record<string, string> = {
  "created-desc": "Newest",
  "created-asc": "Oldest",
  "comments-desc": "Most commented",
  "comments-asc": "Least commented",
  "updated-desc": "Recently updated",
  "updated-asc": "Least recently updated",
};
const CHECKS_TEXT: Record<string, string> = { passed: "Checks passed", failed: "Checks failed", running: "Checks running", none: "" };
const CHECKS_COLOR: Record<string, string> = { passed: "text-ok", failed: "text-destructive", running: "text-warn", none: "" };
const REVIEW_TEXT: Record<string, string> = { approved: "Approved", changes_requested: "Changes asked for", review_required: "Waiting for a review", none: "" };
const REVIEW_COLOR: Record<string, string> = { approved: "text-ok", changes_requested: "text-warn", review_required: "", none: "" };

export default function PullRequests(props: { state: string; view: string; visibility: string; repo: string | null; sort: string; open: string | null }) {
  const yourRepos = useLive("your_repos");
  const reposLoaded = useLoaded("your_repos");
  // This view's last answer, kept in this browser, so the page shows at once.
  const [list, setList] = useState<PullRequestList | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(`pull-requests:${props.view}`) ?? "null");
    } catch {
      // Storage blocked or broken: nothing kept yet.
      return null;
    }
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Goes up to read the list again from GitHub (Refresh, a closed pop-up).
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("");

  const signedOut = reposLoaded && yourRepos.login === null && yourRepos.error === null;

  // Read the view from GitHub; a late answer after leaving the page is dropped.
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    api<PullRequestList>(`/api/pull_requests?view=${props.view}`)
      .then((result) => {
        if (!current) {
          return;
        }
        setList(result);
        setLoading(false);
        try {
          localStorage.setItem(`pull-requests:${props.view}`, JSON.stringify(result));
        } catch {
          // Storage full or blocked: kept while the page is open.
        }
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
  }, [props.view, reload]);

  // This list's address (only what isn't the default), and the same with one setting changed (null: its default).
  const params = new URLSearchParams();
  if (props.state === "closed") {
    params.set("state", "closed");
  }
  if (props.view !== "created") {
    params.set("view", props.view);
  }
  if (props.visibility !== "all") {
    params.set("visibility", props.visibility);
  }
  if (props.repo !== null) {
    params.set("repo", props.repo);
  }
  if (props.sort !== "created-desc") {
    params.set("sort", props.sort);
  }
  const listHash = params.toString() !== "" ? `#/pulls?${params}` : "#/pulls";

  function go(name: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null) {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    window.location.hash = next.toString() !== "" ? `#/pulls?${next}` : "#/pulls";
  }

  const items = list?.items ?? [];
  // The repos in the list, by name, for Repository (and the chosen one, also when this view has none of it).
  const repoNames: string[] = [];
  for (const pr of items) {
    if (!repoNames.includes(pr.repo)) {
      repoNames.push(pr.repo);
    }
  }
  if (props.repo !== null && !repoNames.includes(props.repo)) {
    repoNames.push(props.repo);
  }
  repoNames.sort((a, b) => a.localeCompare(b));

  // Visibility and Repository first: the tabs count those, like GitHub's. Then the tab's own, the filter and the sort.
  const kept = items.filter((pr) => (props.visibility === "all" || pr.private === (props.visibility === "private")) && (props.repo === null || pr.repo === props.repo));
  const openCount = kept.filter((pr) => pr.state === "open").length;
  const closedCount = kept.length - openCount;
  const needle = filter.trim().toLowerCase().replace(/^#/, "");
  const rows = kept.filter(
    (pr) => (pr.state === "open") === (props.state === "open") && (needle === "" || `${pr.repo} ${pr.title}`.toLowerCase().includes(needle) || String(pr.number) === needle),
  );
  rows.sort((a, b) => {
    if (props.sort === "created-asc") {
      return a.created_at.localeCompare(b.created_at);
    }
    if (props.sort === "comments-desc") {
      return b.comments - a.comments;
    }
    if (props.sort === "comments-asc") {
      return a.comments - b.comments;
    }
    if (props.sort === "updated-desc") {
      return b.updated_at.localeCompare(a.updated_at);
    }
    if (props.sort === "updated-asc") {
      return a.updated_at.localeCompare(b.updated_at);
    }
    return b.created_at.localeCompare(a.created_at);
  });

  // How many of this tab GitHub has that weren't read (more than 500).
  const readOpen = items.filter((pr) => pr.state === "open").length;
  let unread = 0;
  if (list !== null) {
    unread = props.state === "open" ? list.open - readOpen : list.closed - (items.length - readOpen);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1">
        <Select value={props.view} onValueChange={(value) => go("view", value === "created" ? null : value)}>
          <SelectTrigger size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {Object.keys(VIEWS).map((key) => (
              <SelectItem key={key} value={key}>
                {VIEWS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input className="w-52 max-md:w-auto max-md:min-w-0 max-md:flex-1" placeholder="Filter pull requests" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div className="ml-auto flex items-center gap-1.5">
          {list !== null && <span className="mr-1 text-xs text-muted-foreground max-md:hidden">Updated {timeAgo(list.at)}</span>}
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setReload((count) => count + 1)}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
        </div>
      </div>

      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1">
        <Tabs value={props.state} onValueChange={(value) => go("state", value === "closed" ? "closed" : null)}>
          <TabsList>
            <TabsTrigger value="open" className="px-2.5">
              Open <span className="text-xs text-muted-foreground tabular-nums">{list !== null ? openCount : ""}</span>
            </TabsTrigger>
            <TabsTrigger value="closed" className="px-2.5">
              Closed <span className="text-xs text-muted-foreground tabular-nums">{list !== null ? closedCount : ""}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select value={props.visibility === "all" ? "" : props.visibility} onValueChange={(value) => go("visibility", value === "all" ? null : value)}>
            <SelectTrigger size="sm">
              <SelectValue placeholder="Visibility" />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="private">Private</SelectItem>
            </SelectContent>
          </Select>
          <Select value={props.repo ?? ""} onValueChange={(value) => go("repo", value === "all" ? null : value)}>
            <SelectTrigger size="sm" className="max-w-56">
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="all">All repositories</SelectItem>
              {repoNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={props.sort} onValueChange={(value) => go("sort", value === "created-desc" ? null : value)}>
            <SelectTrigger size="sm">
              <span className="text-muted-foreground">Sort:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {Object.keys(SORTS).map((key) => (
                <SelectItem key={key} value={key}>
                  {SORTS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error !== "" && !signedOut && <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read them from GitHub: {error}</div>}
      {unread > 0 && (
        <div className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
          GitHub has {unread} more, updated earlier. Only the 500 most recently updated are here.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {signedOut && (
          <div className="px-3 py-2 text-muted-foreground">
            <a href="#/github/account" className="text-primary hover:underline">
              Sign in with GitHub
            </a>{" "}
            to see your pull requests.
          </div>
        )}
        {!signedOut && list === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {!signedOut && list !== null && rows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            {needle !== "" ? "Nothing matches the filter." : props.state === "closed" ? "No closed pull requests." : "No open pull requests."}
          </div>
        )}
        {!signedOut &&
          rows.map((pr) => {
            let icon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
            let when = `#${pr.number} opened ${timeAgo(pr.created_at)} by ${pr.author}`;
            if (pr.state === "open" && pr.draft) {
              icon = <GitPullRequestDraft className="size-4 shrink-0 text-muted-foreground" />;
            } else if (pr.state === "merged") {
              icon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
              when = `#${pr.number} by ${pr.author} was merged ${timeAgo(pr.closed_at ?? pr.updated_at)}`;
            } else if (pr.state === "closed") {
              icon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
              when = `#${pr.number} by ${pr.author} was closed ${timeAgo(pr.closed_at ?? pr.updated_at)}`;
            }
            return (
              <div
                key={pr.id}
                className={cn("flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50", pr.id === props.open && "bg-selected hover:bg-selected")}
                onClick={() => go("open", pr.id)}
              >
                <span className="mt-px">{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="flex items-center gap-1 text-muted-foreground">
                      {pr.private && <Lock className="size-3" />}
                      {pr.repo}
                    </span>
                    <span className="font-medium">{pr.title}</span>
                    {pr.labels.map((label) => (
                      <Badge key={label.name} variant="outline" className="py-0">
                        {label.name}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>{when}</span>
                    {pr.state === "open" && pr.draft && <span>Draft</span>}
                    {pr.state === "open" && CHECKS_TEXT[pr.checks] !== "" && <span className={CHECKS_COLOR[pr.checks]}>{CHECKS_TEXT[pr.checks]}</span>}
                    {pr.state === "open" && REVIEW_TEXT[pr.review] !== "" && <span className={REVIEW_COLOR[pr.review]}>{REVIEW_TEXT[pr.review]}</span>}
                    <span>updated {timeAgo(pr.updated_at)}</span>
                  </div>
                </div>
                {pr.comments > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="size-3" /> {pr.comments}
                  </span>
                )}
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
