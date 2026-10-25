/*
One tracked issue in full, in a pop-up (a click on an issue in the Tracked page's open repo): the app's tags and why,
when it was opened and last updated, then the issue's text and its comments below it. The text and comments come
fresh from GitHub each time it opens (the same thread the Issues page's open row shows: /api/issues/thread), so new
comments show. GitHub's thread gives the first 40 comments; past that a line says how many more are on GitHub.
*/

import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { api, type Thread, type TrackedIssue } from "@/live";
import { timeAgo } from "@/lib/utils";

// The level's soft color, like LeetCode's green / amber / red (the same as the Issues page's).
const LEVEL_VARIANT: Record<string, "ok" | "warn" | "bad"> = { easy: "ok", medium: "warn", hard: "bad" };

export default function IssueDetailsDialog(props: { repo: string; issue: TrackedIssue | null; onClose: () => void }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState("");
  const issue = props.issue;
  const id = issue !== null ? `${props.repo}#${issue.number}` : "";

  // Fetched again each time another issue opens. A late answer for an issue closed meanwhile is dropped.
  useEffect(() => {
    if (id === "") {
      return;
    }
    let current = true;
    setThread(null);
    setError("");
    api<Thread>(`/api/issues/thread?id=${encodeURIComponent(id)}`)
      .then((result) => {
        if (current) {
          setThread(result);
        }
      })
      .catch((err) => {
        if (current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      current = false;
    };
  }, [id]);

  const tags = issue?.tags ?? null;
  const isAssigned = issue !== null && (issue.assignees > 0 || tags?.status === "assigned");
  // The count from the last check, or from the thread when it found more since.
  const commentCount = issue !== null && thread !== null ? Math.max(issue.comments, thread.comments.length) : 0;

  return (
    <Dialog
      open={issue !== null}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
        {issue !== null && (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6 leading-snug">
                <span className="text-muted-foreground tabular-nums">#{issue.number}</span> {issue.title}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{props.repo}</span>
                <span title={new Date(issue.created_at).toLocaleString()}>
                  Opened {timeAgo(issue.created_at)} by {issue.author}
                </span>
                {issue.updated_at !== undefined && <span title={new Date(issue.updated_at).toLocaleString()}>Updated {timeAgo(issue.updated_at)}</span>}
                <a href={issue.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-foreground">
                  GitHub <ExternalLink className="size-3" />
                </a>
              </DialogDescription>
            </DialogHeader>

            {/* The app's tags and why; nothing yet while Claude hasn't read it. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {isAssigned && <Badge variant="warn">assigned</Badge>}
              {!isAssigned && tags?.status === "free" && <Badge variant="ok">free</Badge>}
              {tags !== null && tags.level !== null && (
                <Badge variant={LEVEL_VARIANT[tags.level]} className="capitalize">
                  {tags.level}
                </Badge>
              )}
              {tags !== null && tags.kind !== null && <Badge variant="secondary">{tags.kind}</Badge>}
              {tags !== null && <span>{tags.reason}</span>}
              {tags === null && !isAssigned && <span className="text-muted-foreground">Not tagged yet.</span>}
            </div>

            {/* The text, then every comment below it; this part scrolls. */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              {thread === null && error === "" && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading the issue…
                </div>
              )}
              {error !== "" && <div className="text-destructive">Could not load the issue: {error}</div>}
              {thread !== null && (
                <>
                  <div className="rounded-md border bg-muted/30 px-4 py-3">
                    <Markdown text={thread.body || "*No description.*"} repo={props.repo} issueRefs />
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">
                    {commentCount === 0 ? "No comments" : `${commentCount} ${commentCount === 1 ? "comment" : "comments"}`}
                  </div>
                  {thread.comments.map((comment, index) => (
                    <div key={index} className="rounded-md border px-4 py-2">
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{comment.author}</span>
                        <span title={new Date(comment.at).toLocaleString()}>{timeAgo(comment.at)}</span>
                      </div>
                      <Markdown text={comment.body} repo={props.repo} issueRefs />
                    </div>
                  ))}
                  {issue.comments > thread.comments.length && (
                    <a href={issue.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                      {issue.comments - thread.comments.length} more on GitHub <ExternalLink className="size-3" />
                    </a>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
