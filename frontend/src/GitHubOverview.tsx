/*
The GitHub tab's Overview (#/github/overview, the tab's start): everything that waits for you on GitHub, on one page,
from what the app already keeps live (nothing is read from GitHub just for it). Five sections, each with its name
(a link to its own page) and how many:
- Inbox: the drafts that wait for your decision, the oldest first (what it is, its title, which agent, how long ago).
  A click opens it in the Inbox.
- Notifications: the newest unread ones (why you got it, the repo and number, the title). A click opens an issue or
  PR in the thread pop-up on the Notifications page, anything else on GitHub.
- Your repositories: the ones whose checks failed on their default branch first, then the most recently pushed:
  checks, open issues and PRs, when last pushed. A click opens the repo's page.
- Pull requests: your PRs on other people's projects that are open, with how many have failed checks, changes asked
  for, approval, and checks waiting for a maintainer; the ones that need you (failed checks, changes asked for) are
  listed, a click opens one.
- Agents: how many are working, in a VM's queue and idle, and the working ones with what they do now. A click opens
  the agent's chat (on the Home tab).
Signed out, the GitHub sections say to sign in (a link to Account).
*/

import { Bot, CircleDot, GitPullRequest, Inbox as InboxIcon, Lock, BookMarked, Bell } from "lucide-react";

import { since, useNow } from "@/components/ui/job-progress";
import { useLive } from "@/live";
import { cn } from "@/lib/utils";

// How many rows a section lists.
const ROWS = 6;

const KIND_TEXT: Record<string, string> = { pr: "PR", comment: "Comment", question: "Question", taken: "Taken", report: "Report" };
const REASON_TEXT: Record<string, string> = {
  assign: "Assigned",
  author: "Author",
  ci_activity: "CI activity",
  comment: "Comment",
  manual: "Subscribed",
  mention: "Mention",
  review_requested: "Review requested",
  security_alert: "Security alert",
  state_change: "State change",
  subscribed: "Subscribed",
  team_mention: "Team mention",
};
const CHECKS_TEXT: Record<string, string> = { passed: "Checks passed", failed: "Checks failed", running: "Checks running", none: "No checks" };
const CHECKS_COLOR: Record<string, string> = { passed: "text-ok", failed: "text-destructive", running: "text-warn", none: "" };

export default function GitHubOverview() {
  const inbox = useLive("inbox");
  const notifications = useLive("notifications");
  const yourRepos = useLive("your_repos");
  const prs = useLive("prs");
  const agents = useLive("agents");
  const now = useNow();

  const agentNames: Record<string, string> = {};
  for (const agent of agents) {
    agentNames[agent.id] = agent.name;
  }

  const pending = inbox.filter((draft) => draft.status === "pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const unread = notifications.items.filter((item) => item.unread);
  const failing = yourRepos.repos.filter((repo) => repo.checks === "failed");
  const repoRows = [...failing, ...yourRepos.repos.filter((repo) => repo.checks !== "failed")].slice(0, ROWS);
  const openPRs = prs.items.filter((pr) => pr.state === "open");
  const prsFailed = openPRs.filter((pr) => pr.checks === "failed");
  const prsChanges = openPRs.filter((pr) => pr.review === "changes_requested");
  const prsApproved = openPRs.filter((pr) => pr.review === "approved");
  const prsWaiting = openPRs.filter((pr) => pr.checks === "waiting");
  const prsNeedYou = openPRs.filter((pr) => pr.checks === "failed" || pr.review === "changes_requested");
  const live = agents.filter((agent) => agent.archived_at === null);
  const working = live.filter((agent) => agent.busy);
  const queued = live.filter((agent) => agent.status === "in_queue");
  const idle = live.filter((agent) => !agent.busy && agent.status === "idle");
  const signedOut = yourRepos.login === null && yourRepos.error === null;

  const section = "rounded-md border";
  const head = "flex items-center gap-2 border-b px-3 py-1.5";
  const rowStyle = "flex min-w-0 items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent/50";
  const empty = "px-3 py-2 text-muted-foreground";

  return (
    <div className="h-full overflow-auto">
      <div className="grid max-w-6xl gap-4 p-4 lg:grid-cols-2">
        <section className={section}>
          <a href="#/inbox" className={cn(head, "hover:bg-accent/50")}>
            <InboxIcon className="size-4 text-muted-foreground" />
            <span className="font-medium">Inbox</span>
            <span className="ml-auto text-xs text-muted-foreground">{pending.length === 1 ? "1 draft waits for you" : `${pending.length} drafts wait for you`}</span>
          </a>
          {pending.length === 0 && <div className={empty}>Nothing waits for your decision.</div>}
          {pending.slice(0, ROWS).map((draft) => (
            <a key={draft.id} href={`#/inbox/${draft.id}`} className={rowStyle}>
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{KIND_TEXT[draft.kind] ?? draft.kind}</span>
              <span className="min-w-0 flex-1 truncate">{draft.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {agentNames[draft.agent] ?? draft.agent} · {since(draft.created_at, now)} ago
              </span>
            </a>
          ))}
        </section>

        <section className={section}>
          <a href="#/github/notifications" className={cn(head, "hover:bg-accent/50")}>
            <Bell className="size-4 text-muted-foreground" />
            <span className="font-medium">Notifications</span>
            <span className="ml-auto text-xs text-muted-foreground">{unread.length} unread</span>
          </a>
          {signedOut && (
            <div className={empty}>
              <a href="#/github/account" className="text-primary hover:underline">
                Sign in with GitHub
              </a>{" "}
              to see them.
            </div>
          )}
          {!signedOut && unread.length === 0 && <div className={empty}>No unread notifications.</div>}
          {unread.slice(0, ROWS).map((item) => (
            <a
              key={item.id}
              href={item.number !== null && (item.type === "Issue" || item.type === "PullRequest") ? `#/github/notifications?open=${encodeURIComponent(`${item.repo}#${item.number}`)}` : item.url}
              target={item.number !== null && (item.type === "Issue" || item.type === "PullRequest") ? undefined : "_blank"}
              rel="noreferrer"
              className={rowStyle}
            >
              <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{REASON_TEXT[item.reason] ?? item.reason}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.repo}
                {item.number !== null && ` #${item.number}`}
              </span>
            </a>
          ))}
        </section>

        <section className={section}>
          <div className={head}>
            <BookMarked className="size-4 text-muted-foreground" />
            <span className="font-medium">Your repositories</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {yourRepos.repos.length} · {failing.length === 1 ? "1 with failed checks" : `${failing.length} with failed checks`}
            </span>
          </div>
          {signedOut && (
            <div className={empty}>
              <a href="#/github/account" className="text-primary hover:underline">
                Sign in with GitHub
              </a>{" "}
              to see them.
            </div>
          )}
          {yourRepos.error !== null && <div className="px-3 py-2 text-destructive">Could not read them: {yourRepos.error}</div>}
          {repoRows.map((repo) => (
            <a key={repo.name} href={`#/github/repo?repo=${encodeURIComponent(repo.name)}`} className={rowStyle}>
              {repo.private ? <Lock className="size-3.5 shrink-0 text-muted-foreground" /> : <BookMarked className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{repo.name}</span>
              <span className={cn("shrink-0 text-xs", CHECKS_COLOR[repo.checks])}>{CHECKS_TEXT[repo.checks]}</span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="Open issues">
                <CircleDot className="size-3" /> {repo.open_issues}
              </span>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="Open pull requests">
                <GitPullRequest className="size-3" /> {repo.open_prs}
              </span>
              <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{repo.pushed_at !== null ? `${since(repo.pushed_at, now)} ago` : ""}</span>
            </a>
          ))}
        </section>

        <section className={section}>
          <a href="#/github/pulls" className={cn(head, "hover:bg-accent/50")}>
            <GitPullRequest className="size-4 text-muted-foreground" />
            <span className="font-medium">Pull requests</span>
            <span className="ml-auto text-xs text-muted-foreground">{openPRs.length} open on other projects</span>
          </a>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <span className={cn(prsFailed.length > 0 && "text-destructive")}>{prsFailed.length} checks failed</span>
            <span className={cn(prsChanges.length > 0 && "text-warn")}>{prsChanges.length} changes asked for</span>
            <span className={cn(prsApproved.length > 0 && "text-ok")}>{prsApproved.length} approved</span>
            <span>{prsWaiting.length} waiting for a maintainer to run checks</span>
          </div>
          {prsNeedYou.length === 0 && <div className={empty}>None has failed checks or changes asked for.</div>}
          {prsNeedYou.slice(0, ROWS).map((pr) => (
            <a key={pr.id} href={`#/github/pulls?open=${encodeURIComponent(pr.id)}`} className={rowStyle}>
              <span className="min-w-0 flex-1 truncate">{pr.title}</span>
              <span className={cn("shrink-0 text-xs", pr.checks === "failed" ? "text-destructive" : "text-warn")}>
                {pr.checks === "failed" ? "Checks failed" : "Changes asked for"}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {pr.repo} #{pr.number}
              </span>
            </a>
          ))}
        </section>

        <section className={cn(section, "lg:col-span-2")}>
          <a href="#/agents" className={cn(head, "hover:bg-accent/50")}>
            <Bot className="size-4 text-muted-foreground" />
            <span className="font-medium">Agents</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {working.length} working · {queued.length} in a VM's queue · {idle.length} idle
            </span>
          </a>
          {working.length === 0 && <div className={empty}>No agent is working now.</div>}
          {working.map((agent) => (
            <a key={agent.id} href={`#/agents/${agent.id}`} className={rowStyle}>
              <span className="w-40 shrink-0 truncate font-medium">{agent.name}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{agent.activity}</span>
              {agent.vm !== null && <span className="shrink-0 text-xs text-muted-foreground">{agent.vm}</span>}
            </a>
          ))}
        </section>
      </div>
    </div>
  );
}
