/*
One of your repositories or a repo you starred, like the repo's page on GitHub: on the GitHub tab
(#/github/repo?repo=owner/name, opened from Your repositories or Starred in its left list, GitHubNav.tsx) and on the
Workspace tab's Home (#/home?repo=owner/name, Home.tsx; base is that address, and every tab and pop-up below keeps
it). Read fresh from GitHub, with your sign-in (it may be private), each time a tab opens
(backend/your_repositories_api.py); Refresh reads it again. It only reads, except the buttons that say what they do.
The bar on top: the repo's name (a lock when private; opens it on GitHub), tabs Code, Issues, Pull requests (with
how many are open), Commits and Actions (tab=issues|pulls|commits|actions in the address; none is Code), and on the
right Star or Unstar with how many stars it has (one click, like on GitHub; a repo you unstar leaves Starred at once,
its page stays open until you go), New issue and Refresh. On a narrow screen (a phone) the bar wraps: the tabs go on
a line of their own and scroll sideways.
- Code: the description, stars, forks and website, then the files like on GitHub: the newest commit on the default
  branch on top (whether its checks passed, who, the message, its id, when; a click opens it on GitHub), where you are
  (the repo's name, then each folder: a click goes back there), then the folder's folders and files, folders first
  (.. goes up). A click on a folder goes into it; a click on a file shows it in the same box: code with line numbers,
  rendered markdown for .md files, or that it is binary or too big, with GitHub (the file there). The README of the
  repo is under the files, at the top folder. Where you are isn't in the address: a reload starts at the top.
- Commits: the newest 50 commits on the default branch, each with whether its checks passed, the message, who and
  when, and its id; a click opens it on GitHub.
- Issues and Pull requests: tabs Open and Closed (state=closed) with how many, a box that filters by title and number,
  and the newest 50, the newest change first, like GitHub's lists. An issue row: its state, title, labels, number, who
  opened it and when, who it is assigned to, comments. A PR row: its state (open, draft, merged, closed), title,
  labels, number, author, branch, checks (passed, failed, running), review (approved, changes asked for, waiting for a
  review) and comments. A click opens it in the thread pop-up (ThreadDialog.tsx, open=owner/name%23n), where you
  comment, and in your own repositories do what a maintainer does: review, merge, close, label, assign, edit, each
  after an "are you sure?". Closing the pop-up reads the list again.
- Actions: the newest GitHub Actions runs: passed, failed, cancelled, running or waiting, the workflow, what it ran
  for, the branch, what started it, who and when. A click opens the run on GitHub. In your own repositories a failed
  run has Re-run failed jobs, after an "are you sure?".
New issue opens NewIssueDialog.tsx.
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
  File,
  FileText,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  Lock,
  MessageSquare,
  Plus,
  RefreshCw,
  Star,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";

import NewIssueDialog from "@/NewIssueDialog";
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

// The Code tab's files (tree: a folder, blob: a file) and one file (text is null when binary or too big).
type RepoFiles = { files: { path: string; type: "blob" | "tree"; size: number }[]; truncated: boolean };
type RepoFileText = { path: string; text: string | null; size: number; binary: boolean; too_big: boolean };

const SIZE = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

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
const TABS = ["issues", "pulls", "commits", "actions"];

export default function Repository(props: { repo: string; tab: string; state: string; open: string | null; base?: string }) {
  const yourRepos = useLive("your_repos");
  const [overview, setOverview] = useState<RepoOverview | null>(null);
  const [commits, setCommits] = useState<RepoOverview | null>(null);
  const [files, setFiles] = useState<RepoFiles | null>(null);
  const [filesError, setFilesError] = useState("");
  // The Code tab: the folder you are in ("" is the top) and the file shown, if any. Files read stay here.
  const [folder, setFolder] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<Record<string, RepoFileText>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<{ items: RepoIssue[]; open: number; closed: number } | null>(null);
  const [pulls, setPulls] = useState<{ items: RepoPull[]; open: number; closed: number } | null>(null);
  const [runs, setRuns] = useState<{ items: RepoRun[] } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Goes up to read the tab again (Refresh, a closed pop-up, a new issue, a re-run).
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState("");
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  // The run whose failed jobs Re-run would start again, while its "are you sure?" is open.
  const [rerun, setRerun] = useState<RepoRun | null>(null);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [starring, setStarring] = useState(false);

  const tab = TABS.includes(props.tab) ? props.tab : "code";
  const listed = yourRepos.repos.find((each) => each.name === props.repo) ?? yourRepos.starred.find((each) => each.name === props.repo);
  const starred = listed !== undefined && listed.starred;
  const stars = listed?.stars ?? overview?.stars ?? 0;
  const canPush = listed !== undefined && listed.can_push;
  const base = props.base ?? `#/github/repo?repo=${encodeURIComponent(props.repo)}`;
  let listHash = base;
  if (tab !== "code") {
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
    if (tab === "code") {
      path = "overview";
    } else if (tab === "actions") {
      path = "runs";
    }
    api<never>(`/api/your_repositories/${props.repo}/${path}?state=${props.state}`)
      .then((result) => {
        if (!current) {
          return;
        }
        if (tab === "code") {
          setOverview(result);
        } else if (tab === "commits") {
          setCommits(result);
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

  // The Code tab's files, all in one answer: when the tab opens, and on Refresh.
  useEffect(() => {
    if (tab !== "code") {
      return;
    }
    let current = true;
    setFilesError("");
    api<RepoFiles>(`/api/your_repositories/${props.repo}/tree`)
      .then((result) => {
        if (current) {
          setFiles(result);
        }
      })
      .catch((err) => {
        if (current) {
          setFilesError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      current = false;
    };
  }, [props.repo, tab, reload]);

  function showFolder(path: string) {
    setFolder(path);
    setOpenFile(null);
  }

  // Shows a file in the files' box; read once, then kept.
  async function showFile(path: string) {
    setOpenFile(path);
    if (fileData[path] !== undefined) {
      return;
    }
    setFileErrors((current) => ({ ...current, [path]: "" }));
    try {
      const data = await api<RepoFileText>(`/api/your_repositories/${props.repo}/file?path=${encodeURIComponent(path)}`);
      setFileData((current) => ({ ...current, [path]: data }));
    } catch (err) {
      setFileErrors((current) => ({ ...current, [path]: err instanceof Error ? err.message : String(err) }));
    }
  }

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

  async function rerunFailed() {
    if (rerun === null) {
      return;
    }
    try {
      const result = await api<{ done: string }>("/api/your_repositories/act", {
        method: "POST",
        body: { repo: props.repo, action: "rerun_failed", fields: { run_id: rerun.id } },
      });
      toast.success(result.done);
      setReload((count) => count + 1);
    } catch (err) {
      toast.error(`Could not run it again: ${err instanceof Error ? err.message : err}`);
    }
  }

  const needle = filter.trim().toLowerCase().replace(/^#/, "");
  const issueRows = (issues?.items ?? []).filter((each) => needle === "" || each.title.toLowerCase().includes(needle) || String(each.number) === needle);
  const pullRows = (pulls?.items ?? []).filter((each) => needle === "" || each.title.toLowerCase().includes(needle) || String(each.number) === needle);
  const counts = tab === "issues" ? issues : pulls;

  // The Code tab: the folder's folders and files (folders first, then by name), where you are, and the file shown.
  const entries = (files?.files ?? []).filter((each) => (each.path.includes("/") ? each.path.slice(0, each.path.lastIndexOf("/")) : "") === folder);
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "tree" ? -1 : 1));
  const crumbs: { name: string; path: string }[] = [];
  const folderNames = folder === "" ? [] : folder.split("/");
  for (let i = 0; i < folderNames.length; i++) {
    crumbs.push({ name: folderNames[i], path: folderNames.slice(0, i + 1).join("/") });
  }
  const shownFile = openFile !== null ? fileData[openFile] : undefined;
  const shownError = openFile !== null ? (fileErrors[openFile] ?? "") : "";
  const isMarkdown = openFile !== null && /\.(md|markdown|mdx)$/i.test(openFile);
  let numbers = "";
  if (shownFile !== undefined && shownFile.text !== null && !isMarkdown) {
    const count = shownFile.text.split("\n").length - (shownFile.text.endsWith("\n") ? 1 : 0);
    numbers = Array.from({ length: count }, (_, i) => i + 1).join("\n");
  }
  const latest = overview !== null && overview.commits.length > 0 ? overview.commits[0] : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3 max-md:h-auto max-md:flex-wrap max-md:gap-y-1 max-md:py-1">
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
        <Tabs
          value={tab}
          onValueChange={(value) => (window.location.hash = value === "code" ? base : `${base}&tab=${value}`)}
          className="max-md:order-last max-md:w-full max-md:overflow-x-auto"
        >
          <TabsList>
            <TabsTrigger value="code" className="px-2.5">
              Code
            </TabsTrigger>
            <TabsTrigger value="issues" className="px-2.5">
              Issues {listed !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{listed.open_issues}</span>}
            </TabsTrigger>
            <TabsTrigger value="pulls" className="px-2.5">
              Pull requests {listed !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{listed.open_prs}</span>}
            </TabsTrigger>
            <TabsTrigger value="commits" className="px-2.5">
              Commits
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
          <Button size="sm" variant="outline" disabled={yourRepos.login === null} onClick={() => setNewIssueOpen(true)}>
            <Plus /> New issue
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
        {tab === "code" && overview === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {tab === "code" && overview !== null && (
          <div className="max-w-5xl space-y-4 p-4 max-md:p-2">
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

            <section className="rounded-md border">
              {/* The newest commit on the default branch, like GitHub's bar over the files. */}
              {latest !== null && (
                <a
                  href={latest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs hover:bg-accent/50"
                >
                  {latest.checks === "passed" && <CircleCheck className="size-3.5 shrink-0 text-ok" />}
                  {latest.checks === "failed" && <CircleX className="size-3.5 shrink-0 text-destructive" />}
                  {latest.checks === "running" && <CircleDashed className="size-3.5 shrink-0 text-warn" />}
                  <span className="shrink-0 font-medium">{latest.login ?? latest.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{latest.message}</span>
                  <span className="shrink-0 font-mono text-muted-foreground max-md:hidden">{latest.sha.slice(0, 7)}</span>
                  <span className="shrink-0 text-muted-foreground">{timeAgo(latest.at)}</span>
                </a>
              )}

              {/* Where you are: the repo, then each folder (a click goes back there), then the file shown. */}
              <div className="flex min-w-0 flex-wrap items-center gap-1 border-b px-3 py-1.5">
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => showFolder("")}>
                  {props.repo.slice(props.repo.indexOf("/") + 1)}
                </button>
                {crumbs.map((crumb) => (
                  <Fragment key={crumb.path}>
                    <span className="text-muted-foreground">/</span>
                    <button type="button" className="text-primary hover:underline" onClick={() => showFolder(crumb.path)}>
                      {crumb.name}
                    </button>
                  </Fragment>
                ))}
                {openFile !== null && (
                  <>
                    <span className="text-muted-foreground">/</span>
                    <span className="font-medium">{openFile.slice(openFile.lastIndexOf("/") + 1)}</span>
                    <a
                      href={`https://github.com/${props.repo}/blob/${overview.default_branch}/${openFile}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      GitHub <ExternalLink className="size-3" />
                    </a>
                  </>
                )}
              </div>

              {filesError !== "" && <div className="px-3 py-2 text-destructive">Could not read the files: {filesError}</div>}
              {openFile === null && files === null && filesError === "" && (
                <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading files…
                </div>
              )}
              {openFile === null && files !== null && files.truncated && (
                <div className="border-b px-3 py-1 text-xs text-warn">GitHub cut this list short: some files are missing.</div>
              )}
              {openFile === null && files !== null && files.files.length === 0 && <div className="px-3 py-2 text-muted-foreground">This repo is empty.</div>}
              {openFile === null && folder !== "" && (
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 border-b px-3 text-left text-muted-foreground hover:bg-accent/50"
                  onClick={() => showFolder(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "")}
                >
                  <Folder className="size-4 shrink-0" /> ..
                </button>
              )}
              {openFile === null &&
                entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className="flex h-8 w-full items-center gap-2 border-b px-3 text-left last:border-b-0 hover:bg-accent/50"
                    onClick={() => (entry.type === "tree" ? showFolder(entry.path) : showFile(entry.path))}
                  >
                    {entry.type === "tree" && <Folder className="size-4 shrink-0 text-primary" />}
                    {entry.type === "blob" && /\.(md|markdown|mdx)$/i.test(entry.path) && <FileText className="size-4 shrink-0 text-muted-foreground" />}
                    {entry.type === "blob" && !/\.(md|markdown|mdx)$/i.test(entry.path) && <File className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{entry.path.slice(entry.path.lastIndexOf("/") + 1)}</span>
                    {entry.type === "blob" && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{SIZE.format(entry.size)}B</span>}
                  </button>
                ))}

              {openFile !== null && shownFile === undefined && shownError === "" && (
                <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </div>
              )}
              {openFile !== null && shownError !== "" && <div className="px-3 py-2 text-destructive">Could not read it: {shownError}</div>}
              {shownFile !== undefined && shownFile.binary && <div className="px-3 py-2 text-muted-foreground">Binary file, {SIZE.format(shownFile.size)}B.</div>}
              {shownFile !== undefined && shownFile.too_big && (
                <div className="px-3 py-2 text-muted-foreground">Too big to show here ({SIZE.format(shownFile.size)}B). Open it on GitHub.</div>
              )}
              {shownFile !== undefined && shownFile.text !== null && isMarkdown && (
                <div className="px-6 py-4 max-md:px-3">
                  <Markdown text={shownFile.text} repo={props.repo} gitRef={overview.default_branch} base={folder} />
                </div>
              )}
              {shownFile !== undefined && shownFile.text !== null && !isMarkdown && (
                <div className="flex overflow-auto font-mono text-xs leading-[18px]">
                  <pre className="sticky left-0 shrink-0 border-r bg-muted px-2 py-1 text-right text-muted-foreground select-none">{numbers}</pre>
                  <pre className="px-3 py-1">{shownFile.text}</pre>
                </div>
              )}
            </section>

            {openFile === null && folder === "" && (
              <section className="rounded-md border">
                <div className="flex h-9 items-center gap-1.5 border-b px-4 font-medium">
                  <FileText className="size-4 text-muted-foreground" /> README
                </div>
                <div className="px-6 py-4 max-md:px-3">
                  {overview.readme === "" ? (
                    <span className="text-muted-foreground">No README.</span>
                  ) : (
                    <Markdown text={overview.readme} repo={props.repo} gitRef={overview.default_branch} base="" issueRefs />
                  )}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === "commits" && commits === null && error === "" && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {tab === "commits" && commits !== null && commits.commits.length === 0 && <div className="px-3 py-2 text-muted-foreground">No commits yet.</div>}
        {tab === "commits" &&
          commits !== null &&
          commits.commits.map((commit) => (
            <a key={commit.sha} href={commit.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 border-b px-3 py-1.5 hover:bg-accent/50">
              {commit.checks === "passed" && <CircleCheck className="size-3.5 shrink-0 text-ok" />}
              {commit.checks === "failed" && <CircleX className="size-3.5 shrink-0 text-destructive" />}
              {commit.checks === "running" && <CircleDashed className="size-3.5 shrink-0 text-warn" />}
              {commit.checks === "none" && <span className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{commit.message}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {commit.login ?? commit.name} · {timeAgo(commit.at)}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground max-md:hidden">{commit.sha.slice(0, 7)}</span>
            </a>
          ))}

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
                {canPush && FAILED.includes(run.state) && (
                  <Button
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRerun(run);
                      setRerunOpen(true);
                    }}
                  >
                    Re-run failed jobs
                  </Button>
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
      <NewIssueDialog
        repo={props.repo}
        login={yourRepos.login ?? ""}
        open={newIssueOpen}
        onClose={() => setNewIssueOpen(false)}
        onOpened={() => {
          if (tab === "issues") {
            setReload((count) => count + 1);
          }
        }}
      />
      <AlertDialog open={rerunOpen} onOpenChange={setRerunOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-run the failed jobs of {rerun?.workflow} #{rerun?.number}?</AlertDialogTitle>
            <AlertDialogDescription>GitHub runs its failed jobs again, as you. It uses your repo's GitHub Actions minutes.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={rerunFailed}>Re-run failed jobs</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
