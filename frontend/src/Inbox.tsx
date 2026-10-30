/*
The Inbox: everything the agents want to send (PRs, comments) or ask (questions), waiting for you. And one
kind the app makes itself, Taken: an issue an agent has a job for isn't free anymore (someone else is on it
now, github_searcher/agents.py issue_taken); you pick Keep working or Stop the agent (its job is cancelled).

The page is the list, every item in one list, newest first; only the rows on screen are drawn. Pending ones are in
bold, decided ones grayed out; they still open like any other.
A click on a row opens that item in a pop-up (#/inbox/<id>); the X, Esc or a click outside it closes it, back to the
list (what you typed in its reply box stays). The pop-up shows the item in tabs. The first two are for you, the last
is what would be sent:
- Overview (Overview.tsx): what it is about in plain words (problem, cause, fix, what could go wrong) and the
  agent's before and after, side by side. A question is only this tab.
- Diff (PRs): the unified diff split into files, each folding open with +/- counts and colored lines.
- PR message / Comment: the title and text exactly as they go to GitHub, with Copy for sending by hand. Above a PR's,
  the commits it goes out as: the branch's commits from the VM, all the agent's own and all with your name (it may
  not use anyone else's commits, and nothing credits a co-author). What it didn't commit goes in one more commit,
  titled like the PR. A PR's
  before and after pictures are in its text as ![...](evidence:ev_...): shown here in place, and listed above it with
  Copy picture and Download, since GitHub needs its own copy (sending uploads them to your fork; by hand, paste
  each over its line in GitHub's PR box).
The bar at the bottom of the pop-up decides: Reject, Reply & keep working, or Approve, with an optional reply (Taken:
Stop the agent or Keep working, with an optional note).
A decision goes to the agent (and the draft's job goes back to the agent's queue).
With your GitHub account connected (the GitHub page, Account), Approve on a PR or comment first asks "are you sure?" (Open PR / Post
comment), then sends it to GitHub as you (github_searcher/github_account.py): a PR from a new branch in your fork,
its pictures uploaded there. If GitHub refuses, nothing is decided and the error shows. Without an account nothing is
sent; you send it yourself. A sent item's bar links to it on GitHub. One approved but not sent (approved before you
connected) has Send to GitHub, with the same question; while no account is connected, its bar says in amber it isn't on
GitHub yet, with a link to the GitHub page's Account tab to connect one. The bar says who Approve sends as.
A decided item's bar says what you decided, and has a box to message its agent about it: the message goes into the
agent's chat (its page, #/agents/<id>, which Open chat opens), saying which item it is about. An archived agent comes
back for it; a deleted one can't get messages.
After a decision the next pending item opens in the pop-up (the one after it in the list, or else before).
J / K move through the list when you are not typing, also while the pop-up is open (it shows the next item); the
arrow keys scroll the pop-up.
Delete: a decided item's bar has Delete, and many are picked like in a mail app (components/ui/row-selection.tsx):
Ctrl-click, Shift-click, dragging a rectangle, Ctrl+A; the bar at the bottom of the list then deletes them at once. It
asks first (Enter confirms), and it is for good. Only decided items can be deleted: a pending one waits for your
decision, since its agent waits for the answer. Their agents aren't told, and what was sent to GitHub stays there (a
comment you posted can still be deleted from its pop-up on the GitHub page).
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronRight, CircleHelp, Copy, Download, ExternalLink, FileCheck, GitCommitHorizontal, GitPullRequest, Images, Loader2, MessageSquare, Reply, Send, Square, Trash2, UserX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { RowSelection } from "@/components/ui/row-selection";
import { DRAFT_TONE, JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import Overview from "@/Overview";
import { api, useLive, useLoaded, type Draft, type GithubAccountStatus } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[12px_88px_120px_190px_minmax(0,1fr)_44px] items-center gap-2";

const KIND_LABEL: Record<string, string> = { pr: "PR", comment: "Comment", question: "Question", taken: "Taken" };

const DECISION_LABEL: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", replied: "Replied" };
// A Taken notice is decided with Keep working (approved) or Stop the agent (rejected).
const TAKEN_LABEL: Record<string, string> = { pending: "Pending", approved: "Kept working", rejected: "Stopped the agent" };

// A file in a PR's diff starts collapsed when it changes more lines than this.
const BIG_FILE_LINES = 400;

type DiffLine = { kind: "hunk" | "add" | "del" | "context" | "note"; text: string; oldNo: number | null; newNo: number | null };

type DiffFile = { path: string; oldPath: string; status: "modified" | "added" | "deleted" | "renamed" | "binary"; added: number; removed: number; lines: DiffLine[] };

export default function Inbox(props: { selected: string | null }) {
  const inbox = useLive("inbox");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const loaded = useLoaded("inbox");
  // Overview, diff or message. Every item opens on its overview.
  const [prTab, setPRTab] = useState("overview");
  // The reply box's text per draft (or the message to its agent, once decided), so switching items keeps what you typed.
  const [replies, setReplies] = useState<Record<string, string>>({});
  // Diff files folded open or shut by hand, by "draft id:path"; others follow BIG_FILE_LINES.
  const [fileOpen, setFileOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  // Your GitHub account (the GitHub page): who Approve sends PRs and comments as (null until known).
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  // The "are you sure?" before sending: for Approve, or for Send to GitHub on an approved item.
  const [confirming, setConfirming] = useState<"" | "approve" | "send">("");
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  // Picked items, the last one clicked (where a shift-click range starts), and the decided ones Delete waits to
  // delete after its "are you sure?" (pending: how many picked ones stay, since they wait for a decision).
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ ids: string[]; pending: number } | null>(null);

  const draft = inbox.find((each) => each.id === props.selected);
  const draftId = draft === undefined ? "" : draft.id;

  useEffect(() => {
    setPRTab("overview");
  }, [draftId]);

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  const pendingCount = inbox.filter((each) => each.status === "pending").length;
  const rows = inbox;

  // Only items still in the list shown count as picked (another tab may have deleted some).
  const rowIds = rows.map((each) => each.id);
  const chosen = selected.filter((id) => rowIds.includes(id));
  const chosenDecided = rows.filter((each) => chosen.includes(each.id) && each.status !== "pending").map((each) => each.id);

  // A ctrl-click picks or unpicks one row; a shift-click does the same to every row from the last one clicked.
  function select(id: string, shift: boolean) {
    const on = !chosen.includes(id);
    let range = [id];
    if (shift && anchor !== null && rowIds.includes(anchor)) {
      const from = rowIds.indexOf(anchor);
      const to = rowIds.indexOf(id);
      range = rowIds.slice(Math.min(from, to), Math.max(from, to) + 1);
    }
    setSelected(on ? [...chosen.filter((each) => !range.includes(each)), ...range] : chosen.filter((each) => !range.includes(each)));
    setAnchor(id);
  }

  // Deletes the decided ones; when the open item goes, the one after it (or before) opens.
  async function remove(ids: string[]) {
    try {
      const result = await api<{ deleted: string[] }>("/api/inbox/delete", { method: "POST", body: { ids: ids } });
      const deleted = result.deleted;
      setSelected((current) => current.filter((id) => !deleted.includes(id)));
      if (props.selected !== null && deleted.includes(props.selected)) {
        const index = rowIds.indexOf(props.selected);
        const after = rows.slice(index + 1).filter((each) => !deleted.includes(each.id));
        const before = rows.slice(0, Math.max(index, 0)).filter((each) => !deleted.includes(each.id));
        const next = after[0] ?? before[before.length - 1];
        window.location.hash = next !== undefined ? `#/inbox/${next.id}` : "#/inbox";
      }
      toast.success(deleted.length === 1 ? "Deleted 1 item" : `Deleted ${deleted.length} items`);
    } catch (err) {
      toast.error(`Could not delete: ${err instanceof Error ? err.message : err}`);
    }
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (index) => rows[index].id,
  });

  // Who the GitHub account is: at first, and again when the GitHub page connects or disconnects one.
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

  // Ages ("5m", "2h") stay current.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // The PR's diff, split into files. Parsed once per diff, not on every keystroke.
  const diffText = draft !== undefined && draft.kind === "pr" ? draft.diff : "";
  const files = useMemo(() => {
    const result: DiffFile[] = [];
    let file: DiffFile | null = null;
    let inHunk = false;
    let oldNo = 0;
    let newNo = 0;
    for (const line of diffText.replace(/\n$/, "").split("\n")) {
      // "diff --git a/x b/y" starts a file. Its name may be corrected below by "+++ b/..." or "rename to".
      if (line.startsWith("diff --git ")) {
        const names = line.match(/^diff --git a\/(.*) b\/(.*)$/);
        file = {
          path: names !== null ? names[2] : line.slice(11),
          oldPath: names !== null ? names[1] : "",
          status: "modified",
          added: 0,
          removed: 0,
          lines: [],
        };
        result.push(file);
        inHunk = false;
        continue;
      }
      if (file === null) {
        continue;
      }
      if (line.startsWith("@@")) {
        const numbers = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        oldNo = numbers !== null ? Number(numbers[1]) : 0;
        newNo = numbers !== null ? Number(numbers[2]) : 0;
        inHunk = true;
        file.lines.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
        continue;
      }
      // The file's header lines, before its first hunk.
      if (!inHunk) {
        if (line.startsWith("new file mode")) {
          file.status = "added";
        } else if (line.startsWith("deleted file mode")) {
          file.status = "deleted";
        } else if (line.startsWith("rename from ")) {
          file.status = "renamed";
          file.oldPath = line.slice(12);
        } else if (line.startsWith("rename to ")) {
          file.path = line.slice(10);
        } else if (line.startsWith("Binary files ")) {
          file.status = "binary";
        } else if (line.startsWith("+++ b/")) {
          file.path = line.slice(6);
        } else if (line.startsWith("--- a/")) {
          file.oldPath = line.slice(6);
        }
        continue;
      }
      if (line.startsWith("+")) {
        file.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo });
        newNo += 1;
        file.added += 1;
      } else if (line.startsWith("-")) {
        file.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo, newNo: null });
        oldNo += 1;
        file.removed += 1;
      } else if (line.startsWith("\\")) {
        file.lines.push({ kind: "note", text: line, oldNo: null, newNo: null });
      } else {
        file.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo, newNo: newNo });
        oldNo += 1;
        newNo += 1;
      }
    }
    return result;
  }, [diffText]);

  let totalAdded = 0;
  let totalRemoved = 0;
  for (const file of files) {
    totalAdded += file.added;
    totalRemoved += file.removed;
  }

  // The diff's rows, kept as they are while you type a reply (a big diff has thousands of them).
  const diffView = useMemo(
    () => (
      <div>
        {files.map((file) => {
          const key = `${draftId}:${file.path}`;
          const isOpen = fileOpen[key] ?? file.added + file.removed <= BIG_FILE_LINES;
          return (
            <div key={key} className="border-b">
              <button
                type="button"
                className="sticky top-0 z-10 flex h-7 w-full items-center gap-2 border-b bg-muted px-3 text-left hover:bg-accent"
                onClick={() => setFileOpen((current) => ({ ...current, [key]: !isOpen }))}
              >
                <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                <span className="min-w-0 truncate font-mono text-xs">
                  {file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                {file.status !== "modified" && (
                  <Badge variant="secondary">
                    {file.status}
                  </Badge>
                )}
                <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
                  <span className="text-ok">+{file.added}</span> <span className="text-destructive">−{file.removed}</span>
                </span>
              </button>
              {isOpen && file.lines.length === 0 && (
                <div className="px-9 py-1.5 text-xs text-muted-foreground">
                  {file.status === "binary" ? "Binary file, not shown." : "No line changes (mode or name only)."}
                </div>
              )}
              {isOpen && file.lines.length > 0 && (
                <div className="overflow-x-auto font-mono text-xs leading-5">
                  <div className="w-max min-w-full">
                    {file.lines.map((line, index) => (
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
    [files, fileOpen, draftId],
  );

  // send: Approve also sends the PR or comment to GitHub as you, first (after the "are you sure?").
  async function decide(action: "approve" | "reject" | "reply", send = false) {
    if (draft === undefined) {
      return;
    }
    const text = (replies[draft.id] ?? "").trim();
    if (action === "reply" && text === "") {
      toast.error("Write a reply first.");
      return;
    }
    // The decided item stays in the list, grayed out; the next pending one after it (or before) opens.
    const index = rows.findIndex((each) => each.id === draft.id);
    const after = rows.slice(index + 1).filter((each) => each.status === "pending");
    const before = rows.slice(0, Math.max(index, 0)).filter((each) => each.status === "pending");
    const next = after[0] ?? before[before.length - 1];
    setBusy(send ? "send" : action);
    try {
      const result = await api<Draft>(`/api/inbox/${draft.id}/${action}`, { method: "POST", body: { text: text, send: send } });
      setReplies((current) => ({ ...current, [draft.id]: "" }));
      const sent = result.sent;
      if (send && sent !== null) {
        toast.success(sent.kind === "pr" ? `PR opened: ${sent.repo}#${sent.number}` : `Comment posted on ${sent.repo}#${sent.number}`, {
          action: { label: "Open", onClick: () => window.open(sent.url, "_blank", "noopener,noreferrer") },
        });
      }
      if (next !== undefined) {
        window.location.hash = `#/inbox/${next.id}`;
      }
    } catch (err) {
      toast.error(`Could not ${send ? "send it" : action}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  // A message to a decided item's agent, in its chat, saying which item it is about.
  async function messageAgent() {
    if (draft === undefined) {
      return;
    }
    const text = (replies[draft.id] ?? "").trim();
    if (text === "") {
      return;
    }
    const agentId = draft.agent;
    setBusy("message");
    try {
      await api(`/api/agents/${agentId}/message`, { method: "POST", body: { text: `About ${draft.id} (${draft.title}) in the Inbox:\n${text}` } });
      setReplies((current) => ({ ...current, [draft.id]: "" }));
      toast.success(`Sent to ${agentNames[agentId] ?? agentId}`, {
        action: {
          label: "Open chat",
          onClick: () => {
            window.location.hash = `#/agents/${agentId}`;
          },
        },
      });
    } catch (err) {
      toast.error(`Could not send it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  // An approved PR or comment that isn't on GitHub yet (approved before your account was connected).
  async function sendApproved() {
    if (draft === undefined) {
      return;
    }
    setBusy("send");
    try {
      const result = await api<Draft>(`/api/inbox/${draft.id}/send`, { method: "POST" });
      const sent = result.sent;
      if (sent !== null) {
        toast.success(sent.kind === "pr" ? `PR opened: ${sent.repo}#${sent.number}` : `Comment posted on ${sent.repo}#${sent.number}`, {
          action: { label: "Open", onClick: () => window.open(sent.url, "_blank", "noopener,noreferrer") },
        });
      }
    } catch (err) {
      toast.error(`Could not send it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  // A picture to the clipboard, as PNG (what browsers can copy), to paste over its line in GitHub's PR box.
  async function copyPicture(file: string) {
    try {
      const blob = await (await fetch(`/api/evidence/${file}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (png === null) {
        throw new Error("no picture");
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      toast.success("Picture copied. Paste it over its line in GitHub's PR box.");
    } catch {
      toast.error("The browser did not allow copying the picture. Download it and drag it in instead.");
    }
  }

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("The browser did not allow copying. Select the text and copy it by hand.");
    }
  }

  // J / K move through the list, unless you are typing, also in the open item's pop-up. Not the arrow keys: they scroll it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
        return;
      }
      // Nor in another pop-up: the "are you sure?" before sending is about the item open under it.
      const popup = target.closest("[role='dialog'], [role='alertdialog']");
      if (popup !== null && !popup.hasAttribute("data-inbox-item")) {
        return;
      }
      let step = 0;
      if (event.key === "j") {
        step = 1;
      } else if (event.key === "k") {
        step = -1;
      }
      if (step === 0 || rows.length === 0) {
        return;
      }
      event.preventDefault();
      const index = rows.findIndex((each) => each.id === props.selected);
      const nextIndex = index === -1 ? 0 : Math.min(Math.max(index + step, 0), rows.length - 1);
      virtualizer.scrollToIndex(nextIndex);
      window.location.hash = `#/inbox/${rows[nextIndex].id}`;
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const job = draft !== undefined && draft.job !== null ? jobs.find((each) => each.id === draft.job) : undefined;
  // "owner/name#12" → its GitHub page (GitHub sends /issues/12 on to /pull/12 when it is a PR).
  const targetMatch = draft !== undefined && draft.target !== null ? draft.target.match(/^(.+)#(\d+)$/) : null;
  const targetUrl = targetMatch !== null ? `https://github.com/${targetMatch[1]}/issues/${targetMatch[2]}` : null;
  const reply = draft !== undefined ? (replies[draft.id] ?? "") : "";
  // A question and a Taken notice are only their overview; only PRs have a diff.
  let shownTab = prTab;
  if (draft === undefined || draft.kind === "question" || draft.kind === "taken" || (shownTab === "diff" && draft.kind !== "pr")) {
    shownTab = "overview";
  }
  const showTabs = draft !== undefined && draft.kind !== "question" && draft.kind !== "taken";
  // The pictures a PR's text shows (![...](evidence:ev_...)): here they load from this app.
  const pictures = draft !== undefined ? draft.evidence.filter((item) => item.file !== null && draft.body.includes(`evidence:${item.id}`)) : [];
  let shownBody = draft !== undefined ? draft.body : "";
  for (const item of pictures) {
    shownBody = shownBody.replaceAll(`evidence:${item.id}`, `${window.location.origin}/api/evidence/${item.file}`);
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs text-muted-foreground tabular-nums">{pendingCount} pending</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {account !== null && account.connected
            ? `Approved PRs and comments go to GitHub as @${account.login}. Decisions go to the agent.`
            : "Nothing here is sent to GitHub. Decisions go to the agent."}
        </span>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>Kind</span>
        <span>Agent</span>
        <span>Target</span>
        <span>Title</span>
        <span className="text-right">Age</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && rows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            Nothing here yet. Agents put PRs, comments and questions here, and the app asks when someone else takes an issue an agent works on.
          </div>
        )}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const each = rows[item.index];
            const minutes = Math.max(0, Math.floor((now - Date.parse(each.created_at)) / 60000));
            let age = `${Math.floor(minutes / 1440)}d`;
            if (minutes < 1) {
              age = "now";
            } else if (minutes < 60) {
              age = `${minutes}m`;
            } else if (minutes < 1440) {
              age = `${Math.floor(minutes / 60)}h`;
            }
            return (
              <a
                key={item.key}
                href={`#/inbox/${each.id}`}
                data-select-id={each.id}
                className={cn(
                  COLUMNS,
                  "absolute left-0 h-7 w-full border-b px-3 hover:bg-accent/50",
                  each.status !== "pending" && "text-muted-foreground",
                  (each.id === props.selected || chosen.includes(each.id)) && "bg-selected hover:bg-selected",
                )}
                style={{ top: item.start }}
                onClick={(event) => {
                  // Not a new tab or window: these pick the row.
                  if (event.ctrlKey || event.metaKey || event.shiftKey) {
                    event.preventDefault();
                    select(each.id, event.shiftKey);
                  }
                }}
              >
                <StatusDot tone={DRAFT_TONE[each.status]} />
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {each.kind === "pr" && <GitPullRequest className="size-3.5" />}
                  {each.kind === "comment" && <MessageSquare className="size-3.5" />}
                  {each.kind === "question" && <CircleHelp className="size-3.5" />}
                  {each.kind === "taken" && <UserX className="size-3.5" />}
                  {KIND_LABEL[each.kind] ?? each.kind}
                </span>
                <span className="truncate">{agentNames[each.agent] ?? each.agent}</span>
                <span className="truncate text-muted-foreground">{each.target ?? each.repo ?? "–"}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate", each.status === "pending" && "font-medium")}>{each.title}</span>
                  {each.evidence.length > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums" title={`${each.evidence.length} in Before and after`}>
                      <Images className="size-3.5" />
                      {each.evidence.length}
                    </span>
                  )}
                </span>
                <span className="text-right text-xs text-muted-foreground tabular-nums">{age}</span>
              </a>
            );
          })}
        </div>
      </div>

      <RowSelection listRef={scrollRef} ids={rowIds} selected={chosen} onSelect={setSelected}>
        <Button
          size="xs"
          variant="ghost"
          disabled={chosenDecided.length === 0}
          title={chosenDecided.length === 0 ? "Pending items can't be deleted: decide them first." : undefined}
          onClick={() => setDeleting({ ids: chosenDecided, pending: chosen.length - chosenDecided.length })}
        >
          <Trash2 /> Delete
        </Button>
      </RowSelection>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting !== null && deleting.ids.length === 1 ? "Delete this item?" : `Delete ${deleting !== null ? deleting.ids.length : 0} items?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting !== null && deleting.ids.length === 1
                ? "It is gone from the Inbox for good, with your decision and note. Its agent isn't told, and what was sent to GitHub stays there."
                : "They are gone from the Inbox for good, with your decisions and notes. Their agents aren't told, and what was sent to GitHub stays there."}
              {deleting !== null && deleting.pending > 0 && ` ${deleting.pending} pending ${deleting.pending === 1 ? "one stays" : "ones stay"}: decide ${deleting.pending === 1 ? "it" : "them"} first.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting !== null) {
                  remove(deleting.ids);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={props.selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            window.location.hash = "#/inbox";
          }
        }}
      >
        <DialogContent data-inbox-item aria-describedby={undefined} className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          {draft === undefined && (
            <div className="flex flex-1 items-center justify-center">
              <DialogTitle className="font-normal text-muted-foreground">{loaded ? `There is no draft ${props.selected}.` : "Loading…"}</DialogTitle>
            </div>
          )}
          {draft !== undefined && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="space-y-2 pt-3 pr-10 pb-2 pl-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                    <Badge variant="secondary">
                      {draft.kind === "pr" && <GitPullRequest />}
                      {draft.kind === "comment" && <MessageSquare />}
                      {draft.kind === "question" && <CircleHelp />}
                      {draft.kind === "taken" && <UserX />}
                      {KIND_LABEL[draft.kind] ?? draft.kind}
                    </Badge>
                    {draft.target !== null && targetUrl !== null && (
                      <a href={targetUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-foreground hover:underline">
                        {draft.target} <ExternalLink className="size-3" />
                      </a>
                    )}
                    {draft.target !== null && targetUrl === null && <span className="text-foreground">{draft.target}</span>}
                    {draft.target === null && draft.repo !== null && (
                      <a href={`https://github.com/${draft.repo}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-foreground hover:underline">
                        {draft.repo} <ExternalLink className="size-3" />
                      </a>
                    )}
                    <span>
                      {draft.kind === "taken" ? "agent" : "by"}{" "}
                      <a href={`#/agents/${draft.agent}`} className="text-primary hover:underline">
                        {agentNames[draft.agent] ?? draft.agent}
                      </a>
                    </span>
                    {draft.job !== null && (
                      <span className="flex min-w-0 items-center gap-1.5" title={job?.title}>
                        <StatusDot tone={job !== undefined ? JOB_TONE[job.status] : "gray"} />
                        <span className="font-mono text-xs">{draft.job}</span>
                        {job !== undefined && <span className="max-w-80 truncate">{job.title}</span>}
                        {job !== undefined && <span className="text-xs">({JOB_LABEL[job.status] ?? job.status})</span>}
                      </span>
                    )}
                    {draft.vm !== null && (
                      <a href={`#/vms/${draft.vm}`} className="text-primary hover:underline">
                        {draft.vm}
                      </a>
                    )}
                    <span className="text-xs">{new Date(draft.created_at).toLocaleString()}</span>
                  </div>

                  <DialogTitle className="leading-normal">{draft.title}</DialogTitle>

                  {draft.kind === "pr" && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        <span className="font-mono text-foreground">{draft.branch || "?"}</span> into{" "}
                        <span className="font-mono text-foreground">{draft.base || "?"}</span>
                      </span>
                      {draft.path !== null && draft.path !== "" && <span className="font-mono">{draft.path}</span>}
                    </div>
                  )}
                </div>

                {showTabs && (
                  <div className="flex h-9 items-center gap-2 border-y px-4">
                    <Tabs value={shownTab} onValueChange={setPRTab}>
                      <TabsList>
                        <TabsTrigger value="overview" className="px-2.5">
                          Overview
                        </TabsTrigger>
                        {draft.kind === "pr" && (
                          <TabsTrigger value="diff" className="px-2.5">
                            Diff
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {files.length} {files.length === 1 ? "file" : "files"}
                            </span>
                            <span className="font-mono text-xs tabular-nums">
                              <span className="text-ok">+{totalAdded}</span> <span className="text-destructive">−{totalRemoved}</span>
                            </span>
                          </TabsTrigger>
                        )}
                        <TabsTrigger value="message" className="px-2.5">
                          {draft.kind === "pr" ? "PR message" : "Comment"}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                    {shownTab === "diff" && (
                      <div className="ml-auto flex items-center gap-1">
                        <Button variant="ghost" size="sm" disabled={draft.diff === ""} onClick={() => copyText(draft.diff, "Diff")}>
                          <Copy /> Copy diff
                        </Button>
                        {draft.diff === "" ? (
                          <Button variant="ghost" size="sm" disabled>
                            <Download /> Download .patch
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" asChild>
                            <a href={`/api/inbox/${draft.id}/patch`} download={`${draft.id}.patch`}>
                              <Download /> Download .patch
                            </a>
                          </Button>
                        )}
                      </div>
                    )}
                    {shownTab === "message" && (
                      <div className="ml-auto flex items-center gap-1">
                        {draft.kind === "pr" && (
                          <Button variant="ghost" size="sm" onClick={() => copyText(draft.title, "Title")}>
                            <Copy /> Copy title
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" disabled={draft.body === ""} onClick={() => copyText(draft.body, "Text")}>
                          <Copy /> Copy text
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {shownTab === "overview" && <Overview draft={draft} files={files.length} added={totalAdded} removed={totalRemoved} />}
                {shownTab === "message" && (
                  <div className="space-y-3 px-4 py-3">
                    {draft.kind === "pr" && draft.template !== null && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <FileCheck className="size-3.5 text-ok" /> Follows the project's PR template <span className="font-mono">{draft.template}</span>
                      </div>
                    )}
                    {pictures.length > 0 && (
                      <div className="space-y-2 rounded-md border bg-muted/30 p-2.5">
                        <div className="text-xs text-muted-foreground">
                          GitHub needs its own copy of these pictures.{" "}
                          {account !== null && account.connected && "Sending uploads them to your fork and links them in the text. By hand: "}
                          In the PR box on GitHub, select each{" "}
                          <code className="font-mono">![…](evidence:…)</code> and paste its picture over it, or drag the downloaded file there.
                        </div>
                        <div className="flex flex-wrap gap-3">
                          {pictures.map((item) => (
                            <div key={item.id} className="w-48 space-y-1">
                              <img src={`/api/evidence/${item.file}`} alt={item.caption} className="h-28 w-full rounded border bg-black object-contain" />
                              <div className="truncate text-xs" title={item.caption}>
                                <span className="font-mono">{item.id}</span> · {item.stage}
                              </div>
                              <div className="flex items-center gap-1">
                                {item.file !== null && !item.file.endsWith(".gif") && (
                                  <Button variant="ghost" size="xs" onClick={() => copyPicture(item.file ?? "")}>
                                    <Copy /> Copy picture
                                  </Button>
                                )}
                                <Button variant="ghost" size="xs" asChild>
                                  <a href={`/api/evidence/${item.file}`} download={item.file}>
                                    <Download /> Download
                                  </a>
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {draft.kind === "pr" && (
                      <div className="space-y-0.5 text-xs text-muted-foreground">
                        {draft.commits.length === 0 && <div>Goes out as one commit, with the title as its message.</div>}
                        {draft.commits.length > 0 && <div>Goes out as these commits from the agent's branch, with your name:</div>}
                        {draft.commits.map((commit) => (
                          <div key={commit.sha} className="flex min-w-0 items-center gap-1.5">
                            <GitCommitHorizontal className="size-3.5 shrink-0" />
                            <span className="truncate text-foreground">{commit.message.split("\n")[0]}</span>
                            {!commit.own && <span className="shrink-0 text-destructive">by {commit.author.name}: can't be sent</span>}
                          </div>
                        ))}
                      </div>
                    )}
                    {draft.kind === "pr" && <div className="text-[15px] font-semibold">{draft.title}</div>}
                    <Markdown text={shownBody || "*No text.*"} repo={draft.repo ?? undefined} githubImagesOnly issueRefs />
                  </div>
                )}
                {shownTab === "diff" && files.length === 0 && <div className="px-4 py-3 text-muted-foreground">This draft has no changes.</div>}
                {shownTab === "diff" && diffView}
              </div>

              {draft.status === "pending" && draft.kind === "taken" && (
                <div className="shrink-0 space-y-2 border-t bg-muted/30 px-4 py-2">
                  <Textarea
                    placeholder="A note for the agent (optional)."
                    className="max-h-40 min-h-14 bg-background"
                    value={reply}
                    onChange={(event) => setReplies((current) => ({ ...current, [draft.id]: event.target.value }))}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Stop cancels the job, and the agent stops working on it right away.</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => decide("reject")}>
                        {busy === "reject" ? <Loader2 className="animate-spin" /> : <Square />} Stop the agent
                      </Button>
                      <Button size="sm" disabled={busy !== ""} onClick={() => decide("approve")}>
                        {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Keep working
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {draft.status === "pending" && draft.kind !== "taken" && (
                <div className="shrink-0 space-y-2 border-t bg-muted/30 px-4 py-2">
                  <Textarea
                    placeholder={
                      draft.kind === "question"
                        ? "Your answer. Ctrl+Enter sends it as a reply."
                        : "A note for the agent (optional for Approve and Reject; needed for Reply). Ctrl+Enter replies."
                    }
                    className="max-h-40 min-h-14 bg-background"
                    value={reply}
                    onChange={(event) => setReplies((current) => ({ ...current, [draft.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        decide("reply");
                      }
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {draft.kind !== "question" && account !== null && account.connected
                        ? `Approve ${draft.kind === "pr" ? "opens this PR" : "posts this comment"} on GitHub as @${account.login}, after you confirm; the agent is told, with your note.`
                        : "Approve sends nothing to GitHub; the agent is told, with your note."}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => decide("reject")}>
                        {busy === "reject" ? <Loader2 className="animate-spin" /> : <X />} Reject
                      </Button>
                      <Button
                        variant={draft.kind === "question" ? "default" : "outline"}
                        size="sm"
                        disabled={busy !== "" || reply.trim() === ""}
                        onClick={() => decide("reply")}
                      >
                        {busy === "reply" ? <Loader2 className="animate-spin" /> : <Reply />} Reply & keep working
                      </Button>
                      <Button
                        variant={draft.kind === "question" ? "outline" : "default"}
                        size="sm"
                        disabled={busy !== ""}
                        onClick={() => {
                          if (draft.kind !== "question" && account !== null && account.connected) {
                            setConfirming("approve");
                          } else {
                            decide("approve");
                          }
                        }}
                      >
                        {busy === "approve" || busy === "send" ? <Loader2 className="animate-spin" /> : <Check />}
                        {busy === "send" ? "Sending…" : "Approve"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {draft.status !== "pending" && (
                <div className="shrink-0 border-t bg-muted/30 px-4 py-2">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={DRAFT_TONE[draft.status]} />
                    <span className="font-medium">{(draft.kind === "taken" ? TAKEN_LABEL[draft.status] : DECISION_LABEL[draft.status]) ?? draft.status}</span>
                    {draft.decided_at !== null && <span className="text-xs text-muted-foreground">{new Date(draft.decided_at).toLocaleString()}</span>}
                    {draft.sent !== null && (
                      <a href={draft.sent.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                        {draft.sent.kind === "pr" ? `PR #${draft.sent.number}` : "Comment"} on GitHub, as @{draft.sent.as} <ExternalLink className="size-3" />
                      </a>
                    )}
                    {draft.status === "approved" && draft.sent === null && (draft.kind === "pr" || draft.kind === "comment") && account !== null && !account.connected && (
                      <span className="text-xs text-warn">
                        Not on GitHub yet:{" "}
                        <a href="#/github?tab=account" className="underline hover:text-foreground">
                          connect your GitHub account
                        </a>{" "}
                        to send it from here.
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button variant="ghost" size="sm" disabled={busy !== ""} onClick={() => setDeleting({ ids: [draft.id], pending: 0 })}>
                        <Trash2 /> Delete
                      </Button>
                      {draft.status === "approved" && draft.sent === null && (draft.kind === "pr" || draft.kind === "comment") && account !== null && account.connected && (
                        <Button size="sm" disabled={busy !== ""} onClick={() => setConfirming("send")}>
                          {busy === "send" ? <Loader2 className="animate-spin" /> : <Send />}
                          {busy === "send" ? "Sending…" : "Send to GitHub"}
                        </Button>
                      )}
                    </div>
                  </div>
                  {draft.reply !== "" && <div className="mt-1 border-l-2 border-muted-foreground/30 pl-3 whitespace-pre-wrap">{draft.reply}</div>}
                  <Textarea
                    placeholder={
                      draft.agent in agentNames
                        ? `A message to ${agentNames[draft.agent]} about this, in its chat. Ctrl+Enter sends it.`
                        : "Its agent was deleted, so it can't get messages."
                    }
                    className="mt-2 max-h-40 min-h-14 bg-background"
                    disabled={!(draft.agent in agentNames)}
                    value={reply}
                    onChange={(event) => setReplies((current) => ({ ...current, [draft.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        messageAgent();
                      }
                    }}
                  />
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    <Button variant="ghost" size="sm" asChild>
                      <a href={`#/agents/${draft.agent}`}>
                        <MessageSquare /> Open chat
                      </a>
                    </Button>
                    <Button size="sm" disabled={busy !== "" || reply.trim() === "" || !(draft.agent in agentNames)} onClick={() => messageAgent()}>
                      {busy === "message" ? <Loader2 className="animate-spin" /> : <Send />} Send to agent
                    </Button>
                  </div>
                </div>
              )}

              <AlertDialog
                open={confirming !== ""}
                onOpenChange={(open) => {
                  if (!open) {
                    setConfirming("");
                  }
                }}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{draft.kind === "pr" ? `Open this PR on ${draft.repo}?` : `Post this comment on ${draft.target}?`}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {draft.kind === "pr"
                        ? `It opens as @${account?.login}, from a new branch in your fork, with the title, text and diff shown here. Anyone can see it. You can close it on GitHub later, but not delete it.`
                        : `It is posted as @${account?.login}, with the text shown here. Anyone can see it. You can edit or delete it on GitHub later.`}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        if (confirming === "approve") {
                          decide("approve", true);
                        } else {
                          sendApproved();
                        }
                      }}
                    >
                      {draft.kind === "pr" ? "Open PR" : "Post comment"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

