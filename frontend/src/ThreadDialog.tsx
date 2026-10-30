/*
The thread pop-up: one of your PRs or issues on GitHub in full, the way GitHub shows it
(#/github/pulls?open=owner/name%23n or #/github/issues?open=...). A click on a row of the GitHub tab opens it; the X,
Esc or a click outside closes it (the address drops open). It is read fresh from GitHub each time it opens
(GET /api/github/thread); Refresh reads it again.
Top: the state (Open, Draft, Merged, Closed), the repo and number (opens it on GitHub), who opened it and when, for a
PR the Inbox sent Its draft and Its job (links to them), the title, a PR's branch, the labels and who it is assigned
to. When an open PR's checks wait for a maintainer, a line says why: GitHub runs nothing for a first-time
contributor's PR until a maintainer approves it, so it only needs waiting. On the right, the Agent setting (only for the PRs
and issues the GitHub tab lists): Off (no drafts; you write your own comments) or Drafts with one of your agents (turning it on
picks the one whose PR or comment went there, else a new agent; change it next to it): when someone else writes there or a PR's checks fail, that agent drafts a reply or a fix, and each draft
waits for your approval in the Inbox. Nothing goes to GitHub without it.
Tabs (an issue has only Conversation):
- Conversation: the description, then everything after it, oldest first: comments (tagged Maintainer or bot),
  reviews (Approved, Requested changes, Commented) with their code comments, each under its file and line with the
  lines it is about, commits, and events as one gray line ("closed this", "added the label bug"). A very long thread
  leaves its earliest items on GitHub (a line says how many). Your own comments have Delete.
- Commits: each commit, who made it and whether its checks passed.
- Checks: the newest commit's checks (passed, failed, running, waiting, skipped), each with its summary and Details
  on GitHub.
- Files changed: the diff per file, folding open, with +/- counts and line numbers (a big file starts folded).
For a PR you opened, the bar has Close PR (open), Reopen PR and Delete branch (closed), Delete branch (merged).
The bottom bar: Leave a comment and Comment, posted as you (needs you signed in: Account on the GitHub tab;
until then a "sign in with GitHub" link to it).
Every button that changes something on GitHub asks "are you sure?" first (Enter confirms), then acts as you.
*/

import {
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleSlash,
  ExternalLink,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, StatusDot, type Tone } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type AgentMode, type GithubAccountStatus } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

// The thread as GET /api/github/thread gives it, fresh from GitHub. role is GitHub's word for the person
// (MEMBER, COLLABORATOR, OWNER, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE).
type ThreadComment = { type: "comment"; id: number; login: string; bot: boolean; role: string; at: string; body: string; url: string; mine: boolean };

type ReviewComment = { path: string; line: number | null; hunk: string; body: string; login: string; at: string; url: string };

type ThreadReview = {
  type: "review";
  login: string;
  bot: boolean;
  role: string;
  at: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  body: string;
  url: string;
  comments: ReviewComment[];
};

type ThreadCommitItem = { type: "commit"; at: string; sha: string; message: string; login: string };

// text in plain words: "closed this as completed", "added the label bug", "merged this into main", ...
type ThreadEvent = { type: "event"; at: string; login: string; text: string };

type TimelineItem = ThreadComment | ThreadReview | ThreadCommitItem | ThreadEvent;

type ThreadCommit = { sha: string; message: string; at: string; login: string; name: string; checks: "passed" | "failed" | "running" | "none" };

// waiting: a GitHub Actions run waiting for a maintainer's approval.
type ThreadCheck = {
  name: string;
  state: "passed" | "failed" | "running" | "waiting" | "skipped" | "cancelled" | "neutral";
  summary: string | null;
  url: string | null;
  app: string;
};

// patch is "" for a binary file or one too big for GitHub to show.
type ThreadFile = {
  path: string;
  old_path: string | null;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
  patch: string;
};

type ThreadDetail = {
  id: string;
  kind: "pr" | "issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  author_bot: boolean;
  role: string;
  state: "open" | "closed" | "merged";
  reason: string | null; // issue closed: completed, not_planned, duplicate
  draft: boolean; // GitHub's draft PR
  body: string;
  created_at: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  timeline: TimelineItem[]; // oldest first
  hidden: number; // earlier timeline items not included
  head: { repo: string; branch: string; sha: string } | null; // PR; null for issues or when the branch is gone
  base: string | null;
  commits: ThreadCommit[]; // PR; [] for issues
  checks: ThreadCheck[]; // PR, the newest commit's
  files: ThreadFile[]; // PR
  you: string | null;
};

type DiffLine = { kind: "hunk" | "add" | "del" | "context" | "note"; text: string; oldNo: number | null; newNo: number | null };

// What a button does, waiting for its "are you sure?": post your own comment, or POST to path (close, reopen, delete
// branch, delete a comment).
type Confirm = { title: string; text: string; label: string; destructive: boolean; action: "comment" | "path"; path: string };

// GitHub's role for someone in the project, in plain words. Other roles get no tag.
const ROLE_LABEL: Record<string, string> = { OWNER: "Maintainer", MEMBER: "Maintainer", COLLABORATOR: "Maintainer" };

const REVIEW_LABEL: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Requested changes",
  commented: "Commented",
  dismissed: "Review dismissed",
};
const REVIEW_COLOR: Record<string, string> = { approved: "text-ok", changes_requested: "text-warn", commented: "", dismissed: "text-muted-foreground" };

const CHECK_LABEL: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  running: "Running",
  waiting: "Waiting for a maintainer to approve it",
  skipped: "Skipped",
  cancelled: "Cancelled",
  neutral: "Neutral",
  none: "No checks",
};
const CHECK_TONE: Record<string, Tone> = {
  passed: "green",
  failed: "red",
  running: "amber",
  waiting: "amber",
  skipped: "gray",
  cancelled: "gray",
  neutral: "gray",
  none: "gray",
};

const NEW_AGENT = "__new__";

// A file in Files changed starts collapsed when it changes more lines than this (like the Inbox's diff).
const BIG_FILE_LINES = 400;

export default function ThreadDialog(props: { id: string | null; onClose: () => void }) {
  const prs = useLive("prs");
  const agents = useLive("agents");
  const inbox = useLive("inbox");
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Goes up to read the thread again (Refresh, and after something changed it).
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState("conversation");
  // Files folded open or shut by hand, by "thread id:path"; others follow BIG_FILE_LINES.
  const [fileOpen, setFileOpen] = useState<Record<string, boolean>>({});
  // Per thread: your own comment being written.
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  // Your GitHub account: who Comment posts as (null until known).
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  // The last button clicked stays set while its "are you sure?" fades out, so the text doesn't blank.
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Another thread opened: nothing shows until its own answer comes. (On close the last one stays while it fades.)
  useEffect(() => {
    if (props.id === null) {
      return;
    }
    setThread(null);
    setError("");
    setTab("conversation");
  }, [props.id]);

  // Read fresh from GitHub each time it opens, and on Refresh. A late answer for a thread no longer open is dropped.
  useEffect(() => {
    if (props.id === null) {
      return;
    }
    let current = true;
    setLoading(true);
    api<ThreadDetail>(`/api/github/thread?id=${encodeURIComponent(props.id)}`)
      .then((result) => {
        if (current) {
          setThread(result);
          setError("");
          setLoading(false);
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
  }, [props.id, reload]);

  // Who the GitHub account is: at first, and again when you sign in or out on the Account page.
  useEffect(() => {
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then(setAccount)
        .catch(() => setAccount({ connected: false }));
    }
    load();
    window.addEventListener("github-account", load);
    return () => window.removeEventListener("github-account", load);
  }, []);

  // Each file's patch split into lines, with their line numbers counted from its @@ hunks. Parsed once per thread.
  const files = useMemo(() => {
    const result: { file: ThreadFile; lines: DiffLine[] }[] = [];
    if (thread === null) {
      return result;
    }
    for (const file of thread.files) {
      const lines: DiffLine[] = [];
      let oldNo = 0;
      let newNo = 0;
      const patch = file.patch === "" ? [] : file.patch.replace(/\n$/, "").split("\n");
      for (const line of patch) {
        if (line.startsWith("@@")) {
          const numbers = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          oldNo = numbers !== null ? Number(numbers[1]) : 0;
          newNo = numbers !== null ? Number(numbers[2]) : 0;
          lines.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
        } else if (line.startsWith("+")) {
          lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo });
          newNo += 1;
        } else if (line.startsWith("-")) {
          lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo, newNo: null });
          oldNo += 1;
        } else if (line.startsWith("\\")) {
          lines.push({ kind: "note", text: line, oldNo: null, newNo: null });
        } else {
          lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo, newNo: newNo });
          oldNo += 1;
          newNo += 1;
        }
      }
      result.push({ file: file, lines: lines });
    }
    return result;
  }, [thread]);

  // The diff's rows, kept as they are while you type a comment (a big PR has thousands of them).
  const filesView = useMemo(
    () => (
      <div>
        {files.map((each) => {
          const file = each.file;
          const key = `${props.id}:${file.path}`;
          const isOpen = fileOpen[key] ?? file.additions + file.deletions <= BIG_FILE_LINES;
          return (
            <div key={key} className="border-b">
              <button
                type="button"
                className="sticky top-0 z-10 flex h-7 w-full items-center gap-2 border-b bg-muted px-3 text-left hover:bg-accent"
                onClick={() => setFileOpen((current) => ({ ...current, [key]: !isOpen }))}
              >
                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                <span className="min-w-0 truncate font-mono text-xs">
                  {file.status === "renamed" && file.old_path !== null ? `${file.old_path} → ${file.path}` : file.path}
                </span>
                {file.status !== "modified" && <Badge variant="secondary">{file.status}</Badge>}
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                  <span className="text-ok">+{file.additions}</span> <span className="text-destructive">−{file.deletions}</span>
                </span>
              </button>
              {isOpen && each.lines.length === 0 && (
                <div className="px-9 py-1.5 text-xs text-muted-foreground">
                  {file.patch === "" ? "Binary or too big to show here; see it on GitHub." : "No line changes (mode or name only)."}
                </div>
              )}
              {isOpen && each.lines.length > 0 && (
                <div className="overflow-x-auto font-mono text-xs leading-5">
                  <div className="w-max min-w-full">
                    {each.lines.map((line, index) => (
                      <div
                        key={index}
                        className={cn(
                          "flex",
                          line.kind === "add" && "bg-ok/12",
                          line.kind === "del" && "bg-destructive/12",
                          line.kind === "hunk" && "bg-muted/60 text-muted-foreground",
                          line.kind === "note" && "text-muted-foreground italic",
                        )}
                      >
                        <span className="w-12 shrink-0 pr-2 text-right text-muted-foreground/70 select-none">{line.oldNo ?? ""}</span>
                        <span className="w-12 shrink-0 pr-2 text-right text-muted-foreground/70 select-none">{line.newNo ?? ""}</span>
                        <span
                          className={cn(
                            "w-5 shrink-0 text-center select-none",
                            line.kind === "add" && "text-ok",
                            line.kind === "del" && "text-destructive",
                          )}
                        >
                          {line.kind === "add" && "+"}
                          {line.kind === "del" && "−"}
                        </span>
                        <span className="pr-4 whitespace-pre">{line.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    ),
    [files, fileOpen, props.id],
  );

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  // The thread in the GitHub tab's live list (its agent setting, whether you opened it); undefined when it isn't there.
  const pr = prs.items.find((each) => each.id === props.id);
  const issue = prs.issues.find((each) => each.id === props.id);
  const tracked = pr ?? issue;
  // The agents Drafts can pick: not archived, and the one set now (even if archived since).
  const choices = agents.filter((each) => each.archived_at === null || (tracked !== undefined && each.id === tracked.agent));
  // Turning Drafts on picks the agent set now, else the one whose PR or comment went there (newest first), while it
  // exists; else a new agent is made.
  let draftsAgent = tracked !== undefined ? tracked.agent : null;
  for (const each of inbox) {
    if (draftsAgent !== null) {
      break;
    }
    if (each.sent !== null && `${each.sent.repo}#${each.sent.number}` === props.id && agentNames[each.agent] !== undefined) {
      draftsAgent = each.agent;
    }
  }

  const comment = props.id !== null ? (comments[props.id] ?? "") : "";
  const connected = account !== null && account.connected;

  // Only a PR has the other tabs.
  let shownTab = tab;
  if (thread === null || thread.kind === "issue") {
    shownTab = "conversation";
  }
  // Close, reopen and delete the branch only on a PR you opened.
  const isMine = thread !== null && thread.kind === "pr" && pr !== undefined && pr.relation === "author";
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const each of files) {
    totalAdded += each.file.additions;
    totalRemoved += each.file.deletions;
  }

  // The state, with GitHub's icon and colors.
  let stateIcon = <GitPullRequest className="text-ok" />;
  let stateLabel = "Open";
  if (thread !== null && thread.kind === "issue") {
    stateIcon = <CircleDot className="text-ok" />;
  }
  if (thread !== null && thread.state === "open" && thread.draft) {
    stateIcon = <GitPullRequestDraft className="text-muted-foreground" />;
    stateLabel = "Draft";
  } else if (thread !== null && thread.state === "merged") {
    stateIcon = <GitMerge className="text-violet-500" />;
    stateLabel = "Merged";
  } else if (thread !== null && thread.state === "closed" && thread.kind === "pr") {
    stateIcon = <GitPullRequestClosed className="text-destructive" />;
    stateLabel = "Closed";
  } else if (thread !== null && thread.state === "closed" && thread.reason === "not_planned") {
    stateIcon = <CircleSlash className="text-muted-foreground" />;
    stateLabel = "Closed as not planned";
  } else if (thread !== null && thread.state === "closed" && thread.reason === "duplicate") {
    stateIcon = <CircleSlash className="text-muted-foreground" />;
    stateLabel = "Closed as duplicate";
  } else if (thread !== null && thread.state === "closed") {
    stateIcon = <CircleCheck className="text-violet-500" />;
    stateLabel = "Closed";
  }

  function ask(next: Confirm) {
    setConfirm(next);
    setConfirmOpen(true);
  }

  // The thread's agent setting: Off, or Drafts with this agent (null: a new one is made).
  async function setAgent(mode: AgentMode, agent: string | null) {
    if (props.id === null) {
      return;
    }
    setBusy("agent");
    try {
      const result = await api<{ mode: AgentMode; agent: string | null }>("/api/github/agent", {
        method: "POST",
        body: { id: props.id, mode: mode, agent: agent },
      });
      if (result.mode === "drafts") {
        toast.success(`Drafts on: ${agentNames[result.agent ?? ""] ?? result.agent ?? "a new agent"} follows it. Its drafts wait for you in the Inbox.`);
      } else {
        toast.success("Drafts off: no agent drafts for it.");
      }
    } catch (err) {
      toast.error(`Could not change the agent: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  // Your own comment, posted as you (after the "are you sure?").
  async function postComment() {
    if (props.id === null) {
      return;
    }
    const target = props.id;
    const body = (comments[target] ?? "").trim();
    if (body === "") {
      return;
    }
    setBusy("comment");
    try {
      const result = await api<{ url: string; id: number }>("/api/github/comment", { method: "POST", body: { target: target, body: body } });
      setComments((current) => ({ ...current, [target]: "" }));
      toast.success(`Comment posted on ${target}`, {
        action: { label: "Open", onClick: () => window.open(result.url, "_blank", "noopener,noreferrer") },
      });
      setReload((count) => count + 1);
    } catch (err) {
      toast.error(`Could not post it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  function askComment() {
    if (comment.trim() === "" || busy !== "" || account === null || !account.connected) {
      return;
    }
    ask({
      title: `Post this comment as @${account.login}?`,
      text: `It is posted on ${props.id}, with the text you wrote. Anyone can see it. You can edit or delete it on GitHub later.`,
      label: "Post comment",
      destructive: false,
      action: "comment",
      path: "",
    });
  }

  async function act() {
    if (confirm === null) {
      return;
    }
    if (confirm.action === "comment") {
      postComment();
      return;
    }
    const title = confirm.title;
    setBusy("act");
    try {
      const result = await api<{ done: string }>(confirm.path, { method: "POST" });
      toast.success(result.done);
      setReload((count) => count + 1);
    } catch (err) {
      toast.error(`${title.replace("?", "")}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  return (
    <Dialog
      open={props.id !== null}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent aria-describedby={undefined} className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {thread === null && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <DialogTitle className="font-normal text-muted-foreground">{error !== "" ? `Could not load ${props.id}: ${error}` : "Loading…"}</DialogTitle>
            {error !== "" && (
              <Button variant="outline" size="sm" onClick={() => setReload((count) => count + 1)}>
                <RefreshCw /> Try again
              </Button>
            )}
          </div>
        )}
        {thread !== null && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* The X sits top right, so nothing goes under it. */}
            <div className="flex shrink-0 gap-4 pt-3 pr-10 pb-2 pl-4">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <Badge variant="secondary">
                    {stateIcon}
                    {stateLabel}
                  </Badge>
                  <a href={thread.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-foreground hover:underline" title="Open on GitHub">
                    {thread.repo} #{thread.number} <ExternalLink className="size-3" />
                  </a>
                  <span title={new Date(thread.created_at).toLocaleString()}>
                    opened {timeAgo(thread.created_at)} by {thread.author === thread.you ? "you" : thread.author}
                  </span>
                  {/* The Inbox draft it was sent from, and its job: they go to that page, which closes the pop-up. */}
                  {pr !== undefined && pr.draft_id !== null && (
                    <a href={`#/inbox/${pr.draft_id}`} className="text-primary hover:underline">
                      Its draft
                    </a>
                  )}
                  {pr !== undefined && pr.job !== null && (
                    <a href={`#/jobs/${pr.job}`} className="text-primary hover:underline">
                      Its job
                    </a>
                  )}
                </div>
                <DialogTitle className="leading-normal">{thread.title}</DialogTitle>
                {(thread.head !== null || thread.labels.length > 0 || thread.assignees.length > 0) && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {thread.head !== null && thread.base !== null && (
                      <span>
                        <span className="font-mono text-foreground">
                          {thread.head.repo}:{thread.head.branch}
                        </span>{" "}
                        into <span className="font-mono text-foreground">{thread.base}</span>
                      </span>
                    )}
                    {thread.labels.map((label) => (
                      <Badge key={label.name} variant="outline">
                        {label.name}
                      </Badge>
                    ))}
                    {thread.assignees.length > 0 && <span>Assigned to {thread.assignees.join(", ")}</span>}
                  </div>
                )}
                {pr !== undefined && pr.state === "open" && pr.checks === "waiting" && (
                  <div className="text-xs text-muted-foreground">
                    GitHub doesn't run a project's checks on a first-time contributor's PR until a maintainer approves them ({pr.waiting_runs}{" "}
                    {pr.waiting_runs === 1 ? "run waits" : "runs wait"}). Nothing is wrong: it waits for a maintainer. Once one of your PRs is merged
                    there, your next ones run right away.
                  </div>
                )}
                {error !== "" && <div className="text-xs text-destructive">Could not refresh: {error}</div>}
              </div>

              {tracked !== undefined && (
                <div className="shrink-0 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Agent</span>
                    <Select
                      value={tracked.agent_mode}
                      disabled={busy !== ""}
                      onValueChange={(value) => setAgent(value as AgentMode, value === "drafts" ? draftsAgent : null)}
                    >
                      <SelectTrigger size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper" align="end">
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="drafts">Drafts</SelectItem>
                      </SelectContent>
                    </Select>
                    {tracked.agent_mode === "drafts" && (
                      <Select
                        value={tracked.agent ?? NEW_AGENT}
                        disabled={busy !== ""}
                        onValueChange={(value) => setAgent("drafts", value === NEW_AGENT ? null : value)}
                      >
                        <SelectTrigger size="sm" className="max-w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="end">
                          <SelectItem value={NEW_AGENT}>New agent</SelectItem>
                          {choices.map((each) => (
                            <SelectItem key={each.id} value={each.id}>
                              <StatusDot tone={AGENT_TONE[each.status]} />
                              {each.name}
                            </SelectItem>
                          ))}
                          {tracked.agent !== null && !choices.some((each) => each.id === tracked.agent) && (
                            <SelectItem value={tracked.agent}>{tracked.agent}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {tracked.agent_mode === "drafts" ? "Drafts wait for your approval in the Inbox." : "No drafts. You write your own comments."}
                  </div>
                </div>
              )}
            </div>

            <div className="flex h-9 shrink-0 items-center gap-2 border-y px-4">
              <Tabs value={shownTab} onValueChange={setTab}>
                <TabsList>
                  <TabsTrigger value="conversation" className="px-2.5">
                    Conversation
                  </TabsTrigger>
                  {thread.kind === "pr" && (
                    <>
                      <TabsTrigger value="commits" className="px-2.5">
                        Commits <span className="text-xs text-muted-foreground tabular-nums">{thread.commits.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="checks" className="px-2.5">
                        Checks <span className="text-xs text-muted-foreground tabular-nums">{thread.checks.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="files" className="px-2.5">
                        Files changed <span className="text-xs text-muted-foreground tabular-nums">{thread.files.length}</span>
                        <span className="font-mono text-xs tabular-nums">
                          <span className="text-ok">+{totalAdded}</span> <span className="text-destructive">−{totalRemoved}</span>
                        </span>
                      </TabsTrigger>
                    </>
                  )}
                </TabsList>
              </Tabs>
              <div className="ml-auto flex items-center gap-1">
                {isMine && thread.state === "open" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() =>
                      ask({
                        title: `Close ${thread.repo} #${thread.number}?`,
                        text: "It closes on GitHub, as you, without merging. Its branch stays, so you can reopen it.",
                        label: "Close PR",
                        destructive: true,
                        action: "path",
                        path: `/api/github/prs/${thread.repo}/${thread.number}/close`,
                      })
                    }
                  >
                    Close PR
                  </Button>
                )}
                {isMine && thread.state === "closed" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() =>
                      ask({
                        title: `Reopen ${thread.repo} #${thread.number}?`,
                        text: "It opens again on GitHub, as you, and the project's people are told.",
                        label: "Reopen PR",
                        destructive: false,
                        action: "path",
                        path: `/api/github/prs/${thread.repo}/${thread.number}/reopen`,
                      })
                    }
                  >
                    Reopen PR
                  </Button>
                )}
                {isMine && thread.state !== "open" && thread.head !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() =>
                      ask({
                        title: `Delete the branch of ${thread.repo} #${thread.number}?`,
                        text: "Its branch is deleted from your fork, for good. The PR stays on GitHub, but it can't be reopened after.",
                        label: "Delete branch",
                        destructive: true,
                        action: "path",
                        path: `/api/github/prs/${thread.repo}/${thread.number}/delete_branch`,
                      })
                    }
                  >
                    Delete branch
                  </Button>
                )}
                <Button variant="ghost" size="sm" disabled={loading} onClick={() => setReload((count) => count + 1)}>
                  {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {shownTab === "conversation" && (
                <div className="space-y-3 px-4 py-3">
                  <div className="rounded-md border bg-muted/30 px-4 py-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{thread.author}</span>
                      {ROLE_LABEL[thread.role] !== undefined && <Badge variant="outline">{ROLE_LABEL[thread.role]}</Badge>}
                      {thread.author_bot && <Badge variant="secondary">bot</Badge>}
                      <span title={new Date(thread.created_at).toLocaleString()}>{timeAgo(thread.created_at)}</span>
                    </div>
                    <Markdown text={thread.body || "*No description.*"} repo={thread.repo} issueRefs />
                  </div>

                  {thread.hidden > 0 && (
                    <a href={thread.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      {thread.hidden} earlier {thread.hidden === 1 ? "item is" : "items are"} on GitHub <ExternalLink className="size-3" />
                    </a>
                  )}

                  {thread.timeline.map((item, index) => {
                    if (item.type === "event") {
                      return (
                        <div key={index} className="flex flex-wrap items-center gap-x-1.5 px-1 text-xs text-muted-foreground">
                          <span className="font-medium">{item.login}</span>
                          <span>{item.text}</span>
                          <span title={new Date(item.at).toLocaleString()}>{timeAgo(item.at)}</span>
                        </div>
                      );
                    }
                    if (item.type === "commit") {
                      return (
                        <div key={index} className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
                          <GitCommitHorizontal className="size-3.5 shrink-0" />
                          <span className="shrink-0 font-mono">{item.sha.slice(0, 7)}</span>
                          <span className="truncate text-foreground">{item.message.split("\n")[0]}</span>
                          <span className="shrink-0">{item.login}</span>
                        </div>
                      );
                    }
                    if (item.type === "comment") {
                      return (
                        <div key={index} className="rounded-md border px-4 py-2">
                          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{item.login}</span>
                            {ROLE_LABEL[item.role] !== undefined && <Badge variant="outline">{ROLE_LABEL[item.role]}</Badge>}
                            {item.bot && <Badge variant="secondary">bot</Badge>}
                            <span title={new Date(item.at).toLocaleString()}>{timeAgo(item.at)}</span>
                            <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open on GitHub">
                              <ExternalLink className="size-3" />
                            </a>
                            {item.mine && (
                              <Button
                                variant="ghost"
                                size="xs"
                                className="ml-auto"
                                disabled={busy !== ""}
                                onClick={() =>
                                  ask({
                                    title: `Delete your comment on ${thread.repo} #${thread.number}?`,
                                    text: "It is deleted from GitHub, for good. People who were notified may still have it in their email.",
                                    label: "Delete comment",
                                    destructive: true,
                                    action: "path",
                                    path: `/api/github/comments/${thread.repo}/${item.id}/delete`,
                                  })
                                }
                              >
                                <Trash2 /> Delete
                              </Button>
                            )}
                          </div>
                          <Markdown text={item.body} repo={thread.repo} issueRefs />
                        </div>
                      );
                    }
                    return (
                      <div key={index} className="rounded-md border px-4 py-2">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{item.login}</span>
                          {ROLE_LABEL[item.role] !== undefined && <Badge variant="outline">{ROLE_LABEL[item.role]}</Badge>}
                          {item.bot && <Badge variant="secondary">bot</Badge>}
                          <span className={cn("font-medium", REVIEW_COLOR[item.state])}>{REVIEW_LABEL[item.state] ?? item.state}</span>
                          <span title={new Date(item.at).toLocaleString()}>{timeAgo(item.at)}</span>
                          <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open on GitHub">
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                        {item.body !== "" && <Markdown text={item.body} repo={thread.repo} className="mt-1" issueRefs />}
                        {item.comments.map((code, codeIndex) => (
                          <div key={codeIndex} className="mt-2 overflow-hidden rounded-md border">
                            <div className="border-b bg-muted px-3 py-1 font-mono text-xs">
                              {code.path}
                              {code.line !== null && `:${code.line}`}
                            </div>
                            {/* Like GitHub: the last lines of the hunk, the ones the comment is about. */}
                            {code.hunk !== "" && (
                              <div className="overflow-x-auto border-b font-mono text-xs leading-5">
                                <div className="w-max min-w-full">
                                  {code.hunk
                                    .split("\n")
                                    .slice(-4)
                                    .map((line, lineIndex) => (
                                      <div
                                        key={lineIndex}
                                        className={cn(
                                          "px-3 whitespace-pre",
                                          line.startsWith("+") && "bg-ok/12",
                                          line.startsWith("-") && "bg-destructive/12",
                                          line.startsWith("@@") && "bg-muted/60 text-muted-foreground",
                                        )}
                                      >
                                        {line}
                                      </div>
                                    ))}
                                </div>
                              </div>
                            )}
                            <div className="px-3 py-2">
                              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">{code.login}</span>
                                <span title={new Date(code.at).toLocaleString()}>{timeAgo(code.at)}</span>
                                <a href={code.url} target="_blank" rel="noreferrer" className="hover:text-foreground" title="Open on GitHub">
                                  <ExternalLink className="size-3" />
                                </a>
                              </div>
                              <Markdown text={code.body} repo={thread.repo} issueRefs />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {shownTab === "commits" && thread.commits.length === 0 && <div className="px-4 py-3 text-muted-foreground">No commits.</div>}
              {shownTab === "commits" &&
                thread.commits.map((commit) => (
                  <div key={commit.sha} className="flex h-7 items-center gap-2 border-b px-4">
                    <span title={CHECK_LABEL[commit.checks] ?? commit.checks}>
                      <StatusDot tone={CHECK_TONE[commit.checks] ?? "gray"} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{commit.message.split("\n")[0]}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{commit.login || commit.name}</span>
                    <a
                      href={`${thread.url}/commits/${commit.sha}`}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                      title="Open on GitHub"
                    >
                      {commit.sha.slice(0, 7)}
                    </a>
                    <span className="w-16 shrink-0 text-right text-xs text-muted-foreground" title={new Date(commit.at).toLocaleString()}>
                      {timeAgo(commit.at)}
                    </span>
                  </div>
                ))}

              {shownTab === "checks" && thread.checks.length === 0 && <div className="px-4 py-3 text-muted-foreground">No checks on the newest commit.</div>}
              {shownTab === "checks" &&
                thread.checks.map((check, index) => (
                  <div key={index} className="flex items-start gap-2 border-b px-4 py-1.5">
                    <StatusDot tone={CHECK_TONE[check.state] ?? "gray"} className="mt-1.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{check.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{check.app}</span>
                        <span className="ml-auto shrink-0 text-xs">{CHECK_LABEL[check.state] ?? check.state}</span>
                        {check.url !== null && check.url !== "" && (
                          <a href={check.url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
                            Details <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                      {check.summary !== null && check.summary !== "" && (
                        <div className="truncate text-xs text-muted-foreground" title={check.summary}>
                          {check.summary}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

              {shownTab === "files" && files.length === 0 && <div className="px-4 py-3 text-muted-foreground">No files changed.</div>}
              {shownTab === "files" && filesView}
            </div>

            <div className="shrink-0 space-y-2 border-t bg-muted/30 px-4 py-2">
              {account !== null && !account.connected && (
                <div className="text-xs text-muted-foreground">
                  To comment here as you,{" "}
                  <a href="#/github/account" className="text-primary hover:underline">
                    sign in with GitHub
                  </a>
                  .
                </div>
              )}
              {connected && (
                <>
                  <Textarea
                    placeholder="Leave a comment. Ctrl+Enter posts it, after you confirm."
                    className="max-h-40 min-h-14 bg-background"
                    value={comment}
                    onChange={(event) => {
                      const target = props.id ?? "";
                      setComments((current) => ({ ...current, [target]: event.target.value }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        askComment();
                      }
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Posted on GitHub as @{account?.login}, after you confirm. Markdown works, like on GitHub.</span>
                    <Button size="sm" className="ml-auto" disabled={busy !== "" || comment.trim() === ""} onClick={askComment}>
                      {busy === "comment" ? <Loader2 className="animate-spin" /> : <Send />} Comment
                    </Button>
                  </div>
                </>
              )}
            </div>

            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
                  <AlertDialogDescription>{confirm?.text}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant={confirm !== null && confirm.destructive ? "destructive" : "default"} onClick={act}>
                    {confirm?.label}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
