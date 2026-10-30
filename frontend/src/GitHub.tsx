/*
The GitHub tab's Pull requests, Issues and Account pages (#/github/pulls, #/github/issues, #/github/account; #/github
is Pull requests). Its left list is GitHubNav.tsx.

Pull requests and Issues: your PRs and issues on other people's projects, as GitHub lists them
(github_searcher/pr_tracking.py), the newest change first. PRs: every PR the Inbox's Approve sent, the other PRs you
opened, and PRs you commented on. Issues: the ones you opened and the ones you commented on. Both are read from GitHub
every few minutes on their own (and right after Approve sends a PR); the ones from outside the app need your account
connected (Account), so the app knows who you are.
The bar on top: tabs Open and Closed (merged PRs are under Closed) with how many; when one repo is shown
(#/github/pulls?repo=owner/name), a chip with its name and an X to show every repo again; a box that
filters by title, repo and number; on the right when they were last read from GitHub and Check now. A line under it
says why, when the last search failed.
Each PR row, like GitHub's own list: the state (open, draft, merged, closed), the title, the repo and number, when it
last changed, and in plain words where it stands:
- Checks: "Waiting for a maintainer to approve the checks" (GitHub runs nothing for a first-time contributor's
  PR until a maintainer clicks approve, so this is normal and only needs waiting), running, passed, failed, or none.
- Review: approved, changes asked for, reviewed with comments, or not reviewed yet.
- How many comments and who wrote the latest (a maintainer, a bot, you), and the issue it fixes, open or closed.
  "You commented" when it is someone else's PR you commented on.
Each issue row: the state (open, closed as completed, closed as not planned), the title, the repo and number, its
labels, "You opened it" or "You commented", how many comments and who wrote the latest, and when it last changed.
A click on a row opens it in a pop-up (ThreadDialog.tsx; the address gets open=owner/name%23n, keeping the repo and
tab): all of it as on GitHub, where you comment. The X, Esc or a click outside closes it, back to the list.

Account: your GitHub account, the one Approve in the Inbox sends PRs and comments as, and Comment in the pop-up
(github_searcher/github_account.py). Paste a classic token with the public_repo scope and Connect: the backend
checks it with GitHub (a fine-grained token, or one without that scope, is turned down with why) and keeps it on
this computer. It never comes back to the browser: GET /api/github_account says only who it is (Connected as
@login) and the token's scopes. Change token pastes a new one; Disconnect forgets it, and Approve then sends
nothing again. "make one" opens GitHub's new-token page with public_repo ticked. Both tell the Inbox and the left
list (a "github-account" window event), which show who it sends as. Below: your forks the app sends PRs from.
*/

import { CircleCheck, CircleDot, CircleSlash, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import ThreadDialog from "@/ThreadDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { since, useNow } from "@/components/ui/job-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type GithubAccountStatus, type GithubIssue, type TrackedPR } from "@/live";
import { cn } from "@/lib/utils";

const CHECKS_TEXT: Record<string, string> = {
  waiting: "Waiting for a maintainer to approve the checks",
  running: "Checks running",
  passed: "Checks passed",
  failed: "Checks failed",
  none: "No checks",
};
const CHECKS_COLOR: Record<string, string> = { waiting: "text-warn", running: "text-warn", passed: "text-ok", failed: "text-destructive", none: "" };

const REVIEW_TEXT: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Changes asked for",
  commented: "Reviewed with comments",
  none: "Not reviewed yet",
};
const REVIEW_COLOR: Record<string, string> = { approved: "text-ok", changes_requested: "text-warn", commented: "", none: "" };

// Who someone is, in plain words, from GitHub's role for them. you: your login ("" until the account is known).
function who(login: string, role: string, item: TrackedPR | GithubIssue, you: string): string {
  if (login === you || (item.relation === "author" && login === item.author)) {
    return "you";
  }
  if (role === "BOT") {
    return `${login} (bot)`;
  }
  if (role === "OWNER" || role === "MEMBER" || role === "COLLABORATOR") {
    return `${login} (maintainer)`;
  }
  return login;
}

export default function GitHub(props: { section: string; repo: string | null; state: string; open: string | null }) {
  const prs = useLive("prs");
  const inbox = useLive("inbox");
  const loaded = useLoaded("prs");
  const [filter, setFilter] = useState("");
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  const [token, setToken] = useState("");
  const [changingToken, setChangingToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [accountError, setAccountError] = useState("");
  const now = useNow();

  // Who the account is: at first, and again when it is connected or disconnected. The token itself never comes back.
  useEffect(() => {
    let stopped = false;
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then((data) => {
          if (!stopped) {
            setAccount(data);
          }
        })
        .catch((err) => {
          if (!stopped) {
            setAccountError(`Could not load the GitHub account: ${err instanceof Error ? err.message : err}`);
          }
        });
    }
    load();
    window.addEventListener("github-account", load);
    return () => {
      stopped = true;
      window.removeEventListener("github-account", load);
    };
  }, []);

  const you = account?.login ?? "";
  // The forks Approve sent PRs from, once each.
  const forks: string[] = [];
  for (const draft of inbox) {
    if (draft.sent !== null && draft.sent.fork !== undefined && !forks.includes(draft.sent.fork)) {
      forks.push(draft.sent.fork);
    }
  }

  // This section's PRs or issues, of the one repo when it shows one. The tabs count those; the rows are the tab's
  // ones (Closed has the merged PRs too) that match the filter.
  const repoPRs = prs.items.filter((pr) => props.repo === null || pr.repo === props.repo);
  const repoIssues = prs.issues.filter((issue) => props.repo === null || issue.repo === props.repo);
  let openCount = repoPRs.filter((pr) => pr.state === "open").length;
  let closedCount = repoPRs.length - openCount;
  if (props.section === "issues") {
    openCount = repoIssues.filter((issue) => issue.state === "open").length;
    closedCount = repoIssues.length - openCount;
  }
  const needle = filter.trim().toLowerCase();
  const prRows = repoPRs.filter((pr) => (pr.state === "open") === (props.state === "open") && `${pr.id} ${pr.title}`.toLowerCase().includes(needle));
  const issueRows = repoIssues.filter((issue) => (issue.state === "open") === (props.state === "open") && `${issue.id} ${issue.title}`.toLowerCase().includes(needle));
  const isList = props.section === "pulls" || props.section === "issues";
  const total = props.section === "pulls" ? prs.items.length : prs.issues.length;
  const shown = props.section === "pulls" ? prRows.length : issueRows.length;

  // Addresses: this section's list (with its repo and the Closed tab when they are on), and the same with one change.
  const sectionHash = `#/github/${props.section}`;
  const repoQuery = props.repo !== null ? `repo=${encodeURIComponent(props.repo)}` : "";
  const stateQuery = props.state === "closed" ? "state=closed" : "";
  const listQuery = [repoQuery, stateQuery].filter((part) => part !== "").join("&");
  const listHash = listQuery !== "" ? `${sectionHash}?${listQuery}` : sectionHash;
  const openTabHash = repoQuery !== "" ? `${sectionHash}?${repoQuery}` : sectionHash;
  const closedTabHash = repoQuery !== "" ? `${sectionHash}?${repoQuery}&state=closed` : `${sectionHash}?state=closed`;
  const allReposHash = stateQuery !== "" ? `${sectionHash}?${stateQuery}` : sectionHash;
  const openPrefix = listQuery !== "" ? `${listHash}&open=` : `${listHash}?open=`;

  async function checkNow() {
    try {
      await api("/api/github/refresh", { method: "POST" });
    } catch (err) {
      toast.error(`Could not check GitHub: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function connectAccount() {
    setConnecting(true);
    setAccountError("");
    try {
      const data = await api<GithubAccountStatus>("/api/github_account", { method: "PUT", body: { token: token } });
      setAccount(data);
      setToken("");
      setChangingToken(false);
      window.dispatchEvent(new Event("github-account"));
      toast.success(`Connected as @${data.login}. Approve in the Inbox now sends PRs and comments as this account.`);
      // Your PRs and issues from outside the app show up now too.
      api("/api/github/refresh", { method: "POST" }).catch(() => {});
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
    setConnecting(false);
  }

  async function disconnectAccount() {
    setAccountError("");
    try {
      setAccount(await api<GithubAccountStatus>("/api/github_account", { method: "DELETE" }));
      window.dispatchEvent(new Event("github-account"));
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex h-full flex-col">
      {isList && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <Tabs value={props.state} onValueChange={(value) => (window.location.hash = value === "closed" ? closedTabHash : openTabHash)}>
            <TabsList>
              <TabsTrigger value="open" className="px-2.5">
                Open <span className="text-xs text-muted-foreground tabular-nums">{openCount}</span>
              </TabsTrigger>
              <TabsTrigger value="closed" className="px-2.5">
                Closed <span className="text-xs text-muted-foreground tabular-nums">{closedCount}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {props.repo !== null && (
            <span className="flex items-center gap-1 rounded-md border border-primary pl-2 text-primary">
              {props.repo}
              <Button variant="ghost" size="icon-xs" aria-label="Show every repo" title="Show every repo" onClick={() => (window.location.hash = allReposHash)}>
                <X />
              </Button>
            </span>
          )}
          <Input
            className="w-52"
            placeholder={props.section === "pulls" ? "Filter pull requests" : "Filter issues"}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <span className="ml-auto text-xs text-muted-foreground">{prs.checked_at !== null ? `Checked ${since(prs.checked_at, now)} ago` : ""}</span>
          <Button size="sm" variant="outline" disabled={prs.refreshing} onClick={checkNow}>
            {prs.refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check now
          </Button>
        </div>
      )}
      {isList && prs.error !== null && (
        <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not search GitHub for your pull requests and issues: {prs.error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {isList && !loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {props.section === "pulls" && loaded && total === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            No pull requests yet. A PR you approve in the Inbox shows here once it is on GitHub; with your account connected (Account), so do the
            ones you opened or commented on by hand.
          </div>
        )}
        {props.section === "issues" && loaded && total === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No issues yet. With your account connected (Account), the issues you opened or commented on show here.</div>
        )}
        {isList && loaded && total > 0 && shown === 0 && (
          <div className="px-3 py-2 text-muted-foreground">{needle !== "" ? "Nothing matches the filter." : "None here."}</div>
        )}

        {props.section === "pulls" &&
          prRows.map((pr) => {
            let icon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
            if (pr.state === "open" && pr.draft) {
              icon = <GitPullRequestDraft className="size-4 shrink-0 text-muted-foreground" />;
            } else if (pr.state === "merged") {
              icon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
            } else if (pr.state === "closed") {
              icon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
            }
            return (
              <div
                key={pr.id}
                className={cn("flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50", pr.id === props.open && "bg-selected hover:bg-selected")}
                onClick={() => (window.location.hash = openPrefix + encodeURIComponent(pr.id))}
              >
                <span className="mt-px">{icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{pr.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {pr.state === "merged" && pr.closed_at !== null ? `merged ${since(pr.closed_at, now)} ago` : `updated ${since(pr.updated_at, now)} ago`}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="text-foreground">
                      {pr.repo} #{pr.number}
                    </span>
                    {pr.relation === "commented" && <span>You commented</span>}
                    {pr.state === "open" && <span className={CHECKS_COLOR[pr.checks]}>{CHECKS_TEXT[pr.checks]}</span>}
                    {pr.state === "open" && <span className={REVIEW_COLOR[pr.review]}>{REVIEW_TEXT[pr.review]}</span>}
                    {pr.state === "merged" && pr.merged_by !== null && <span className="text-ok">Merged by {pr.merged_by}</span>}
                    {pr.state === "closed" && <span className="text-destructive">Closed without merging</span>}
                    <span>
                      {pr.comments === 1 ? "1 comment" : `${pr.comments} comments`}
                      {pr.last_comment !== null && `, the latest by ${who(pr.last_comment.login, pr.last_comment.role, pr, you)} ${since(pr.last_comment.at, now)} ago`}
                    </span>
                    {pr.issues.map((issue) => (
                      <span key={issue.number}>
                        Fixes #{issue.number}, {issue.state === "open" ? "still open" : "closed"}
                      </span>
                    ))}
                    {pr.error !== null && <span className="text-destructive">Last check failed</span>}
                  </div>
                </div>
              </div>
            );
          })}

        {props.section === "issues" &&
          issueRows.map((issue) => {
            let icon = <CircleDot className="size-4 shrink-0 text-ok" />;
            let stateText = "Open";
            if (issue.state === "closed" && (issue.reason === "not_planned" || issue.reason === "duplicate")) {
              icon = <CircleSlash className="size-4 shrink-0 text-muted-foreground" />;
              stateText = issue.reason === "duplicate" ? "Closed as a duplicate" : "Closed as not planned";
            } else if (issue.state === "closed") {
              icon = <CircleCheck className="size-4 shrink-0 text-violet-500" />;
              stateText = "Closed as completed";
            }
            return (
              <div
                key={issue.id}
                className={cn("flex cursor-pointer items-start gap-2 border-b px-3 py-1.5 hover:bg-accent/50", issue.id === props.open && "bg-selected hover:bg-selected")}
                onClick={() => (window.location.hash = openPrefix + encodeURIComponent(issue.id))}
              >
                <span className="mt-px" title={stateText}>
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{issue.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {issue.state === "closed" && issue.closed_at !== null ? `closed ${since(issue.closed_at, now)} ago` : `updated ${since(issue.updated_at, now)} ago`}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="text-foreground">
                      {issue.repo} #{issue.number}
                    </span>
                    {issue.labels.map((label) => (
                      <Badge key={label} variant="secondary" className="py-0">
                        {label}
                      </Badge>
                    ))}
                    <span>{issue.relation === "author" ? "You opened it" : "You commented"}</span>
                    <span>
                      {issue.comments === 1 ? "1 comment" : `${issue.comments} comments`}
                      {issue.last_comment !== null && `, the latest by ${who(issue.last_comment.login, issue.last_comment.role, issue, you)} ${since(issue.last_comment.at, now)} ago`}
                    </span>
                    {issue.error !== null && <span className="text-destructive">Last check failed</span>}
                  </div>
                </div>
              </div>
            );
          })}

        {props.section === "account" && (
          <div className="max-w-xl space-y-4 p-4">
            <section>
              <div className="mb-2 font-medium">Your GitHub account</div>
              {accountError !== "" && <p className="mb-2 border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{accountError}</p>}
              {account === null && accountError === "" && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </div>
              )}
              {account !== null && account.connected && !changingToken && (
                <div className="flex items-center gap-2">
                  <span>
                    Connected as{" "}
                    <a href={`https://github.com/${account.login}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      @{account.login}
                    </a>
                  </span>
                  <span className="text-xs text-muted-foreground">{(account.scopes ?? []).join(", ")}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => setChangingToken(true)}>
                      Change token
                    </Button>
                    <Button variant="ghost" size="sm" onClick={disconnectAccount}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              )}
              {account !== null && (!account.connected || changingToken) && (
                <div className="flex items-center gap-1.5">
                  <Input
                    className="min-w-0 flex-1 font-mono text-xs"
                    placeholder="ghp_…"
                    type="password"
                    // Sherpa never reads it.
                    data-secret
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && token.trim() !== "" && !connecting) {
                        event.preventDefault();
                        connectAccount();
                      }
                    }}
                  />
                  <Button size="sm" onClick={connectAccount} disabled={token.trim() === "" || connecting}>
                    {connecting && <Loader2 className="animate-spin" />}
                    Connect
                  </Button>
                  {changingToken && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setChangingToken(false);
                        setToken("");
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              )}
              {account !== null && account.connected && !changingToken && (account.scopes ?? []).includes("repo") && (
                <p className="mt-1 text-xs text-muted-foreground">This token can also write to your private repos; public_repo alone is enough.</p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Approve in the Inbox sends PRs and comments as this account, after you confirm, and so does Comment on a pull request or issue. It
                needs a classic token with the public_repo scope (
                <a
                  href="https://github.com/settings/tokens/new?scopes=public_repo&description=Seraph"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  make one
                </a>
                ): fine-grained tokens can't open PRs on projects you don't own. The token stays on this computer; agents, Sherpa and searches never
                use it.
              </p>
            </section>
            {forks.length > 0 && (
              <section>
                <div className="mb-2 font-medium">Your forks</div>
                <p className="mb-1 text-xs text-muted-foreground">Where the app put your PRs' branches and pictures.</p>
                {forks.map((fork) => (
                  <div key={fork}>
                    <a href={`https://github.com/${fork}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                      {fork} <ExternalLink className="size-3" />
                    </a>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>

      {/* The PR or issue a click opened (open= in the address); closing it goes back to the list. */}
      <ThreadDialog id={props.open} onClose={() => (window.location.hash = listHash)} />
    </div>
  );
}
