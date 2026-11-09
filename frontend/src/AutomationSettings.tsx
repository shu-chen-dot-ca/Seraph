/*
The Dashboard's Automation → Settings tab (#/dashboard/automation?tab=settings, inside Automation.tsx): every level of
automation in one place, the same ones the robot buttons on the Repository page and the Issues board edit, with the same
dialogs, and the Automation's own rules. It all comes from the live "automation" topic (backend/automation_api.py), so a
change made here shows there at once, and one made there shows here.

Top to bottom:
- Rules: the days behind the labels and what the Automation does with them. Business days but the last two. Save (once
  something changed) checks them (whole numbers, 1 to 365; Fast within Normal; No issues before archived for it).
- New repositories: the level of automation the repos the Automation adds get, in one line; the robot opens it
  (AutomationDialog.tsx with newRepos).
- Issues board: its automation in one line (agents at once, how often its issues are read again, inactive PRs, what
  leaves by itself); the robot opens it (BoardAutomationDialog.tsx).
- Repositories: each repo in Repos that isn't archived, with its level in one line; its robot opens it
  (AutomationDialog.tsx). The robot over them opens one dialog for all of them at once.
- Issues: each open issue on the Issues board with its level: its own (marked Own) or its repo's; its robot opens it
  (IssueAutomationDialog.tsx). Own ones first.
*/

import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import AutomationDialog from "@/AutomationDialog";
import BoardAutomationDialog from "@/BoardAutomationDialog";
import IssueAutomationDialog, { type Level } from "@/IssueAutomationDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, useLive, type AutomationRules, type IssueItem, type RepoAutomation } from "@/live";

// A repo's level of automation, in the order the dialog lists them.
const REPO_LEVELS: [keyof RepoAutomation, string][] = [
  ["add_issues", "Add issues"],
  ["queue_issues", "Queue issues"],
  ["take_issues", "Take issues"],
  ["questions", "Questions"],
  ["comments", "Comments"],
  ["pull_requests", "Pull requests"],
  ["open_issues", "Open issues"],
];

// The rules' boxes: the key, the words before the box and after it.
const RULES: [keyof AutomationRules, string, string][] = [
  ["fast_days", "Fast: merges ours within", "business days"],
  ["normal_days", "Normal: merges ours within", "business days"],
  ["max_open_days", "Not merging: one of ours open over", "business days"],
  ["close_days", "Close our open PRs on an archived repo after", "business days"],
  ["idle_days", "No issues: nothing to work on for", "days"],
  ["leave_days", "Archive a repo with no issues after", "days"],
];

const ROBOT = "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";

export default function AutomationSettings() {
  const automation = useLive("automation");
  const repos = useLive("repos");
  const issues = useLive("issues");
  // The rules as typed (digits only); Save checks them.
  const [rules, setRules] = useState<Record<string, string>>({});
  // What is open: a repo's (or many repos') dialog, the new repos' one, the board's, an issue's.
  const [repoDialog, setRepoDialog] = useState<string[]>([]);
  const [newReposDialog, setNewReposDialog] = useState(false);
  const [boardDialog, setBoardDialog] = useState(false);
  const [issueDialog, setIssueDialog] = useState<{ issue: IssueItem; name: string; level: Level; own: boolean } | null>(null);

  // The boxes follow the saved rules when they change, here or elsewhere.
  const savedRules = JSON.stringify(automation.rules);
  useEffect(() => {
    const typed: Record<string, string> = {};
    for (const [key] of RULES) {
      typed[key] = String(automation.rules[key]);
    }
    setRules(typed);
  }, [savedRules]);
  const changed = RULES.some(([key]) => rules[key] !== String(automation.rules[key]));

  async function saveRules() {
    const body: Record<string, number> = {};
    for (const [key] of RULES) {
      body[key] = Number(rules[key]);
    }
    try {
      await api("/api/automation/rules", { method: "PUT", body: body });
      toast.success("Saved the rules");
    } catch (err) {
      toast.error(`Could not save: ${err instanceof Error ? err.message : err}`);
    }
  }

  // "Add issues, Take issues, Pull requests · 1 then 5 PRs at once", or No automation.
  function describe(level: RepoAutomation) {
    const on = REPO_LEVELS.filter(([key]) => level[key] === true).map(([, name]) => name);
    if (on.length === 0) {
      return "No automation";
    }
    return `${on.join(", ")} · ${level.max_prs_first ?? 1} then ${level.max_prs ?? 5} PRs at once`;
  }

  // Each repo's level by its name in lower case (a repo with none has the defaults).
  const byName: Record<string, RepoAutomation> = {};
  for (const name of Object.keys(automation.repo_levels)) {
    byName[name.toLowerCase()] = automation.repo_levels[name];
  }
  const active = repos.items.filter((repo) => !repos.archived.includes(repo.full_name)).map((repo) => repo.full_name);

  // The board's open issues, each with its own level or its repo's; own ones first.
  const issueRows = issues.items
    .filter((issue) => (issue.facts?.state ?? issue.state) !== "CLOSED")
    .map((issue) => {
      const own = automation.issue_levels[issue.id];
      const repoLevel = byName[issue.repo.toLowerCase()] ?? automation.defaults;
      const level: Level = own ?? { questions: repoLevel.questions, comments: repoLevel.comments, pull_requests: repoLevel.pull_requests };
      return { issue: issue, name: issue.tags?.name ?? issue.facts?.title ?? issue.title, level: level, own: own !== undefined };
    });
  issueRows.sort((a, b) => Number(b.own) - Number(a.own));

  const board = automation.board;
  const removes: string[] = [];
  if (board.claimed) {
    removes.push("claimed");
  }
  if (board.out_of_scope) {
    removes.push("out of scope");
  }
  for (const level of board.levels) {
    removes.push(level);
  }
  if (board.scope_not_clear) {
    removes.push("scope not clear");
  }
  if (board.older_than_days !== null) {
    removes.push(`opened over ${board.older_than_days} days ago`);
  }

  const section = "flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground";
  const line = "flex min-w-0 items-center gap-3 border-b px-3 py-2";

  return (
    <div>
      <div className={section}>Rules</div>
      <div className="flex flex-col gap-1.5 border-b px-3 py-2.5">
        {RULES.map(([key, before, after]) => (
          <label key={key} className="flex flex-wrap items-center gap-2">
            {before}
            <Input
              className="h-7 w-14"
              inputMode="numeric"
              value={rules[key] ?? ""}
              onChange={(event) => setRules({ ...rules, [key]: event.target.value.replace(/\D/g, "") })}
            />
            <span className="text-muted-foreground">{after}</span>
          </label>
        ))}
        <div>
          <Button size="sm" className="mt-1" disabled={!changed} onClick={saveRules}>
            Save
          </Button>
        </div>
      </div>

      <div className={section}>New repositories</div>
      <div className={line}>
        <div className="min-w-0 flex-1">
          <div>The level of automation the repositories it adds get</div>
          <div className="text-muted-foreground">{describe(automation.new_repos)}</div>
        </div>
        <button type="button" className={ROBOT} aria-label="Automation for new repositories" onClick={() => setNewReposDialog(true)}>
          <Bot className="size-4" />
        </button>
      </div>

      <div className={section}>Issues board</div>
      <div className={line}>
        <div className="min-w-0 flex-1">
          <div>
            {board.max_agents} {board.max_agents === 1 ? "agent" : "agents"} at once · read again every {board.refresh_open_minutes},{" "}
            {board.refresh_catalog_minutes} and {board.refresh_ongoing_minutes} minutes (Open, Catalog, In progress)
          </div>
          <div className="text-muted-foreground">
            {board.stale_pr_days !== null ? `Inactive PRs made again after ${board.stale_pr_days} days` : "Inactive PRs left as they are"} ·{" "}
            {removes.length > 0 ? `Removes ${removes.join(", ")}` : "Removes nothing by itself"}
          </div>
        </div>
        <button type="button" className={ROBOT} aria-label="Automation for the Issues board" onClick={() => setBoardDialog(true)}>
          <Bot className="size-4" />
        </button>
      </div>

      <div className={section}>
        Repositories <span className="tabular-nums">{active.length}</span>
        {active.length > 1 && (
          <button type="button" className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent hover:text-foreground" onClick={() => setRepoDialog(active)}>
            <Bot className="size-3.5" /> All
          </button>
        )}
      </div>
      {active.length === 0 && <div className="border-b px-3 py-2 text-muted-foreground">No repositories yet.</div>}
      {active.map((name) => (
        <div key={name} className={line}>
          <img src={`https://github.com/${name.split("/")[0]}.png?size=48`} alt="" className="size-6 shrink-0 rounded" />
          <div className="min-w-0 flex-1">
            <a href={`https://github.com/${name}`} target="_blank" rel="noreferrer" className="block truncate font-medium hover:underline">
              {name}
            </a>
            <div className="truncate text-muted-foreground">{describe(byName[name.toLowerCase()] ?? automation.defaults)}</div>
          </div>
          <button type="button" className={ROBOT} aria-label={`Automation for ${name}`} onClick={() => setRepoDialog([name])}>
            <Bot className="size-4" />
          </button>
        </div>
      ))}

      <div className={section}>
        Issues <span className="tabular-nums">{issueRows.length}</span>
      </div>
      {issueRows.length === 0 && <div className="border-b px-3 py-2 text-muted-foreground">No open issues on the board.</div>}
      {issueRows.map((row) => {
        const on = [row.level.questions && "Questions", row.level.comments && "Comments", row.level.pull_requests && "Pull requests"].filter((each) => each !== false);
        return (
          <div key={row.issue.id} className={line}>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <a href={row.issue.html_url} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
                  {row.name}
                </a>
                {row.own && <Badge variant="secondary">Own</Badge>}
              </div>
              <div className="truncate text-muted-foreground">
                {row.issue.id} · {on.length > 0 ? on.join(", ") : "No automation"}
              </div>
            </div>
            <button
              type="button"
              className={ROBOT}
              aria-label={`Automation for ${row.issue.id}`}
              onClick={() => setIssueDialog({ issue: row.issue, name: row.name, level: row.level, own: row.own })}
            >
              <Bot className="size-4" />
            </button>
          </div>
        );
      })}

      {repoDialog.length > 0 && <AutomationDialog repos={repoDialog} onClose={() => setRepoDialog([])} />}
      {newReposDialog && <AutomationDialog repos={[]} newRepos onClose={() => setNewReposDialog(false)} />}
      {boardDialog && <BoardAutomationDialog onClose={() => setBoardDialog(false)} />}
      {issueDialog !== null && (
        <IssueAutomationDialog
          id={issueDialog.issue.id}
          name={issueDialog.name}
          level={issueDialog.level}
          own={issueDialog.own}
          onClose={() => setIssueDialog(null)}
        />
      )}
    </div>
  );
}
