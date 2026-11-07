/*
A repo's issues in a pop-up: a click on its card on the Dashboard's Repository page (RepositoryCards.tsx). Every open
issue of the repo on GitHub, newest first, read again each time it opens (GET /api/repos/issues), not only the ones on
the Issues board: claimed, out of scope and the ones its Automation takes off show too.
While it reads them, the line under the repo's name says "Reading issues from GitHub" with a spinner. Then the ones
without complete tags (none yet, from older rules, or the issue changed on GitHub since: the backend says which) are
tagged at once (POST /api/repos/issues/tag): the line says how many are being tagged, each of those rows says
"Tagging" where its tags go, and their tags show as soon as they are in. Each issue of a repo is tagged once like that
(again only after it changes), so the next time the pop-up opens its tags are there. Closing the pop-up doesn't stop
the tagging.
Two tabs over the list, with how many: Free (also the ones not tagged yet) and Claimed (Claimed and Fixed: someone is
on it, or it only needs closing). Free shows when it opens. Each tab is newest first, by when the issue was opened.
Each row: the issue's GitHub title and its tags, under them its number, when it was opened (hover for the date) and how
many comments it has. A click opens it on GitHub in a new tab. The tags are the Issues board's (IssueBoard.tsx), from
github_searcher/issue_tags.py, none for one Claude never read: Free, Claimed or Fixed, the complexity (or Out of scope),
about how many lines the fix changes, and Scope clear or Scope not clear, in the same colors.
At a row's right, Add puts the issue at the end of the Issues board's Catalog (POST /api/issues/catalog), whatever its
tags say, even one taken off the board for good; "In Catalog" once it is there. One an agent started has neither, and
an archived repo's rows have no Add (its issues leave Open and Catalog by themselves).
The tags of the issues on the Issues list, and which are in Catalog, come from the live "issues" and "jobs" topics, so
they update by themselves.
*/

import { CircleDot, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, type IssueTags } from "@/live";
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

// An open issue as GET /api/repos/issues gives it.
type Found = {
  number: number;
  title: string;
  url: string;
  created_at: string;
  labels: string[];
  comments: number;
  tags: IssueTags | null;
  complete: boolean; // its tags are by the current rules and read since its last change on GitHub
};

type Row = {
  number: number;
  title: string;
  url: string;
  created_at: string;
  labels: string[];
  comments: number;
  read: IssueTags | null;
  tags: Tag[];
  // "add": Add shows; "catalog": In Catalog shows; "started": an agent started on it, nothing shows.
  place: string;
};

export default function RepositoryIssuesDialog(props: { repo: string | null; archived: boolean; onClose: () => void }) {
  const issues = useLive("issues");
  const jobs = useLive("jobs");
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState("");
  // The issues being tagged now, by number, and why tagging failed ("" when it didn't).
  const [tagging, setTagging] = useState<number[]>([]);
  const [tagError, setTagError] = useState("");
  // The tab shown: "free" or "claimed".
  const [tab, setTab] = useState("free");
  const name = (props.repo ?? "").toLowerCase();

  // Read from GitHub again each time a repo opens, then tag the ones without complete tags. A late answer for a repo
  // closed meanwhile is dropped.
  useEffect(() => {
    if (props.repo === null) {
      return;
    }
    const repo = props.repo;
    let current = true;
    setFound(null);
    setError("");
    setTagging([]);
    setTagError("");
    setTab("free");
    api<{ issues: Found[] }>(`/api/repos/issues?name=${encodeURIComponent(repo)}`)
      .then(async (result) => {
        if (!current) {
          return;
        }
        setFound(result.issues);
        const todo = result.issues.filter((issue) => !issue.complete).map((issue) => issue.number);
        if (todo.length === 0) {
          return;
        }
        setTagging(todo);
        try {
          const tagged = await api<{ tags: Record<string, IssueTags | null> }>("/api/repos/issues/tag", {
            method: "POST",
            body: { name: repo, numbers: todo },
          });
          if (current) {
            setFound(result.issues.map((issue) => ({ ...issue, tags: tagged.tags[String(issue.number)] ?? issue.tags })));
          }
        } catch (err) {
          if (current) {
            setTagError(err instanceof Error ? err.message : String(err));
          }
        }
        if (current) {
          setTagging([]);
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
  }, [props.repo]);

  // Started: a job on it that isn't cancelled.
  const started: string[] = [];
  for (const job of jobs) {
    if (job.issue !== null && job.status !== "cancelled") {
      started.push(job.issue.toLowerCase());
    }
  }
  const catalog = issues.catalog.map((id) => id.toLowerCase());

  const rows: Row[] = [];
  for (const issue of found ?? []) {
    const id = `${name}#${issue.number}`;
    // One on the Issues list has its tags from the live feed, so they update by themselves.
    const listed = issues.items.find((each) => each.id.toLowerCase() === id);
    let place = "add";
    if (catalog.includes(id)) {
      place = "catalog";
    }
    if (started.includes(id)) {
      place = "started";
    }
    rows.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      created_at: issue.created_at,
      labels: issue.labels,
      comments: issue.comments,
      read: listed?.tags ?? issue.tags,
      tags: [],
      place: place,
    });
  }

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

  // Newest first, by when it was opened.
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Free: free, waiting or not tagged yet. Claimed: claimed or fixed.
  const freeRows = rows.filter((row) => row.read === null || (row.read.status !== "assigned" && row.read.status !== "fixed"));
  const claimedRows = rows.filter((row) => row.read !== null && (row.read.status === "assigned" || row.read.status === "fixed"));
  const shownRows = tab === "free" ? freeRows : claimedRows;

  // To the end of Catalog, whatever its tags say.
  async function add(row: Row) {
    try {
      await api("/api/issues/catalog", {
        method: "POST",
        body: { repo: props.repo, number: row.number, title: row.title, labels: row.labels, comments: row.comments, url: row.url },
      });
      toast.success(`Added #${row.number} to Catalog`);
    } catch (err) {
      toast.error(`Could not add it: ${err instanceof Error ? err.message : err}`);
    }
  }

  let description = "Reading issues from GitHub";
  if (found !== null) {
    description = `${rows.length} open ${rows.length === 1 ? "issue" : "issues"}`;
  }
  if (found !== null && tagging.length > 0) {
    description += ` · Tagging ${tagging.length} ${tagging.length === 1 ? "issue" : "issues"}`;
  }
  if (found !== null && tagError !== "") {
    description += ` · Could not tag them: ${tagError}`;
  }
  if (error !== "") {
    description = "";
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
          <DialogDescription className="flex items-center gap-1.5 tabular-nums">
            {error === "" && (found === null || tagging.length > 0) && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
            {description}
          </DialogDescription>
        </DialogHeader>

        {found !== null && rows.length > 0 && (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="free" className="px-2.5">
                Free <span className="text-xs text-muted-foreground tabular-nums">{freeRows.length}</span>
              </TabsTrigger>
              <TabsTrigger value="claimed" className="px-2.5">
                Claimed <span className="text-xs text-muted-foreground tabular-nums">{claimedRows.length}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        <div className="-mx-4 -mb-4 min-h-0 flex-1 overflow-y-auto border-t">
          {error !== "" && <div className="px-4 py-3 text-destructive">Could not read its issues: {error}</div>}
          {found !== null && rows.length === 0 && <div className="px-4 py-3 text-muted-foreground">No open issues.</div>}
          {found !== null && rows.length > 0 && shownRows.length === 0 && (
            <div className="px-4 py-3 text-muted-foreground">{tab === "free" ? "No free issues." : "No claimed issues."}</div>
          )}
          {shownRows.map((row) => (
            <div key={row.number} className="flex items-center gap-2.5 border-b px-4 py-2.5 last:border-b-0 hover:bg-accent/50">
              <a href={row.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 gap-2.5">
                <CircleDot className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{row.title}</span>
                    {tagging.includes(row.number) && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> Tagging
                      </span>
                    )}
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
              {row.place === "add" && !props.archived && (
                <Button size="xs" className="shrink-0" onClick={() => add(row)}>
                  Add
                </Button>
              )}
              {row.place === "catalog" && <span className="shrink-0 text-xs text-muted-foreground">In Catalog</span>}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
