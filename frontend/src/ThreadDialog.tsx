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
The bottom bar shows what waits in the Inbox for this PR or issue. A comment draft: who drafted it, its text (you can
change it; your change is saved before you decide), a note for the agent, and Reject, Discuss (the note goes to the
agent's chat, the draft keeps waiting), Redraft (the agent drafts it again with your note) and Approve (with your
GitHub account connected it asks "Post this comment as @you?" and posts it; without, nothing is sent, like the
Inbox). A PR draft (a new PR, or new commits for this one) is one line with Review, which opens it in the Inbox.
With no comment draft: Leave a comment and Comment, posted as you (needs you signed in: Account on the GitHub tab;
until then a "sign in with GitHub" link to it).
In one of your repositories (Your repositories in the left list, Repository.tsx; read with your sign-in, as it
may be private) you also do what a maintainer does: next to the labels, Labels (tick or untick one of the repo's
labels), Assign yourself or Unassign yourself, and Edit (the title and description, then Save or Cancel); in the bar,
Close issue (as completed or as not planned), Reopen, Merge (Create a merge commit, Squash and merge, Rebase and merge)
and Close PR; on Checks, Re-run failed jobs for each failed GitHub Actions run of the newest commit; and on someone
else's open PR, Request changes and Approve next to Comment, with what you wrote as the review's text (Approve needs
none).
Every button that changes something on GitHub asks "are you sure?" first (Enter confirms), then acts as you.
*/

import {
  Check,
  ChevronDown,
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
  MessageSquare,
  MessagesSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Tag,
  Trash2,
  UserMinus,
  UserPlus,
  X,
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
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_TONE, StatusDot, type Tone } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type AgentMode, type Draft, type GithubAccountStatus } from "@/live";
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
  yours: boolean; // in one of your repositories: the maintainer's buttons
  repo_labels: { name: string; color: string }[]; // yours: every label the repo has
  failed_runs: { id: number; name: string; url: string }[]; // yours, a PR: the newest commit's failed Actions runs
};

type DiffLine = { kind: "hunk" | "add" | "del" | "context" | "note"; text: string; oldNo: number | null; newNo: number | null };

// What a button does, waiting for its "are you sure?": approve the comment draft and post it, post your own
// comment, or POST body to path (close, reopen, delete branch, delete a comment, and in your repositories every
// maintainer's button; edit and review also end editing and empty the comment box).
type Confirm = {
  title: string;
  text: string;
  label: string;
  destructive: boolean;
  action: "approve" | "comment" | "path" | "edit" | "review";
  path: string;
  body?: unknown;
};

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
  // Per draft: its text as you changed it, and your note for its agent. Per thread: your own comment being written.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  // Your GitHub account: who Approve and Comment post as (null until known).
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  // The last button clicked stays set while its "are you sure?" fades out, so the text doesn't blank.
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Edit (in your repositories): the title and description being changed.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  // Another thread opened: nothing shows until its own answer comes. (On close the last one stays while it fades.)
  useEffect(() => {
    if (props.id === null) {
      return;
    }
    setThread(null);
    setError("");
    setTab("conversation");
    setEditing(false);
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

  // The drafts waiting in the Inbox for this thread: a comment draft is decided here, the others are one line each.
  const pending = props.id === null ? [] : inbox.filter((each) => each.status === "pending" && (each.target === props.id || each.update_of === props.id));
  const commentDraft = pending.find((each) => each.kind === "comment");
  const otherDrafts = pending.filter((each) => each !== commentDraft);
  const draftText = commentDraft !== undefined ? (edits[commentDraft.id] ?? commentDraft.body) : "";
  const note = commentDraft !== undefined ? (notes[commentDraft.id] ?? "") : "";
  const comment = props.id !== null ? (comments[props.id] ?? "") : "";
  const connected = account !== null && account.connected;

  // Only a PR has the other tabs.
  let shownTab = tab;
  if (thread === null || thread.kind === "issue") {
    shownTab = "conversation";
  }
  // Close, reopen and delete the branch only on a PR you opened.
  const isMine = thread !== null && thread.kind === "pr" && pr !== undefined && pr.relation === "author";
  // In one of your repositories, signed in: the maintainer's buttons. They all go to the same address.
  const maintain = thread !== null && thread.yours && connected;
  const actPath = "/api/your_repositories/act";
  const assignedToYou = thread !== null && thread.you !== null && thread.assignees.includes(thread.you);
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

  // Decides the comment draft, like the Inbox does; your change to its text is saved first.
  // send: Approve also posts it on GitHub as you (after the "are you sure?").
  async function decide(draft: Draft, action: "approve" | "reject" | "reply", send: boolean) {
    const text = (notes[draft.id] ?? "").trim();
    if (action === "reply" && text === "") {
      toast.error("Write a note first: what the new version should change.");
      return;
    }
    const edited = edits[draft.id];
    setBusy(send ? "send" : action);
    try {
      if (edited !== undefined && edited !== draft.body) {
        await api<Draft>(`/api/inbox/${draft.id}/edit`, { method: "POST", body: { title: draft.title, body: edited } });
      }
      const result = await api<Draft>(`/api/inbox/${draft.id}/${action}`, { method: "POST", body: { text: text, send: send } });
      setNotes((current) => ({ ...current, [draft.id]: "" }));
      const sent = result.sent;
      if (send && sent !== null) {
        toast.success(`Comment posted on ${sent.repo}#${sent.number}`, {
          action: { label: "Open", onClick: () => window.open(sent.url, "_blank", "noopener,noreferrer") },
        });
        setReload((count) => count + 1);
      }
      if (action === "reply") {
        toast.success("The agent drafts it again with your note. The new draft shows here.");
      }
    } catch (err) {
      toast.error(`Could not ${send ? "post it" : action === "reply" ? "redraft" : action}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  // Discuss: the note goes to the agent's chat, saying which draft it is about; the draft keeps waiting.
  async function discuss(draft: Draft) {
    const text = (notes[draft.id] ?? "").trim();
    if (text === "") {
      return;
    }
    const edited = edits[draft.id];
    setBusy("discuss");
    try {
      if (edited !== undefined && edited !== draft.body) {
        await api<Draft>(`/api/inbox/${draft.id}/edit`, { method: "POST", body: { title: draft.title, body: edited } });
      }
      await api(`/api/agents/${draft.agent}/message`, {
        method: "POST",
        body: { text: `About ${draft.id} (${draft.title}) in the Inbox, still waiting for your decision:\n${text}` },
      });
      setNotes((current) => ({ ...current, [draft.id]: "" }));
      toast.success(`Sent to ${agentNames[draft.agent] ?? draft.agent}`, {
        action: {
          label: "Open chat",
          onClick: () => {
            window.location.hash = `#/agents/${draft.agent}`;
          },
        },
      });
    } catch (err) {
      toast.error(`Could not send it: ${err instanceof Error ? err.message : err}`);
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
    if (confirm.action === "approve") {
      if (commentDraft !== undefined) {
        decide(commentDraft, "approve", true);
      }
      return;
    }
    if (confirm.action === "comment") {
      postComment();
      return;
    }
    const title = confirm.title;
    const action = confirm.action;
    const target = props.id ?? "";
    setBusy("act");
    try {
      const result = await api<{ done: string }>(confirm.path, { method: "POST", body: confirm.body });
      toast.success(result.done);
      if (action === "edit") {
        setEditing(false);
      }
      if (action === "review") {
        setComments((current) => ({ ...current, [target]: "" }));
      }
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
            <div className="flex shrink-0 gap-4 pt-3 pr-10 pb-2 pl-4 max-md:flex-col max-md:gap-2">
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
                {editing && (
                  <div className="space-y-1.5">
                    <Input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
                    <Textarea className="max-h-72 min-h-32" value={editBody} onChange={(event) => setEditBody(event.target.value)} />
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        disabled={editTitle.trim() === "" || busy !== ""}
                        onClick={() =>
                          ask({
                            title: `Save your changes to ${thread.repo} #${thread.number}?`,
                            text: "Its title and description change on GitHub, as you. Everyone who can see it sees the new ones.",
                            label: "Save",
                            destructive: false,
                            action: "edit",
                            path: actPath,
                            body: { repo: thread.repo, action: "edit", number: thread.number, kind: thread.kind, fields: { title: editTitle, body: editBody } },
                          })
                        }
                      >
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {(thread.head !== null || thread.labels.length > 0 || thread.assignees.length > 0 || maintain) && (
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
                    {maintain && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="xs" disabled={busy !== ""}>
                            <Tag /> Labels
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                          {thread.repo_labels.length === 0 && <DropdownMenuItem disabled>This repo has no labels</DropdownMenuItem>}
                          {thread.repo_labels.map((label) => {
                            const on = thread.labels.some((each) => each.name === label.name);
                            return (
                              <DropdownMenuCheckboxItem
                                key={label.name}
                                checked={on}
                                onSelect={() =>
                                  ask({
                                    title: on ? `Remove the label ${label.name}?` : `Add the label ${label.name}?`,
                                    text: `It is ${on ? "taken off" : "put on"} ${thread.repo} #${thread.number} on GitHub, as you.`,
                                    label: on ? "Remove label" : "Add label",
                                    destructive: false,
                                    action: "path",
                                    path: actPath,
                                    body: { repo: thread.repo, action: on ? "remove_label" : "add_label", number: thread.number, kind: thread.kind, fields: { label: label.name } },
                                  })
                                }
                              >
                                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                                {label.name}
                              </DropdownMenuCheckboxItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    {maintain && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy !== ""}
                        onClick={() =>
                          ask({
                            title: assignedToYou ? `Unassign yourself from ${thread.repo} #${thread.number}?` : `Assign yourself to ${thread.repo} #${thread.number}?`,
                            text: assignedToYou ? "GitHub no longer shows you as assigned to it." : "GitHub shows you as assigned to it.",
                            label: assignedToYou ? "Unassign yourself" : "Assign yourself",
                            destructive: false,
                            action: "path",
                            path: actPath,
                            body: { repo: thread.repo, action: assignedToYou ? "unassign_me" : "assign_me", number: thread.number, kind: thread.kind },
                          })
                        }
                      >
                        {assignedToYou ? <UserMinus /> : <UserPlus />}
                        {assignedToYou ? "Unassign yourself" : "Assign yourself"}
                      </Button>
                    )}
                    {maintain && !editing && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setEditTitle(thread.title);
                          setEditBody(thread.body);
                          setEditing(true);
                        }}
                      >
                        <Pencil /> Edit
                      </Button>
                    )}
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

            <div className="flex h-9 shrink-0 items-center gap-2 border-y px-4 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
              <Tabs value={shownTab} onValueChange={setTab} className="max-w-full overflow-x-auto">
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
                {maintain && thread.kind === "issue" && thread.state === "open" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" disabled={busy !== ""}>
                        Close issue <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() =>
                          ask({
                            title: `Close ${thread.repo} #${thread.number} as completed?`,
                            text: "It closes on GitHub, as you, as done. You can reopen it later.",
                            label: "Close issue",
                            destructive: false,
                            action: "path",
                            path: actPath,
                            body: { repo: thread.repo, action: "close", number: thread.number, kind: "issue", fields: { reason: "completed" } },
                          })
                        }
                      >
                        <CircleCheck /> Close as completed
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          ask({
                            title: `Close ${thread.repo} #${thread.number} as not planned?`,
                            text: "It closes on GitHub, as you, as something that won't be done. You can reopen it later.",
                            label: "Close issue",
                            destructive: false,
                            action: "path",
                            path: actPath,
                            body: { repo: thread.repo, action: "close", number: thread.number, kind: "issue", fields: { reason: "not_planned" } },
                          })
                        }
                      >
                        <CircleSlash /> Close as not planned
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {maintain && thread.state === "closed" && !isMine && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() =>
                      ask({
                        title: `Reopen ${thread.repo} #${thread.number}?`,
                        text: "It opens again on GitHub, as you.",
                        label: "Reopen",
                        destructive: false,
                        action: "path",
                        path: actPath,
                        body: { repo: thread.repo, action: "reopen", number: thread.number, kind: thread.kind },
                      })
                    }
                  >
                    Reopen
                  </Button>
                )}
                {maintain && thread.kind === "pr" && thread.state === "open" && !isMine && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== ""}
                    onClick={() =>
                      ask({
                        title: `Close ${thread.repo} #${thread.number}?`,
                        text: "It closes on GitHub, as you, without merging. You can reopen it later.",
                        label: "Close PR",
                        destructive: true,
                        action: "path",
                        path: actPath,
                        body: { repo: thread.repo, action: "close", number: thread.number, kind: "pr" },
                      })
                    }
                  >
                    Close PR
                  </Button>
                )}
                {maintain && thread.kind === "pr" && thread.state === "open" && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" disabled={busy !== "" || thread.draft} title={thread.draft ? "A draft PR can't be merged until it is marked ready for review" : undefined}>
                        <GitMerge /> Merge <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {[
                        { method: "merge", label: "Create a merge commit", text: `Its commits go into ${thread.base ?? "the base branch"} as they are, with a merge commit.` },
                        { method: "squash", label: "Squash and merge", text: `Its commits become one commit on ${thread.base ?? "the base branch"}.` },
                        { method: "rebase", label: "Rebase and merge", text: `Its commits go on top of ${thread.base ?? "the base branch"}, one by one.` },
                      ].map((each) => (
                        <DropdownMenuItem
                          key={each.method}
                          onSelect={() =>
                            ask({
                              title: `Merge ${thread.repo} #${thread.number}?`,
                              text: `${each.text} It is merged on GitHub, as you, and can't be undone from here.`,
                              label: each.label,
                              destructive: false,
                              action: "path",
                              path: actPath,
                              body: { repo: thread.repo, action: "merge", number: thread.number, kind: "pr", fields: { method: each.method } },
                            })
                          }
                        >
                          {each.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
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

              {shownTab === "checks" && maintain && thread.failed_runs.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5">
                  {thread.failed_runs.map((run) => (
                    <Button
                      key={run.id}
                      variant="outline"
                      size="xs"
                      disabled={busy !== ""}
                      onClick={() =>
                        ask({
                          title: `Re-run the failed jobs of ${run.name}?`,
                          text: "GitHub runs its failed jobs again, as you. It uses your repo's GitHub Actions minutes.",
                          label: "Re-run failed jobs",
                          destructive: false,
                          action: "path",
                          path: actPath,
                          body: { repo: thread.repo, action: "rerun_failed", fields: { run_id: run.id } },
                        })
                      }
                    >
                      <RotateCcw /> Re-run failed jobs: {run.name}
                    </Button>
                  ))}
                </div>
              )}
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
              {otherDrafts.map((each) => (
                <div key={each.id} className="flex min-w-0 items-center gap-2">
                  {each.kind === "pr" ? (
                    <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {each.kind === "pr" && each.update_of !== null && each.rebase_of !== null && "Rebase of this PR"}
                    {each.kind === "pr" && each.update_of !== null && each.rebase_of === null && "New commits for this PR"}
                    {each.kind === "pr" && each.update_of === null && "PR draft"}
                    {each.kind !== "pr" && "Draft reply"} by {agentNames[each.agent] ?? each.agent}, waiting in the Inbox:
                  </span>
                  <span className="min-w-0 truncate">{each.title}</span>
                  <Button variant="outline" size="sm" className="ml-auto" asChild>
                    <a href={`#/inbox/${each.id}`}>Review</a>
                  </Button>
                </div>
              ))}

              {commentDraft !== undefined && (
                <>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <MessageSquare className="size-3.5 shrink-0" />
                    <span>
                      Draft reply by{" "}
                      <a href={`#/agents/${commentDraft.agent}`} className="text-primary hover:underline">
                        {agentNames[commentDraft.agent] ?? commentDraft.agent}
                      </a>
                      , waiting for your decision.
                      {commentDraft.edited && " Edited by you."}
                    </span>
                    <a href={`#/inbox/${commentDraft.id}`} className="ml-auto text-primary hover:underline">
                      Open in the Inbox
                    </a>
                  </div>
                  <Textarea
                    className="max-h-60 min-h-20 bg-background"
                    value={draftText}
                    onChange={(event) => setEdits((current) => ({ ...current, [commentDraft.id]: event.target.value }))}
                  />
                  <Textarea
                    placeholder="A note for the agent (optional for Approve and Reject; needed for Discuss and Redraft)."
                    className="max-h-32 min-h-10 bg-background"
                    value={note}
                    onChange={(event) => setNotes((current) => ({ ...current, [commentDraft.id]: event.target.value }))}
                  />
                  <div className="flex items-center gap-2 max-md:flex-wrap">
                    <span className="text-xs text-muted-foreground">
                      {connected
                        ? `Approve posts it on GitHub as @${account?.login}, after you confirm; the agent is told, with your note.`
                        : "Approve sends nothing to GitHub; the agent is told, with your note."}
                    </span>
                    <div className="ml-auto flex shrink-0 items-center gap-1.5 max-md:shrink max-md:flex-wrap max-md:justify-end">
                      <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => decide(commentDraft, "reject", false)}>
                        {busy === "reject" ? <Loader2 className="animate-spin" /> : <X />} Reject
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy !== "" || note.trim() === "" || !(commentDraft.agent in agentNames)}
                        onClick={() => discuss(commentDraft)}
                      >
                        {busy === "discuss" ? <Loader2 className="animate-spin" /> : <MessagesSquare />} Discuss
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy !== "" || note.trim() === ""} onClick={() => decide(commentDraft, "reply", false)}>
                        {busy === "reply" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Redraft
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy !== "" || draftText.trim() === ""}
                        onClick={() => {
                          if (account !== null && account.connected) {
                            ask({
                              title: `Post this comment as @${account.login}?`,
                              text: `It is posted on ${props.id}, with the text shown here. Anyone can see it. You can edit or delete it on GitHub later.`,
                              label: "Post comment",
                              destructive: false,
                              action: "approve",
                              path: "",
                            });
                          } else {
                            decide(commentDraft, "approve", false);
                          }
                        }}
                      >
                        {busy === "approve" || busy === "send" ? <Loader2 className="animate-spin" /> : <Check />}
                        {busy === "send" ? "Posting…" : "Approve"}
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {commentDraft === undefined && account !== null && !account.connected && (
                <div className="text-xs text-muted-foreground">
                  To comment here as you,{" "}
                  <a href="#/github/account" className="text-primary hover:underline">
                    sign in with GitHub
                  </a>
                  .
                </div>
              )}
              {commentDraft === undefined && connected && (
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
                  <div className="flex items-center gap-2 max-md:flex-wrap">
                    <span className="text-xs text-muted-foreground">Posted on GitHub as @{account?.login}, after you confirm. Markdown works, like on GitHub.</span>
                    <Button size="sm" className="ml-auto" disabled={busy !== "" || comment.trim() === ""} onClick={askComment}>
                      {busy === "comment" ? <Loader2 className="animate-spin" /> : <Send />} Comment
                    </Button>
                    {maintain && thread.kind === "pr" && thread.state === "open" && thread.author !== thread.you && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== "" || comment.trim() === ""}
                          onClick={() =>
                            ask({
                              title: `Ask for changes on ${thread.repo} #${thread.number} as @${account?.login}?`,
                              text: "Your review, with the text you wrote, goes on the PR on GitHub. Its author is asked to change it before it is merged.",
                              label: "Request changes",
                              destructive: false,
                              action: "review",
                              path: actPath,
                              body: { repo: thread.repo, action: "review", number: thread.number, kind: "pr", fields: { event: "REQUEST_CHANGES", body: comment } },
                            })
                          }
                        >
                          Request changes
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== ""}
                          onClick={() =>
                            ask({
                              title: `Approve ${thread.repo} #${thread.number} as @${account?.login}?`,
                              text:
                                comment.trim() === ""
                                  ? "Your approval goes on the PR on GitHub. Everyone who can see the repo can see it."
                                  : "Your approval, with the text you wrote, goes on the PR on GitHub. Everyone who can see the repo can see it.",
                              label: "Approve",
                              destructive: false,
                              action: "review",
                              path: actPath,
                              body: { repo: thread.repo, action: "review", number: thread.number, kind: "pr", fields: { event: "APPROVE", body: comment } },
                            })
                          }
                        >
                          <Check /> Approve
                        </Button>
                      </>
                    )}
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
