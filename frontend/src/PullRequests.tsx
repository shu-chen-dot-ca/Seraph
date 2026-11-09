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
and when it last changed; on the right how many files it changes, the lines added (green) and removed (red), and
how many comments. A click opens it in the thread pop-up (ThreadDialog.tsx,
open=owner/name%23n); closing it reads the list again. So does a PR of yours the app follows (pr_tracking.py) being
opened, merged or closed, so the list keeps up with GitHub on its own.
The Dashboard's Pull requests (#/dashboard/pulls) is this page too, plain: only Created by me, with Open and Closed and
Refresh, no filter, Visibility, Repository or Sort (base is where it is, plain says so). Each row starts with its
repo's logo (the owner's picture, square), like the Repository page's cards, and next to it two lines as tall as the
logo: the title on top, the repo and the PR's number at the bottom, a link to it on GitHub (a local one: only the
repo, linked to it on GitHub, since it has no number yet). Rows go by repo, A to Z, the newest
first within a repo (on Closed, the merged ones first and the closed ones always at the bottom), and say when they were opened in days ("opened 5 days ago"; merged and closed ones also when that
happened). Its Open tab also lists, under
the open ones and in gray, the local pull requests: PR drafts not sent to GitHub yet (waiting in the Inbox, or approved
before you signed in; new PRs, not new versions of open ones), under Not published with Publish all. Each has its
files and lines (counted from its diff) and Publish on its right. Publish asks first (Enter confirms), then opens each on GitHub as you, all at once, the same as
Approve in the Inbox (a waiting one) or Send to GitHub (an approved one): a toast each, with Open. A sent one leaves
the list, and the open list is read again when all are done.
The Dashboard's has a third tab, Actions (state=actions), with how many: everything agents put on GitHub as you, newest
first (GET /api/actions, github_searcher/inbox.py): a pull request opened, a new version pushed or a rebase, a comment,
a new title and description, an issue opened, a branch updated. A row like a pull request's: the repo's logo, on top
what it did and its title (none for a comment), at the bottom the repo and number where it happened (a link to it on
GitHub), the issue it was for (on GitHub: its job's, else the one its pull request links, else the opened issue
itself) and the agent (its chat); on the right how long ago. A deleted comment says Deleted. A click opens the thread
in the pop-up. It is read again on Refresh, on every tab change and whenever a draft changes.
PRs in archived repos are left out, like on GitHub. At most the 500 most recently updated open ones and closed ones are
read; a line says so when GitHub has more.
*/

import { Bot, CircleDot, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, Lock, MessageSquare, Pencil, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import ThreadDialog from "@/ThreadDialog";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type Draft } from "@/live";
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
  // How many files it changes and lines it adds and removes (missing in a list kept from before they were read).
  files?: number;
  additions?: number;
  deletions?: number;
};

// open and closed: how many GitHub has, which may be more than were read.
type PullRequestList = { items: PullRequest[]; open: number; closed: number; login: string; at: string };

// What GET /api/actions gives (github_searcher/inbox.py ACTIONS_FILE): one thing an agent put on GitHub. sent is the
// draft's (live.ts DraftSent), or only url, repo, number and at for what the agent did itself (issue, update_branch).
type AgentAction = {
  draft: string | null;
  kind: "pr" | "comment" | "edit" | "issue" | "update_branch";
  agent: string;
  job: string | null;
  title: string;
  sent: { url: string; repo: string; number: number; at: string; update?: boolean; rebase_of?: string | null; deleted_at?: string };
};

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

export default function PullRequests(props: {
  state: string;
  view: string;
  visibility: string;
  repo: string | null;
  sort: string;
  open: string | null;
  base: string;
  plain: boolean;
}) {
  const yourRepos = useLive("your_repos");
  const inbox = useLive("inbox");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const prs = useLive("prs");
  // The Dashboard's Actions.
  const [actions, setActions] = useState<AgentAction[] | null>(null);
  const [actionsError, setActionsError] = useState("");
  // Local pull requests being published, and the ones Publish asks about (they stay set while the dialog fades out).
  const [publishing, setPublishing] = useState<string[]>([]);
  const [toPublish, setToPublish] = useState<Draft[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
  // Your PRs the app follows (pr_tracking.py, read every few minutes) and their states: when one is opened, merged or
  // closed there, the list is read again, so it keeps up with GitHub without Refresh.
  const followed = prs.items
    .filter((each) => each.relation === "author")
    .map((each) => `${each.id} ${each.state}`)
    .join(",");

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
  }, [props.view, reload, followed]);

  // The Dashboard's Actions: read with the list, on every tab change and whenever a draft changes (one was sent).
  useEffect(() => {
    if (!props.plain) {
      return;
    }
    let current = true;
    api<AgentAction[]>("/api/actions")
      .then((result) => {
        if (current) {
          setActions(result);
          setActionsError("");
        }
      })
      .catch((err) => {
        if (current) {
          setActionsError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      current = false;
    };
  }, [props.plain, props.state, reload, inbox]);

  const onActions = props.state === "actions";

  // This list's address (only what isn't the default), and the same with one setting changed (null: its default).
  const params = new URLSearchParams();
  if (props.state !== "open") {
    params.set("state", props.state);
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
  const listHash = params.toString() !== "" ? `${props.base}?${params}` : props.base;

  function go(name: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null) {
      next.delete(name);
    } else {
      next.set(name, value);
    }
    window.location.hash = next.toString() !== "" ? `${props.base}?${next}` : props.base;
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
  // The Dashboard's: merged ones first and closed ones always at the bottom, then by repo, A to Z, the newest first
  // within a repo.
  if (props.plain) {
    rows.sort((a, b) => {
      const aClosed = a.state === "closed" ? 1 : 0;
      const bClosed = b.state === "closed" ? 1 : 0;
      return aClosed - bClosed || a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()) || b.created_at.localeCompare(a.created_at);
    });
  }

  // The Dashboard's times: whole days ago.
  function daysAgo(iso: string) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days < 1) {
      return "today";
    }
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }

  // How many of this tab GitHub has that weren't read (more than 500).
  const readOpen = items.filter((pr) => pr.state === "open").length;
  let unread = 0;
  if (list !== null && !onActions) {
    unread = props.state === "open" ? list.open - readOpen : list.closed - (items.length - readOpen);
  }

  // Local pull requests: PR drafts not sent to GitHub yet. New PRs only, not new versions of ones already open.
  const localPRs = inbox.filter(
    (draft) => draft.kind === "pr" && draft.update_of === null && draft.sent === null && (draft.status === "pending" || draft.status === "approved"),
  );
  const unpublished = localPRs.filter((draft) => !publishing.includes(draft.id));

  function askPublish(drafts: Draft[]) {
    setToPublish(drafts);
    setConfirmOpen(true);
  }

  // A waiting draft is approved and sent, like Approve in the Inbox; an approved one is sent, like Send to GitHub.
  async function publishOne(draft: Draft) {
    setPublishing((current) => [...current, draft.id]);
    try {
      let result: Draft;
      if (draft.status === "pending") {
        result = await api<Draft>(`/api/inbox/${draft.id}/approve`, { method: "POST", body: { text: "", send: true } });
      } else {
        result = await api<Draft>(`/api/inbox/${draft.id}/send`, { method: "POST" });
      }
      const sent = result.sent;
      if (sent !== null) {
        toast.success(`PR opened: ${sent.repo}#${sent.number}`, {
          action: { label: "Open", onClick: () => window.open(sent.url, "_blank", "noopener,noreferrer") },
        });
      }
    } catch (err) {
      toast.error(`Could not publish ${draft.title}: ${err instanceof Error ? err.message : err}`);
    }
    setPublishing((current) => current.filter((id) => id !== draft.id));
  }

  async function publish() {
    await Promise.all(toPublish.map(publishOne));
    setReload((count) => count + 1);
  }

  // Open and Closed: in the second bar, or alone in the first one when plain, then with Actions.
  const stateTabs = (
    <Tabs value={props.state} onValueChange={(value) => go("state", value === "open" ? null : value)}>
      <TabsList>
        <TabsTrigger value="open" className="px-2.5">
          Open <span className="text-xs text-muted-foreground tabular-nums">{list !== null ? openCount : ""}</span>
        </TabsTrigger>
        <TabsTrigger value="closed" className="px-2.5">
          Closed <span className="text-xs text-muted-foreground tabular-nums">{list !== null ? closedCount : ""}</span>
        </TabsTrigger>
        {props.plain && (
          <TabsTrigger value="actions" className="px-2.5">
            Actions <span className="text-xs text-muted-foreground tabular-nums">{actions !== null ? actions.length : ""}</span>
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1">
        {props.plain && stateTabs}
        {!props.plain && (
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
        )}
        {!props.plain && (
          <Input className="w-52 max-md:w-auto max-md:min-w-0 max-md:flex-1" placeholder="Filter pull requests" value={filter} onChange={(event) => setFilter(event.target.value)} />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {list !== null && !onActions && <span className="mr-1 text-xs text-muted-foreground max-md:hidden">Updated {timeAgo(list.at)}</span>}
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setReload((count) => count + 1)}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
          </Button>
        </div>
      </div>

      {!props.plain && (
        <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1">
          {stateTabs}
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
      )}

      {error !== "" && !signedOut && !onActions && <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read them from GitHub: {error}</div>}
      {actionsError !== "" && onActions && <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read the actions: {actionsError}</div>}
      {unread > 0 && (
        <div className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
          GitHub has {unread} more, updated earlier. Only the 500 most recently updated are here.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {signedOut && !onActions && (
          <div className="px-3 py-2 text-muted-foreground">
            <a href="#/github/account" className="text-primary hover:underline">
              Sign in with GitHub
            </a>{" "}
            to see your pull requests.
          </div>
        )}
        {!signedOut && !onActions && list === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {!signedOut && !onActions && list !== null && rows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            {needle !== "" ? "Nothing matches the filter." : props.state === "closed" ? "No closed pull requests." : "No open pull requests."}
          </div>
        )}
        {onActions && actions === null && actionsError === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {onActions && actions !== null && actions.length === 0 && <div className="px-3 py-2 text-muted-foreground">No actions yet.</div>}
        {onActions &&
          actions !== null &&
          actions.map((action) => {
            const thread = `${action.sent.repo}#${action.sent.number}`;
            // What it did, its icon and its title (a comment's draft title only says where it went).
            let what = "Opened a pull request";
            let icon = <GitPullRequest className="text-ok" />;
            let title = action.title;
            if (action.kind === "pr" && action.sent.update) {
              what = action.sent.rebase_of ? "Rebased a pull request" : "Pushed a new version";
            }
            if (action.kind === "comment") {
              what = "Commented";
              icon = <MessageSquare />;
              title = "";
            }
            if (action.kind === "edit") {
              what = "Changed the title and description";
              icon = <Pencil />;
            }
            if (action.kind === "issue") {
              what = "Opened an issue";
              icon = <CircleDot className="text-ok" />;
            }
            if (action.kind === "update_branch") {
              what = "Updated the branch";
              icon = <GitBranch />;
              title = items.find((pr) => pr.id === thread)?.title ?? "";
            }
            // The issue it was for: its job's, else the one its pull request links, else the issue it opened.
            const job = jobs.find((each) => each.id === action.job);
            let issue: string | null = null;
            let issueUrl = "";
            if (job !== undefined && job.issue !== null) {
              issue = job.issue;
              issueUrl = `https://github.com/${job.issue.replace("#", "/issues/")}`;
            }
            const tracked = prs.items.find((each) => each.id === (job?.thread ?? thread));
            if (issue === null && tracked !== undefined && tracked.issues.length > 0) {
              issue = `${tracked.repo}#${tracked.issues[0].number}`;
              issueUrl = tracked.issues[0].url;
            }
            if (issue === null && action.kind === "issue") {
              issue = thread;
              issueUrl = action.sent.url;
            }
            const agent = agents.find((each) => each.id === action.agent);
            return (
              <div
                key={`${action.sent.url} ${action.sent.at}`}
                className={cn("flex cursor-pointer items-center gap-3 border-b px-3 py-2 hover:bg-accent/50", thread === props.open && "bg-selected hover:bg-selected")}
                onClick={() => go("open", thread)}
              >
                <img src={`https://github.com/${action.sent.repo.split("/")[0]}.png?size=72`} alt="" className="size-9 shrink-0 rounded-md" />
                <div className="flex h-9 min-w-0 flex-1 flex-col justify-between">
                  <div className="flex min-w-0 items-center gap-2 leading-tight">
                    <span className="shrink-0 font-medium">{what}</span>
                    {title !== "" && <span className="truncate text-muted-foreground">{title}</span>}
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 text-xs leading-tight whitespace-nowrap text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0">
                    {icon}
                    <a href={action.sent.url} target="_blank" rel="noreferrer" className="truncate hover:text-foreground hover:underline" onClick={(event) => event.stopPropagation()}>
                      {action.sent.repo} #{action.sent.number}
                    </a>
                    {action.sent.deleted_at && <span>· Deleted</span>}
                    {issue !== null && (
                      <>
                        <span>·</span>
                        <a href={issueUrl} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline" onClick={(event) => event.stopPropagation()}>
                          Issue #{issue.split("#")[1]}
                        </a>
                      </>
                    )}
                    <span>·</span>
                    <Bot />
                    <a href={`#/agents/${action.agent}`} className="truncate hover:text-foreground hover:underline" onClick={(event) => event.stopPropagation()}>
                      {agent?.name ?? action.agent}
                    </a>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(action.sent.at).toLocaleString()}>
                  {timeAgo(action.sent.at)}
                </span>
              </div>
            );
          })}
        {!signedOut &&
          !onActions &&
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
            // The Dashboard's: when it was opened, in days, and when it was merged or closed.
            if (props.plain) {
              when = `opened ${daysAgo(pr.created_at)}`;
            }
            if (props.plain && pr.state === "merged") {
              when += `, merged ${daysAgo(pr.closed_at ?? pr.updated_at)}`;
            }
            if (props.plain && pr.state === "closed") {
              when += `, closed ${daysAgo(pr.closed_at ?? pr.updated_at)}`;
            }
            // The Dashboard's row: the logo, and next to it two lines as tall as it, the title on top and the repo with
            // the PR's number at the bottom.
            if (props.plain) {
              return (
                <div
                  key={pr.id}
                  className={cn("flex cursor-pointer items-center gap-3 border-b px-3 py-2 hover:bg-accent/50", pr.id === props.open && "bg-selected hover:bg-selected")}
                  onClick={() => go("open", pr.id)}
                >
                  <img src={`https://github.com/${pr.repo.split("/")[0]}.png?size=72`} alt="" className="size-9 shrink-0 rounded-md" />
                  <div className="flex h-9 min-w-0 flex-1 flex-col justify-between">
                    <div className="flex min-w-0 items-center gap-2 leading-tight">
                      <span className="truncate font-medium">{pr.title}</span>
                      {pr.labels.map((label) => (
                        <Badge key={label.name} variant="outline" className="shrink-0 py-0">
                          {label.name}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 text-xs leading-tight whitespace-nowrap text-muted-foreground [&>svg]:size-3.5">
                      {icon}
                      {pr.private && <Lock className="size-3 shrink-0" />}
                      <a href={pr.url} target="_blank" rel="noreferrer" className="truncate hover:text-foreground hover:underline" onClick={(event) => event.stopPropagation()}>
                        {pr.repo} #{pr.number}
                      </a>
                      <span>· {when}</span>
                      {pr.state === "open" && pr.draft && <span>· Draft</span>}
                      {pr.state === "open" && CHECKS_TEXT[pr.checks] !== "" && <span className={CHECKS_COLOR[pr.checks]}>· {CHECKS_TEXT[pr.checks]}</span>}
                      {pr.state === "open" && REVIEW_TEXT[pr.review] !== "" && <span className={REVIEW_COLOR[pr.review]}>· {REVIEW_TEXT[pr.review]}</span>}
                    </div>
                  </div>
                  {pr.files !== undefined && (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                      {pr.files === 1 ? "1 file" : `${pr.files} files`}
                      <span className="text-ok">+{pr.additions}</span>
                      <span className="text-destructive">−{pr.deletions}</span>
                    </span>
                  )}
                  {pr.comments > 0 && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <MessageSquare className="size-3" /> {pr.comments}
                    </span>
                  )}
                </div>
              );
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
                    {!props.plain && <span>updated {timeAgo(pr.updated_at)}</span>}
                  </div>
                </div>
                {pr.files !== undefined && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                    {pr.files === 1 ? "1 file" : `${pr.files} files`}
                    <span className="text-ok">+{pr.additions}</span>
                    <span className="text-destructive">−{pr.deletions}</span>
                  </span>
                )}
                {pr.comments > 0 && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <MessageSquare className="size-3" /> {pr.comments}
                  </span>
                )}
              </div>
            );
          })}

        {props.plain && props.state === "open" && localPRs.length > 0 && (
          <div className="flex min-h-9 items-center gap-2 border-b bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
            Not published <span className="tabular-nums">{localPRs.length}</span>
            {unpublished.length > 0 && (
              <Button size="xs" variant="outline" className="ml-auto" onClick={() => askPublish(unpublished)}>
                Publish all
              </Button>
            )}
          </div>
        )}
        {props.plain &&
          props.state === "open" &&
          localPRs.map((draft) => {
            // The files and lines its diff changes, counted from the diff itself.
            let files = 0;
            let additions = 0;
            let deletions = 0;
            for (const line of draft.diff.split("\n")) {
              if (line.startsWith("diff --git ")) {
                files += 1;
              } else if (line.startsWith("+") && !line.startsWith("+++")) {
                additions += 1;
              } else if (line.startsWith("-") && !line.startsWith("---")) {
                deletions += 1;
              }
            }
            return (
              <div key={draft.id} className="flex items-center gap-3 border-b px-3 py-2 text-muted-foreground">
                {draft.repo !== null && <img src={`https://github.com/${draft.repo.split("/")[0]}.png?size=72`} alt="" className="size-9 shrink-0 rounded-md opacity-60" />}
                <div className="flex h-9 min-w-0 flex-1 flex-col justify-between">
                  <div className="truncate leading-tight font-medium">{draft.title}</div>
                  <div className="flex min-w-0 items-center gap-1.5 text-xs leading-tight whitespace-nowrap">
                    <GitPullRequest className="size-3.5 shrink-0" />
                    <a href={`https://github.com/${draft.repo}`} target="_blank" rel="noreferrer" className="truncate hover:text-foreground hover:underline">
                      {draft.repo}
                    </a>
                    <span>· Not published, drafted {daysAgo(draft.created_at)}</span>
                  </div>
                </div>
                {files > 0 && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
                    {files === 1 ? "1 file" : `${files} files`}
                    <span className="text-ok">+{additions}</span>
                    <span className="text-destructive">−{deletions}</span>
                  </span>
                )}
                {publishing.includes(draft.id) && (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs">
                    <Loader2 className="size-3.5 animate-spin" /> Publishing…
                  </span>
                )}
                {!publishing.includes(draft.id) && (
                  <Button size="xs" variant="outline" className="shrink-0" onClick={() => askPublish([draft])}>
                    Publish
                  </Button>
                )}
              </div>
            );
          })}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish {toPublish.length === 1 ? toPublish[0].title : `${toPublish.length} pull requests`}?</AlertDialogTitle>
            <AlertDialogDescription>{toPublish.length === 1 ? "It opens on GitHub as you." : "Each opens on GitHub as you."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={publish}>Publish</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
