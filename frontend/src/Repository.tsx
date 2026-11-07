/*
One of your repositories or a repo you starred, like the repo's page on GitHub: on the GitHub tab
(#/github/repo?repo=owner/name, opened from Your repositories or Starred in its left list, GitHubNav.tsx) and on the
Workspace tab's Home (#/home?repo=owner/name, Home.tsx; base is that address, and every tab and pop-up below keeps
it). Read from GitHub with your sign-in (it may be private) (backend/your_repositories_api.py) and kept on this
computer, which the app reads from GitHub again every 15 minutes (the first open of a repo reads all its tabs). The
browser keeps every answer too (in memory and localStorage, also after a reload), so a tab opened before shows at
once, with no Loading, and the backend's copy replaces it a moment later. A tab never opened shows when it arrives.
Next to Refresh: when the tab you see was read from GitHub ("Updated 3m ago").
Refresh, closing a pop-up, a new issue and a re-run read it from GitHub now. It only reads, except the buttons that say
what they do.
The bar on top: the repo's name (a lock when private; opens it on GitHub), tabs Code, Issues, Pull requests (with
how many are open), Commits and Actions (tab=issues|pulls|commits|actions in the address; none is Code), and on the
right Star or Unstar with how many stars it has (one click, like on GitHub; a repo you unstar leaves Starred at once,
its page stays open until you go), New issue and Refresh. On a narrow screen (a phone) the bar wraps: the tabs go on
a line of their own and scroll sideways.
- Code: the description, stars, forks and website, then the files like on GitHub (shown once the files and the README are
  both in, so nothing jumps): the newest commit on the default
  branch on top (whether its checks passed, who, the message, its id, when; a click opens it on GitHub), where you are
  (the repo's name, then each folder: a click goes back there), then the folder's folders and files, folders first
  (.. goes up). A click on a folder goes into it; a click on a file shows it in the same box: code with line numbers,
  rendered markdown for .md files, or that it is binary or too big, with GitHub (the file there). The README of the
  repo is under the files, at the top folder. Where you are isn't in the address: a reload starts at the top.
- Commits: the newest 50 commits on the default branch, each with whether its checks passed, the message, who and
  when, and its id; a click opens it on GitHub.
- On the Workspace tab (live), Code and Commits have a branch picker on top, like GitHub's: your forks' branches
  first (owner:branch; your forks aren't on Home's list, the repo is), then the repo's own, its default branch first.
  Picking one shows that branch's files, README and commits, read from your fork for its branches. The branch isn't in
  the address: a reload or another repo starts on the default branch.
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

On the Workspace tab's Home (live) the bar has no link to GitHub in its top left: there the first tab is Agents
(RepoAgents.tsx: every agent working with the repo, with how many, New agent, and the open one's chat), where a repo
opens. Code then has tab=code in the address (none is Agents), and Refresh is left out on Agents, which reads nothing
from GitHub. Two more tabs are only there: Development (tab=development, Development.tsx: agents develop the repo all
the time, from its issues to pull requests you merge) after Agents, and Releases (tab=releases, Releases.tsx: plan,
make and follow its releases) after Actions. Both read for themselves, so Refresh is left out on them too.
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
  ChevronDown,
  GitBranch,
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
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import Development from "@/Development";
import NewIssueDialog from "@/NewIssueDialog";
import Releases from "@/Releases";
import RepoAgents from "@/RepoAgents";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLiveValue } from "@/live";
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
  cached_at?: string; // when the kept copy was read from GitHub (every tab's answer has it)
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

type IssueList = { items: RepoIssue[]; open: number; closed: number; cached_at?: string };
type PullList = { items: RepoPull[]; open: number; closed: number; cached_at?: string };
type RunList = { items: RepoRun[]; cached_at?: string };

// The Code tab's files (tree: a folder, blob: a file) and one file (text is null when binary or too big).
// sha: the file's git id, which names its content: the backend keeps files by it.
type RepoFiles = { files: { path: string; type: "blob" | "tree"; size: number; sha: string }[]; truncated: boolean };
type RepoFileText = { path: string; text: string | null; size: number; binary: boolean; too_big: boolean };

// The branch picker's branches: your forks' first (yours), then the repo's own, its default branch first.
type RepoBranch = { repo: string; name: string; at: string | null; default: boolean; yours: boolean };
type BranchList = { branches: RepoBranch[]; cached_at?: string };

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

// Every answer read for a repo's page, by repo, then by what was read ("overview", "issues|closed", "tree", ...): kept
// while the app is open and in localStorage (when it fits), so a page opened before shows at once, also after a
// reload, and the read behind it only brings it up to date.
const kept = new Map<string, Record<string, unknown>>();

export default function Repository(props: { repo: string; tab: string; state: string; open: string | null; base?: string; live?: boolean }) {
  const yourRepos = useLive("your_repos");
  // How many agents work with the repo (the Agents tab's count, worked out the same way as there): only the number, so
  // the page doesn't re-render on every agent update.
  const agentCount = useLiveValue((topics) => {
    const names = [props.repo.toLowerCase()];
    for (const fork of topics.your_repos.repos) {
      if (fork.parent !== null && fork.parent.toLowerCase() === props.repo.toLowerCase()) {
        names.push(fork.name.toLowerCase());
      }
    }
    const patterns = names.map((name) => new RegExp(`(?<![\\w.-])${name.replaceAll(".", "\\.")}(?![\\w.-])`, "i"));
    const vmNames = topics.vms.filter((vm) => vm.notes.some((note) => patterns.some((pattern) => pattern.test(note.text)))).map((vm) => vm.name);
    const jobAgents = topics.jobs.filter((job) => job.repo !== null && names.includes(job.repo.toLowerCase())).map((job) => job.agent);
    return topics.agents.filter(
      (agent) =>
        (agent.repo !== null && names.includes(agent.repo.toLowerCase())) ||
        (agent.project !== null && names.includes(agent.project.toLowerCase())) ||
        jobAgents.includes(agent.id) ||
        (agent.target_vm !== null && vmNames.includes(agent.target_vm)) ||
        (agent.vm !== null && vmNames.includes(agent.vm)),
    ).length;
  });
  // This repo's kept answers: from memory, else from localStorage (after a reload).
  if (!kept.has(props.repo)) {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(localStorage.getItem(`repo-page:${props.repo}`) ?? "{}");
    } catch {
      // Storage blocked or broken: nothing kept yet.
    }
    kept.set(props.repo, saved);
  }
  const keptPage = kept.get(props.repo) ?? {};
  const [overview, setOverview] = useState(() => (keptPage["overview"] as RepoOverview | undefined) ?? null);
  const [commits, setCommits] = useState(() => (keptPage["commits"] as RepoOverview | undefined) ?? null);
  const [files, setFiles] = useState(() => (keptPage["tree"] as RepoFiles | undefined) ?? null);
  const [filesError, setFilesError] = useState("");
  // The Code tab: the folder you are in ("" is the top) and the file shown, if any. Files read stay here.
  const [folder, setFolder] = useState("");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileData, setFileData] = useState<Record<string, RepoFileText>>({});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState(() => (keptPage[`issues|${props.state}`] as IssueList | undefined) ?? null);
  const [pulls, setPulls] = useState(() => (keptPage[`pulls|${props.state}`] as PullList | undefined) ?? null);
  const [runs, setRuns] = useState(() => (keptPage["runs"] as RunList | undefined) ?? null);
  const [branches, setBranches] = useState(() => (keptPage["branches"] as BranchList | undefined) ?? null);
  // The branch on Code and Commits: "" is the repo's default branch, else "owner/name:branch" (the repo itself or your
  // fork of it).
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Goes up to read the tab again from GitHub (Refresh, a closed pop-up, a new issue, a re-run). Each read remembers
  // the last reload it answered, so a read for a new reload asks GitHub (fresh) and one for a tab switch takes the kept
  // copy. Set only once answered, so React's second run of an effect (StrictMode) still asks fresh.
  const [reload, setReload] = useState(0);
  const pageReload = useRef(0);
  const filesReload = useRef(0);
  const branchesReload = useRef(0);
  const [filter, setFilter] = useState("");
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  // The run whose failed jobs Re-run would start again, while its "are you sure?" is open.
  const [rerun, setRerun] = useState<RepoRun | null>(null);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [starring, setStarring] = useState(false);

  // The tab without tab= in the address: Agents on the Workspace tab, else Code.
  const defaultTab = props.live ? "agents" : "code";
  let tab = defaultTab;
  if (TABS.includes(props.tab) || (props.live && ["code", "development", "releases"].includes(props.tab))) {
    tab = props.tab;
  }
  // The tabs that read for themselves: no Refresh, nothing read here.
  const ownTab = tab === "agents" || tab === "development" || tab === "releases";
  const listed = yourRepos.repos.find((each) => each.name === props.repo) ?? yourRepos.starred.find((each) => each.name === props.repo);
  const starred = listed !== undefined && listed.starred;
  const stars = listed?.stars ?? overview?.stars ?? 0;
  const canPush = listed !== undefined && listed.can_push;
  const base = props.base ?? `#/github/repo?repo=${encodeURIComponent(props.repo)}`;
  let listHash = base;
  if (tab !== defaultTab) {
    listHash += `&tab=${tab}`;
  }
  if (props.state === "closed") {
    listHash += "&state=closed";
  }

  // Read the open tab: what was kept shows at once, then the backend's copy (GitHub on Refresh) replaces it. A late
  // answer for another tab is dropped. Only a Refresh turns its button's spinner on.
  useEffect(() => {
    let current = true;
    setError("");
    // Agents reads nothing from GitHub; Development and Releases read for themselves.
    if (ownTab) {
      setLoading(false);
      return;
    }
    let path = tab;
    if (tab === "code") {
      path = "overview";
    } else if (tab === "actions") {
      path = "runs";
    }
    // What it is kept as: Issues and Pull requests for Open and Closed each, Code and Commits for each branch.
    const onBranch = branch !== "" && (tab === "code" || tab === "commits");
    let key = tab === "issues" || tab === "pulls" ? `${path}|${props.state}` : path;
    if (onBranch) {
      key += `@${branch}`;
    }
    function show(result: never) {
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
    }
    if (keptPage[key] !== undefined) {
      show(keptPage[key] as never);
    }
    const fresh = reload !== pageReload.current;
    if (fresh) {
      setLoading(true);
    }
    api<never>(`/api/your_repositories/${props.repo}/${path}?state=${props.state}${fresh ? "&fresh=1" : ""}${onBranch ? `&branch=${encodeURIComponent(branch)}` : ""}`)
      .then((result) => {
        if (!current) {
          return;
        }
        pageReload.current = reload;
        show(result);
        keptPage[key] = result;
        try {
          localStorage.setItem(`repo-page:${props.repo}`, JSON.stringify(keptPage));
        } catch {
          // Storage full or blocked: kept while the app is open.
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
  }, [props.repo, tab, props.state, reload, branch]);

  // The Code tab's files, all in one answer: when the tab opens, and on Refresh.
  useEffect(() => {
    if (tab !== "code") {
      return;
    }
    let current = true;
    setFilesError("");
    const fresh = reload !== filesReload.current;
    api<RepoFiles>(`/api/your_repositories/${props.repo}/tree?fresh=${fresh ? 1 : 0}&branch=${encodeURIComponent(branch)}`)
      .then((result) => {
        if (!current) {
          return;
        }
        filesReload.current = reload;
        setFiles(result);
        keptPage[branch === "" ? "tree" : `tree@${branch}`] = result;
        try {
          localStorage.setItem(`repo-page:${props.repo}`, JSON.stringify(keptPage));
        } catch {
          // Storage full or blocked: kept while the app is open.
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
  }, [props.repo, tab, reload, branch]);

  // The branch picker's branches (the Workspace tab): when Code or Commits opens, and on Refresh.
  useEffect(() => {
    if (!props.live || (tab !== "code" && tab !== "commits")) {
      return;
    }
    let current = true;
    const fresh = reload !== branchesReload.current;
    api<BranchList>(`/api/your_repositories/${props.repo}/branches${fresh ? "?fresh=1" : ""}`)
      .then((result) => {
        if (!current) {
          return;
        }
        branchesReload.current = reload;
        setBranches(result);
        keptPage["branches"] = result;
        try {
          localStorage.setItem(`repo-page:${props.repo}`, JSON.stringify(keptPage));
        } catch {
          // Storage full or blocked: kept while the app is open.
        }
      })
      .catch(() => {
        // The picker keeps what it had; the tab's own read says when GitHub can't be reached.
      });
    return () => {
      current = false;
    };
  }, [props.repo, tab, reload, props.live]);

  // Another branch on Code and Commits: what was kept for it shows at once, else nothing until it is read. The files
  // differ from branch to branch, so the Code tab starts at the top again.
  function pickBranch(value: string) {
    const suffix = value === "" ? "" : `@${value}`;
    setBranch(value);
    setOverview((keptPage[`overview${suffix}`] as RepoOverview | undefined) ?? null);
    setCommits((keptPage[`commits${suffix}`] as RepoOverview | undefined) ?? null);
    setFiles((keptPage[`tree${suffix}`] as RepoFiles | undefined) ?? null);
    setFilesError("");
    setFolder("");
    setOpenFile(null);
    setFileData({});
    setFileErrors({});
  }

  function showFolder(path: string) {
    setFolder(path);
    setOpenFile(null);
  }

  // Shows a file in the files' box; read once, then kept (the backend keeps it by its git id too).
  async function showFile(path: string, sha: string) {
    setOpenFile(path);
    if (fileData[path] !== undefined) {
      return;
    }
    setFileErrors((current) => ({ ...current, [path]: "" }));
    try {
      const data = await api<RepoFileText>(
        `/api/your_repositories/${props.repo}/file?path=${encodeURIComponent(path)}&sha=${sha}&branch=${encodeURIComponent(branch)}`,
      );
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
  // The branch shown: its repo (the repo itself or your fork), its name, and how the picker says it.
  const branchRepo = branch === "" ? props.repo : branch.slice(0, branch.indexOf(":"));
  const branchName = branch === "" ? (overview?.default_branch ?? "") : branch.slice(branch.indexOf(":") + 1);
  let branchLabel = branchName;
  if (branchRepo !== props.repo) {
    branchLabel = `${branchRepo.slice(0, branchRepo.indexOf("/"))}:${branchName}`;
  }
  // The Code tab shows once its README and its files are both in (or the files failed), so nothing jumps.
  const codeReady = overview !== null && (files !== null || filesError !== "");
  // When the tab you see was read from GitHub.
  let shownAt = runs?.cached_at;
  if (tab === "code") {
    shownAt = overview?.cached_at;
  } else if (tab === "commits") {
    shownAt = commits?.cached_at;
  } else if (tab === "issues") {
    shownAt = issues?.cached_at;
  } else if (tab === "pulls") {
    shownAt = pulls?.cached_at;
  } else if (ownTab) {
    shownAt = undefined;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3 max-md:h-auto max-md:flex-wrap max-md:gap-y-1 max-md:py-1">
        {!props.live && (
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
        )}
        <Tabs
          value={tab}
          onValueChange={(value) => (window.location.hash = value === defaultTab ? base : `${base}&tab=${value}`)}
          className="max-md:order-last max-md:w-full max-md:overflow-x-auto"
        >
          <TabsList>
            {props.live && (
              <TabsTrigger value="agents" className="px-2.5">
                Agents <span className="text-xs text-muted-foreground tabular-nums">{agentCount}</span>
              </TabsTrigger>
            )}
            {props.live && (
              <TabsTrigger value="development" className="px-2.5">
                Development
              </TabsTrigger>
            )}
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
            {props.live && (
              <TabsTrigger value="releases" className="px-2.5">
                Releases
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1.5">
          {shownAt !== undefined && <span className="mr-1 text-xs text-muted-foreground max-md:hidden">Updated {timeAgo(shownAt)}</span>}
          <Button size="sm" variant="outline" disabled={starring || yourRepos.login === null} onClick={toggleStar}>
            {starring ? <Loader2 className="animate-spin" /> : <Star className={cn(starred && "fill-current text-warn")} />}
            {starred ? "Unstar" : "Star"}
            <span className="text-xs text-muted-foreground tabular-nums">{stars}</span>
          </Button>
          <Button size="sm" variant="outline" disabled={yourRepos.login === null} onClick={() => setNewIssueOpen(true)}>
            <Plus /> New issue
          </Button>
          {!ownTab && (
            <Button size="sm" variant="outline" disabled={loading} onClick={() => setReload((count) => count + 1)}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
            </Button>
          )}
        </div>
      </div>

      {(tab === "issues" || tab === "pulls") && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
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
            className="w-52 max-md:w-auto max-md:min-w-0 max-md:flex-1"
            placeholder={tab === "pulls" ? "Filter pull requests" : "Filter issues"}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
      )}

      {props.live && (tab === "code" || tab === "commits") && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="min-w-0">
                <GitBranch /> <span className="truncate">{branchLabel !== "" ? branchLabel : "Branch"}</span> <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
              {branches === null && <DropdownMenuLabel className="text-muted-foreground">Loading…</DropdownMenuLabel>}
              {branches !== null &&
                branches.branches.map((each, index) => {
                  // The repo's own default branch is "": the page without a branch.
                  const value = each.repo === props.repo && each.default ? "" : `${each.repo}:${each.name}`;
                  return (
                    <Fragment key={`${each.repo}:${each.name}`}>
                      {(index === 0 || branches.branches[index - 1].repo !== each.repo) && (
                        <DropdownMenuLabel className="text-xs text-muted-foreground">{each.yours ? `Your fork: ${each.repo}` : each.repo}</DropdownMenuLabel>
                      )}
                      <DropdownMenuItem onSelect={() => pickBranch(value)}>
                        <span className={cn("min-w-0 truncate", value === branch && "font-semibold")}>{each.name}</span>
                        {each.default && !each.yours && (
                          <Badge variant="outline" className="py-0">
                            default
                          </Badge>
                        )}
                        {each.at !== null && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{timeAgo(each.at)}</span>}
                      </DropdownMenuItem>
                    </Fragment>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {error !== "" && <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read it from GitHub: {error}</div>}

      <div className={tab === "agents" ? "min-h-0 flex-1" : "min-h-0 flex-1 overflow-auto"}>
        {tab === "agents" && (
          <div className="h-full">
            <RepoAgents repo={props.repo} />
          </div>
        )}
        {tab === "development" && <Development repo={props.repo} />}
        {tab === "releases" && <Releases repo={props.repo} />}
        {tab === "code" && codeReady && overview !== null && (
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
                      href={`https://github.com/${branchRepo}/blob/${branchName}/${openFile}`}
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
                    onClick={() => (entry.type === "tree" ? showFolder(entry.path) : showFile(entry.path, entry.sha))}
                  >
                    {entry.type === "tree" && <Folder className="size-4 shrink-0 text-primary" />}
                    {entry.type === "blob" && /\.(md|markdown|mdx)$/i.test(entry.path) && <FileText className="size-4 shrink-0 text-muted-foreground" />}
                    {entry.type === "blob" && !/\.(md|markdown|mdx)$/i.test(entry.path) && <File className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{entry.path.slice(entry.path.lastIndexOf("/") + 1)}</span>
                    {entry.type === "blob" && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{SIZE.format(entry.size)}B</span>}
                  </button>
                ))}

              {openFile !== null && shownError !== "" && <div className="px-3 py-2 text-destructive">Could not read it: {shownError}</div>}
              {shownFile !== undefined && shownFile.binary && <div className="px-3 py-2 text-muted-foreground">Binary file, {SIZE.format(shownFile.size)}B.</div>}
              {shownFile !== undefined && shownFile.too_big && (
                <div className="px-3 py-2 text-muted-foreground">Too big to show here ({SIZE.format(shownFile.size)}B). Open it on GitHub.</div>
              )}
              {shownFile !== undefined && shownFile.text !== null && isMarkdown && (
                <div className="px-6 py-4 max-md:px-3">
                  <Markdown text={shownFile.text} repo={branchRepo} gitRef={branchName} base={folder} />
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
                    <Markdown text={overview.readme} repo={branchRepo} gitRef={branchName} base="" issueRefs />
                  )}
                </div>
              </section>
            )}
          </div>
        )}

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
