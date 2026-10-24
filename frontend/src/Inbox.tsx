/*
The Inbox: everything the agents want to send (PRs, comments) or ask (questions), waiting for you.

Top: the list (Pending / Decided / All), newest first; only the rows on screen are drawn.
Bottom: the open item (#/inbox/<id>), in tabs. The first two are for you, the last is what would be sent:
- Overview (Overview.tsx): what it is about in plain words (problem, cause, fix, what could go wrong) and the
  agent's before and after, side by side. A question is only this tab.
- Diff (PRs): the unified diff split into files, each folding open with +/- counts and colored lines.
- PR message / Comment: the title and text exactly as they would go to GitHub, to copy when you send it.
The bar at the bottom decides: Reject, Reply & keep working, or Approve, with an optional reply.
Nothing is ever sent to GitHub: a decision only goes to the agent (and the draft's job goes back
to the agent's queue). After a decision on the Pending tab the next pending item opens.
J / K (or the arrow keys) move through the list when you are not typing.
*/

import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronRight, CircleHelp, Copy, Download, ExternalLink, FileCheck, GitPullRequest, Images, Loader2, MessageSquare, Reply, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DRAFT_TONE, JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import Overview from "@/Overview";
import { api, useLive, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

const COLUMNS = "grid grid-cols-[12px_88px_120px_190px_minmax(0,1fr)_44px] items-center gap-2";

const KIND_LABEL: Record<string, string> = { pr: "PR", comment: "Comment", question: "Question" };

const DECISION_LABEL: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected", replied: "Replied" };

// A file in a PR's diff starts collapsed when it changes more lines than this.
const BIG_FILE_LINES = 400;

type DiffLine = { kind: "hunk" | "add" | "del" | "context" | "note"; text: string; oldNo: number | null; newNo: number | null };

type DiffFile = { path: string; oldPath: string; status: "modified" | "added" | "deleted" | "renamed" | "binary"; added: number; removed: number; lines: DiffLine[] };

export default function Inbox(props: { selected: string | null }) {
  const inbox = useLive("inbox");
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const loaded = useLoaded("inbox");
  const [tab, setTab] = useState("pending");
  // Overview, diff or message. Every item opens on its overview.
  const [prTab, setPRTab] = useState("overview");
  // The reply box's text per draft, so switching items keeps what you typed.
  const [replies, setReplies] = useState<Record<string, string>>({});
  // Diff files folded open or shut by hand, by "draft id:path"; others follow BIG_FILE_LINES.
  const [fileOpen, setFileOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  const draft = inbox.find((each) => each.id === props.selected);
  const draftId = draft === undefined ? "" : draft.id;

  useEffect(() => {
    setPRTab("overview");
  }, [draftId]);

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  const counts = {
    pending: inbox.filter((each) => each.status === "pending").length,
    decided: inbox.filter((each) => each.status !== "pending").length,
    all: inbox.length,
  };
  const rows = inbox.filter((each) => {
    if (tab === "pending") {
      return each.status === "pending";
    }
    if (tab === "decided") {
      return each.status !== "pending";
    }
    return true;
  });

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 10,
    getItemKey: (index) => rows[index].id,
  });

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

  async function decide(action: "approve" | "reject" | "reply") {
    if (draft === undefined) {
      return;
    }
    const text = (replies[draft.id] ?? "").trim();
    if (action === "reply" && text === "") {
      toast.error("Write a reply first.");
      return;
    }
    // On the Pending tab the decided item leaves the list; the one after it (or before) opens next.
    const index = rows.findIndex((each) => each.id === draft.id);
    const next = tab === "pending" && index !== -1 ? (rows[index + 1] ?? rows[index - 1]) : undefined;
    setBusy(action);
    try {
      await api(`/api/inbox/${draft.id}/${action}`, { method: "POST", body: { text: text } });
      setReplies((current) => ({ ...current, [draft.id]: "" }));
      if (next !== undefined) {
        window.location.hash = `#/inbox/${next.id}`;
      }
    } catch (err) {
      toast.error(`Could not ${action}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy("");
  }

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("The browser did not allow copying. Select the text and copy it by hand.");
    }
  }

  // J / K move through the list, unless you are typing. Not the arrow keys: they scroll the open item.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']")) {
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
  // A question is only its overview; only PRs have a diff.
  let shownTab = prTab;
  if (draft === undefined || draft.kind === "question" || (shownTab === "diff" && draft.kind !== "pr")) {
    shownTab = "overview";
  }
  const showTabs = draft !== undefined && draft.kind !== "question";

  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="38" minSize={120}>
        <div className="flex h-full flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="pending" className="px-2.5">
                  Pending <span className="text-xs text-muted-foreground tabular-nums">{counts.pending}</span>
                </TabsTrigger>
                <TabsTrigger value="decided" className="px-2.5">
                  Decided <span className="text-xs text-muted-foreground tabular-nums">{counts.decided}</span>
                </TabsTrigger>
                <TabsTrigger value="all" className="px-2.5">
                  All <span className="text-xs text-muted-foreground tabular-nums">{counts.all}</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="ml-auto text-xs text-muted-foreground">Nothing here is sent to GitHub. Decisions go to the agent.</span>
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
                {tab === "pending" ? "Nothing waiting for you. Agents put PRs, comments and questions here." : "Nothing here."}
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
                    className={cn(
                      COLUMNS,
                      "absolute left-0 h-7 w-full border-b px-3 hover:bg-accent/50",
                      each.id === props.selected && "bg-selected hover:bg-selected",
                    )}
                    style={{ top: item.start }}
                  >
                    <StatusDot tone={DRAFT_TONE[each.status]} />
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      {each.kind === "pr" && <GitPullRequest className="size-3.5" />}
                      {each.kind === "comment" && <MessageSquare className="size-3.5" />}
                      {each.kind === "question" && <CircleHelp className="size-3.5" />}
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
        </div>
      </ResizablePanel>

      <ResizableHandle />

      <ResizablePanel defaultSize="62" minSize={160}>
        {props.selected === null && (
          <div className="flex h-full items-center justify-center text-muted-foreground">Pick an item above (J / K to move).</div>
        )}
        {props.selected !== null && draft === undefined && (
          <div className="flex h-full items-center justify-center text-muted-foreground">{loaded ? `There is no draft ${props.selected}.` : "Loading…"}</div>
        )}
        {draft !== undefined && (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="space-y-2 px-4 pt-3 pb-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                  <Badge variant="secondary">
                    {draft.kind === "pr" && <GitPullRequest />}
                    {draft.kind === "comment" && <MessageSquare />}
                    {draft.kind === "question" && <CircleHelp />}
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
                    by{" "}
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

                <h2 className="text-[15px] font-semibold">{draft.title}</h2>

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
                  {draft.kind === "pr" && <div className="text-[15px] font-semibold">{draft.title}</div>}
                  <Markdown text={draft.body || "*No text.*"} repo={draft.repo ?? undefined} githubImagesOnly issueRefs />
                </div>
              )}
              {shownTab === "diff" && files.length === 0 && <div className="px-4 py-3 text-muted-foreground">This draft has no changes.</div>}
              {shownTab === "diff" && diffView}
            </div>

            {draft.status === "pending" && (
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
                  <span className="text-xs text-muted-foreground">Approve sends nothing to GitHub; the agent is told, with your note.</span>
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
                      onClick={() => decide("approve")}
                    >
                      {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {draft.status !== "pending" && (
              <div className="shrink-0 border-t bg-muted/30 px-4 py-2">
                <div className="flex items-center gap-2">
                  <StatusDot tone={DRAFT_TONE[draft.status]} />
                  <span className="font-medium">{DECISION_LABEL[draft.status] ?? draft.status}</span>
                  {draft.decided_at !== null && <span className="text-xs text-muted-foreground">{new Date(draft.decided_at).toLocaleString()}</span>}
                </div>
                {draft.reply !== "" && <div className="mt-1 border-l-2 border-muted-foreground/30 pl-3 whitespace-pre-wrap">{draft.reply}</div>}
              </div>
            )}
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

