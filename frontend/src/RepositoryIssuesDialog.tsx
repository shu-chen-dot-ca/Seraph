/*
A repo's issues in a pop-up: a click on its card on the Dashboard's Repository page (RepositoryCards.tsx). Its open
issues the app knows, each once, newest first: the repo's issues on the Issues list and, when the repo is tracked, the
ones its last check found (github_searcher/tracked_issues.py). Issues the app has neither way aren't here, so there can
be fewer than the card's count of open issues.
Each row: the issue's GitHub title and its tags, under them its number, when it was opened (hover for the date) and how
many comments it has. A click opens it on GitHub in a new tab. The tags are the Issues board's (IssueBoard.tsx), from
github_searcher/issue_tags.py, none until Claude has read it: Free, Claimed or Fixed, the complexity (or Out of scope),
about how many lines the fix changes, and Scope clear or Scope not clear, in the same colors.
Everything comes from the live "issues" and "tracked" topics, so the tags update by themselves.
*/

import { CircleDot, MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLive, type IssueTags } from "@/live";
import { timeAgo } from "@/lib/utils";

// A tag on a row: its words and its color, the same as on the Issues board.
type Tag = {
  label: string;
  variant: "ok" | "bad" | "secondary";
  className?: string;
};

const COMPLEXITY_TAGS: Record<string, Tag> = {
  easy: { label: "Easy", variant: "ok" },
  medium: {
    label: "Medium",
    variant: "secondary",
    className: "bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-400",
  },
  hard: {
    label: "Hard",
    variant: "secondary",
    className: "bg-orange-500/10 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400",
  },
};

type Row = {
  number: number;
  title: string;
  url: string;
  created_at: string;
  comments: number;
  read: IssueTags | null;
  tags: Tag[];
};

export default function RepositoryIssuesDialog(props: { repo: string | null; onClose: () => void }) {
  const issues = useLive("issues");
  const tracked = useLive("tracked");
  const name = (props.repo ?? "").toLowerCase();

  // The repo's open issues on the Issues list.
  const rows: Row[] = [];
  for (const issue of issues.items) {
    if (issue.repo.toLowerCase() !== name || (issue.facts?.state ?? issue.state) === "CLOSED") {
      continue;
    }
    rows.push({
      number: issue.number,
      title: issue.facts?.title ?? issue.title,
      url: issue.html_url,
      created_at: issue.facts?.created_at ?? issue.added_at,
      comments: issue.facts?.comments ?? issue.comments,
      read: issue.tags ?? null,
      tags: [],
    });
  }
  // Then the ones its last check found, when it is tracked, but not those twice.
  const trackedRepo = tracked.items.find((each) => each.full_name.toLowerCase() === name);
  const found = trackedRepo !== undefined && trackedRepo.check !== null ? trackedRepo.check.issues : [];
  for (const issue of found) {
    if (rows.some((row) => row.number === issue.number)) {
      continue;
    }
    rows.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      created_at: issue.created_at,
      comments: issue.comments,
      read: issue.tags ?? null,
      tags: [],
    });
  }
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Each row's tags, in the Issues board's order: free or claimed, complexity, lines, scope.
  for (const row of rows) {
    const read = row.read;
    if (read !== null && read.status === "assigned") {
      row.tags.push({ label: "Claimed", variant: "bad" });
    } else if (read !== null && read.status === "fixed") {
      row.tags.push({ label: "Fixed", variant: "secondary" });
    } else if (read !== null) {
      row.tags.push({ label: "Free", variant: "ok" });
    }
    if (read?.merge === "out of scope") {
      row.tags.push({ label: "Out of scope", variant: "bad" });
    } else if (read?.complexity) {
      row.tags.push(COMPLEXITY_TAGS[read.complexity]);
    }
    if (read?.lines !== null && read?.lines !== undefined) {
      row.tags.push({ label: `~${read.lines} lines`, variant: "secondary" });
    }
    if (read?.scope_clear === true) {
      row.tags.push({ label: "Scope clear", variant: "ok" });
    }
    if (read?.scope_clear === false) {
      row.tags.push({ label: "Scope not clear", variant: "bad" });
    }
  }

  return (
    <Dialog
      open={props.repo !== null}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-6 leading-snug">{props.repo}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {rows.length} open {rows.length === 1 ? "issue" : "issues"}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 -mb-4 min-h-0 flex-1 overflow-y-auto border-t">
          {rows.length === 0 && <div className="px-4 py-3 text-muted-foreground">No issues yet.</div>}
          {rows.map((row) => (
            <a key={row.number} href={row.url} target="_blank" rel="noreferrer" className="flex gap-2.5 border-b px-4 py-2.5 last:border-b-0 hover:bg-accent/50">
              <CircleDot className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-500" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{row.title}</span>
                  {row.tags.map((tag) => (
                    <Badge key={tag.label} variant={tag.variant} className={tag.className}>
                      {tag.label}
                    </Badge>
                  ))}
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                  <span>#{row.number}</span>
                  <span title={new Date(row.created_at).toLocaleString()}>Opened {timeAgo(row.created_at)}</span>
                  <span className="flex items-center gap-1">
                    <MessageSquare className="size-3.5" />
                    {row.comments}
                  </span>
                </div>
              </div>
            </a>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
