/*
The Dashboard's Repository page (#/dashboard/repos): the repos on the Repos page as cards, two to a row (one on a phone).
A card: the owner's picture as its logo, owner/name (opens it on GitHub), its description and its tags. A click
anywhere else on it (not its buttons) opens its issues in a pop-up, with their tags (RepositoryIssuesDialog.tsx). At the bottom
left yours: how many of your pull requests it merged and how many are still open. At the bottom right everyone's, the
repo's own numbers in all: its stars, open, merged and closed (without a merge) pull requests, commits, contributors (everyone
who ever contributed) and open issues, each once the signals have it (a repo read before they were counted gets them by itself within
seconds, with one small read). Every card has the same three tags, from the repo's signals
(github_searcher/repo_signals.py):
- AI policy: AI welcome, AI disclose, AI forbidden, or No AI policy (also when AI is mentioned but what's allowed isn't
  said).
- Average merge: of outside PRs (not opened by a maintainer, nor merged by their own author) merged in the last 30
  days, each contributor's mean days from opening to merge, then the mean of those, so one person with many PRs counts
  once; or No merges in 30 days.
- Newcomers: Welcomes newcomers or Closed repo, the agent's call (newcomer_verdict) from the stars per all-time
  contributor (under about 100 usually open, over about 1000 usually closed), the contributing guide and how outside
  PRs went.
The signals are read once, within seconds of a repo being added, and kept: the tags only change on Refresh. Until
they are read (or while an older read lacks the average merge or the verdict, read once more by itself) a card has
fewer tags.
Nothing to add here. The robot button next to the ⋯ opens the repo's Automation (AutomationDialog.tsx: what agents do
there without asking you; only the settings so far). The ⋯ on a card opens its menu:
- Refresh reads the repo's signals from GitHub again now (POST /api/repos/refresh, a few seconds).
- Delete, at once: a repo with any pull request of yours (open, closed or merged) moves to the Archived section at the
  bottom, under a line, and can't be deleted
  (POST /api/repos/archive): it stays in Repos, and Take issues takes nothing there. Any other leaves Repos and stops
  being tracked, like Delete on the Repos page (its issues stay; Ctrl+Z on the Repos page brings it back).
An archived card has no box and no robot; its ⋯ has Unarchive, which moves it back up.
The box under a card's logo picks it. Select all (Deselect all once all are picked) is always in the top bar, just left
of Sort. With any picked, Refresh, Delete and the robot (Automation for all the picked repos at once: the same settings
for each) show left of it; Refresh and Delete do the same for every picked card (Refresh 4 at a time, a toast says when
all are done and which failed). Delete unpicks them; the picks are kept until then, but not across a reload.

Sort, top right: PRs merged (yours there), Merge rate (of your pull requests there that were merged or closed, how
many were merged; a repo with none goes last), Open PRs (yours there, still open) and Stars. Ties go by stars.
Your pull requests are the ones the app follows (github_searcher/pr_tracking.py: the ones Approve sent and your 50 most
recently updated on other people's projects), from the live "prs" topic, so the numbers update themselves.
*/

import {
  Archive,
  Bot,
  CircleDot,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MoreHorizontal,
  RefreshCw,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import AutomationDialog from "@/AutomationDialog";
import RepositoryIssuesDialog from "@/RepositoryIssuesDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SelectBox } from "@/components/ui/row-selection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, useLive, useLoaded, type AIPolicyTag } from "@/live";
import { cn } from "@/lib/utils";

// A tag on a card: its words and its color (a Badge variant: green good, red bad, gray the rest).
type Tag = { label: string; variant: "ok" | "bad" | "secondary" };

const AI_TAGS: Record<AIPolicyTag, Tag> = {
  welcome: { label: "AI welcome", variant: "ok" },
  disclose: { label: "AI disclose", variant: "secondary" },
  no_ai: { label: "AI forbidden", variant: "bad" },
  unclear: { label: "No AI policy", variant: "secondary" },
  none: { label: "No AI policy", variant: "secondary" },
};

const SORTS: Record<string, string> = {
  merged: "PRs merged",
  rate: "Merge rate",
  open: "Open PRs",
  stars: "Stars",
};

export default function RepositoryCards() {
  const repos = useLive("repos");
  const prs = useLive("prs");
  const loaded = useLoaded("repos");
  const [sort, setSort] = useState("merged");
  // The picked cards, by name.
  const [selected, setSelected] = useState<string[]>([]);
  // The repos whose Automation is open (one from a card's robot, the picked ones from the top bar's), or none.
  const [automation, setAutomation] = useState<string[]>([]);
  // The repo whose issues are open in the pop-up, or none.
  const [issuesOf, setIssuesOf] = useState<string | null>(null);

  // Your pull requests in each repo, by its name in lower case: merged, closed without a merge, and open.
  const merged: Record<string, number> = {};
  const closed: Record<string, number> = {};
  const open: Record<string, number> = {};
  for (const pr of prs.items) {
    const key = pr.repo.toLowerCase();
    if (pr.relation === "author" && pr.state === "merged") {
      merged[key] = (merged[key] ?? 0) + 1;
    }
    if (pr.relation === "author" && pr.state === "closed") {
      closed[key] = (closed[key] ?? 0) + 1;
    }
    if (pr.relation === "author" && pr.state === "open") {
      open[key] = (open[key] ?? 0) + 1;
    }
  }

  const cards = repos.items.map((repo) => {
    const key = repo.full_name.toLowerCase();
    const done = (merged[key] ?? 0) + (closed[key] ?? 0);
    // -1: no merged or closed pull request of yours there, so no rate.
    const rate = done > 0 ? (merged[key] ?? 0) / done : -1;

    // Its tags, in this order: AI policy, average merge, newcomers.
    const tags: Tag[] = [];
    const signals = repo.signals;
    if (signals !== null) {
      tags.push(AI_TAGS[signals.ai_policy.tag]);
    }
    const days = signals !== null ? signals.average_days_to_merge_30d : undefined;
    if (days !== undefined && days !== null) {
      tags.push({ label: `Avg merge ${days} ${days === 1 ? "day" : "days"}`, variant: "secondary" });
    }
    if (days === null) {
      tags.push({ label: "No merges in 30 days", variant: "secondary" });
    }
    // The agent's call.
    const verdict = signals?.newcomer_verdict;
    if (verdict !== undefined && verdict !== null && verdict.verdict === "welcome") {
      tags.push({ label: "Welcomes newcomers", variant: "ok" });
    }
    if (verdict !== undefined && verdict !== null && verdict.verdict === "closed") {
      tags.push({ label: "Closed repo", variant: "bad" });
    }

    return { repo: repo, merged: merged[key] ?? 0, open: open[key] ?? 0, rate: rate, tags: tags };
  });
  cards.sort((a, b) => {
    let order = b.merged - a.merged;
    if (sort === "rate") {
      order = b.rate - a.rate;
    }
    if (sort === "open") {
      order = b.open - a.open;
    }
    if (sort === "stars") {
      order = 0;
    }
    return order !== 0 ? order : b.repo.stars - a.repo.stars;
  });
  // The archived ones last, in the same order, under a line.
  const active = cards.filter((card) => !repos.archived.includes(card.repo.full_name));
  const archived = cards.filter((card) => repos.archived.includes(card.repo.full_name));
  const shown = [...active, ...archived];

  // Only repos still in the list and not archived count as picked (one may have been deleted elsewhere).
  const names = active.map((card) => card.repo.full_name);
  const chosen = selected.filter((name) => names.includes(name));
  const allChosen = names.length > 0 && chosen.length === names.length;

  function toggle(name: string) {
    if (chosen.includes(name)) {
      setSelected(chosen.filter((each) => each !== name));
    } else {
      setSelected([...chosen, name]);
    }
  }

  // "owner/name" for one repo, "3 repositories" for more.
  function describe(list: string[]) {
    return list.length === 1 ? list[0] : `${list.length} repositories`;
  }

  async function refresh(list: string[]) {
    const toastId = toast.loading(`Refreshing ${describe(list)}…`);
    try {
      const result = await api<{ refreshed: string[]; failed: string[] }>("/api/repos/refresh", { method: "POST", body: { names: list } });
      if (result.failed.length > 0) {
        toast.error(`Could not refresh ${result.failed.join(", ")}`, { id: toastId });
      } else {
        toast.success(`Refreshed ${describe(list)}`, { id: toastId });
      }
    } catch (err) {
      toast.error(`Could not refresh ${describe(list)}: ${err instanceof Error ? err.message : err}`, { id: toastId });
    }
  }

  // Delete, at once: archived when it has any pull request of yours (open, closed or merged), else off Repos.
  async function remove(list: string[]) {
    const toArchive = list.filter((name) => (merged[name.toLowerCase()] ?? 0) + (closed[name.toLowerCase()] ?? 0) + (open[name.toLowerCase()] ?? 0) > 0);
    const toRemove = list.filter((name) => !toArchive.includes(name));
    try {
      if (toArchive.length > 0) {
        await api("/api/repos/archive", { method: "POST", body: { names: toArchive, archived: true } });
        toast.success(`Archived ${describe(toArchive)}`);
      }
      if (toRemove.length > 0) {
        await api("/api/repos/remove", { method: "POST", body: { names: toRemove, issues: false } });
        toast.success(`Deleted ${describe(toRemove)}`);
      }
      setSelected(chosen.filter((name) => !list.includes(name)));
    } catch (err) {
      toast.error(`Could not delete ${describe(list)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function unarchive(name: string) {
    try {
      await api("/api/repos/archive", { method: "POST", body: { names: [name], archived: false } });
    } catch (err) {
      toast.error(`Could not unarchive ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b px-3 py-1">
        <span className="text-muted-foreground tabular-nums">
          {chosen.length > 0 ? `${chosen.length} selected` : `${active.length} ${active.length === 1 ? "repository" : "repositories"}`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {chosen.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => refresh(chosen)}>
              <RefreshCw /> Refresh
            </Button>
          )}
          {chosen.length > 0 && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => remove(chosen)}>
              <Trash2 /> Delete
            </Button>
          )}
          {chosen.length > 0 && (
            <Button size="icon-sm" variant="outline" aria-label="Automation" title="Automation" onClick={() => setAutomation(chosen)}>
              <Bot />
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={names.length === 0} onClick={() => setSelected(allChosen ? [] : names)}>
            {allChosen ? "Deselect all" : "Select all"}
          </Button>
        </div>
        <Select value={sort} onValueChange={setSort}>
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loaded && cards.length === 0 && <div className="px-3 py-2 text-muted-foreground">No repositories yet.</div>}
        <div className="grid grid-cols-2 gap-3 p-3 max-md:grid-cols-1">
          {shown.map((card, index) => (
            <Fragment key={card.repo.full_name}>
              {index === active.length && (
                <div className="col-span-full mt-2 flex items-center gap-2 border-t pt-3 text-xs font-medium text-muted-foreground">
                  <Archive className="size-3.5" /> Archived
                  <span className="tabular-nums">{archived.length}</span>
                </div>
              )}
              <div
                className={cn(
                  "flex min-w-0 cursor-pointer gap-3 rounded-lg border bg-card p-3 hover:bg-accent/50",
                  chosen.includes(card.repo.full_name) && "border-primary/50 bg-selected",
                )}
                onClick={() => setIssuesOf(card.repo.full_name)}
              >
                <div className="flex shrink-0 flex-col items-center gap-2">
                  <img src={`https://github.com/${card.repo.full_name.split("/")[0]}.png?size=80`} alt="" className="size-10 rounded-md" />
                  {index < active.length && (
                    <button
                      type="button"
                      className="p-1"
                      aria-label={`Select ${card.repo.full_name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(card.repo.full_name);
                      }}
                    >
                      <SelectBox checked={chosen.includes(card.repo.full_name)} />
                    </button>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={card.repo.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate font-medium hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {card.repo.full_name}
                    </a>
                    {index < active.length && (
                      <button
                        type="button"
                        className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label={`Automation for ${card.repo.full_name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setAutomation([card.repo.full_name]);
                        }}
                      >
                        <Bot className="size-4" />
                      </button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            index < active.length ? "" : "ml-auto",
                            "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
                          )}
                          aria-label={`Settings for ${card.repo.full_name}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      {index < active.length ? (
                        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                          <DropdownMenuItem onSelect={() => refresh([card.repo.full_name])}>
                            <RefreshCw /> Refresh
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => remove([card.repo.full_name])}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      ) : (
                        <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                          <DropdownMenuItem onSelect={() => unarchive(card.repo.full_name)}>
                            <Archive /> Unarchive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      )}
                    </DropdownMenu>
                  </div>
                  <p className="mt-1 line-clamp-2 text-muted-foreground">{card.repo.description !== "" ? card.repo.description : "No description"}</p>
                  {card.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {card.tags.map((tag) => (
                        <Badge key={tag.label} variant={tag.variant}>
                          {tag.label}
                        </Badge>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                    <span className="flex items-center gap-1" title="Your PRs merged">
                      <GitMerge className="size-3.5" />
                      {card.merged} merged
                    </span>
                    <span className="flex items-center gap-1" title="Your open PRs">
                      <GitPullRequest className="size-3.5" />
                      {card.open} open
                    </span>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                      <span className="flex items-center gap-1" title="Stars">
                        <Star className="size-3.5" />
                        {card.repo.stars.toLocaleString()}
                      </span>
                      {card.repo.signals?.open_prs_total !== undefined && (
                        <span className="flex items-center gap-1" title="Open pull requests">
                          <GitPullRequest className="size-3.5" />
                          {card.repo.signals.open_prs_total.toLocaleString()} open
                        </span>
                      )}
                      {card.repo.signals?.merged_prs_total !== undefined && (
                        <span className="flex items-center gap-1" title="Merged pull requests">
                          <GitMerge className="size-3.5" />
                          {card.repo.signals.merged_prs_total.toLocaleString()} merged
                        </span>
                      )}
                      {card.repo.signals?.closed_prs_total !== undefined && (
                        <span className="flex items-center gap-1" title="Closed pull requests, without a merge">
                          <GitPullRequestClosed className="size-3.5" />
                          {card.repo.signals.closed_prs_total.toLocaleString()} closed
                        </span>
                      )}
                      {card.repo.signals?.commits_total !== undefined && (
                        <span className="flex items-center gap-1" title="Commits">
                          <GitCommitHorizontal className="size-3.5" />
                          {card.repo.signals.commits_total.toLocaleString()} commits
                        </span>
                      )}
                      {card.repo.signals?.contributors_total !== undefined && card.repo.signals.contributors_total !== null && (
                        <span className="flex items-center gap-1" title="Contributors, everyone who ever contributed">
                          <Users className="size-3.5" />
                          {card.repo.signals.contributors_total.toLocaleString()} contributors
                        </span>
                      )}
                      {card.repo.signals?.open_issues_total !== undefined && (
                        <span className="flex items-center gap-1" title="Open issues">
                          <CircleDot className="size-3.5" />
                          {card.repo.signals.open_issues_total.toLocaleString()} issues
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </Fragment>
          ))}
        </div>
      </div>

      {automation.length > 0 && <AutomationDialog repos={automation} onClose={() => setAutomation([])} />}
      <RepositoryIssuesDialog repo={issuesOf} onClose={() => setIssuesOf(null)} />
    </div>
  );
}
