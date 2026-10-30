/*
The GitHub tab's Pull requests, Issues and Account pages (#/github/pulls, #/github/issues, #/github/account; #/github
is Pull requests). Its left list is GitHubNav.tsx.

Pull requests and Issues: your PRs and issues on other people's projects, as GitHub lists them
(github_searcher/pr_tracking.py), the newest change first. PRs: every PR the Inbox's Approve sent, the other PRs you
opened, and PRs you commented on. Issues: the ones you opened and the ones you commented on. Both are read from GitHub
every few minutes on their own (and right after Approve sends a PR); the ones from outside the app need you signed in
(Account), so the app knows who you are.
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
(github_searcher/github_account.py). Sign in with GitHub, like on any website: this tab goes to GitHub's page, which
asks whether Seraph may act as you (about all you can do on github.com: your repos, public and private, workflows,
organizations, gists, notifications, your profile), and after Authorize comes back here signed in, with a message
"Signed in as @login" (or, in red on top, why not, e.g. after Cancel there). With more than one account on
github.com, GitHub asks which one first. Signed in: "Signed in as @login", what it may do, and Sign out, which forgets
it (Approve then sends nothing again). Nothing about the sign-in ever comes back to the browser but who it is.
The first time, the page shows how to register the app on GitHub, once: a link to GitHub's form for a new OAuth app,
the three values to fill in (name, homepage, callback address; click one to select it), then the Client ID and client
secret to paste here and Save. Change app settings shows that again. Use a token instead (both views) takes a
classic token pasted by hand, with Sign in and Cancel, for an organization that blocks apps it hasn't approved;
"make one" opens GitHub's new-token page with the same permissions ticked. Signing in or out (and saving the app
settings) tells the header, the Inbox and the left list (a "github-account" window event), which show who it sends as. Below: your forks the app sends PRs from.
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
  const [useToken, setUseToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [savingApp, setSavingApp] = useState(false);
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

  // Back from GitHub's sign-in page (the callback in backend/github_account_api.py): what came of it, said once.
  useEffect(() => {
    const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const signedIn = query.get("signed_in");
    const error = query.get("error");
    if (signedIn === null && error === null) {
      return;
    }
    if (signedIn !== null) {
      toast.success(`Signed in as @${signedIn}. Approve in the Inbox now sends PRs and comments as this account.`);
      // Your PRs and issues from outside the app show up now too.
      api("/api/github/refresh", { method: "POST" }).catch(() => {});
    }
    if (error !== null) {
      setAccountError(error);
    }
    window.location.replace("#/github/account");
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
      setUseToken(false);
      window.dispatchEvent(new Event("github-account"));
      toast.success(`Signed in as @${data.login}. Approve in the Inbox now sends PRs and comments as this account.`);
      // Your PRs and issues from outside the app show up now too.
      api("/api/github/refresh", { method: "POST" }).catch(() => {});
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
    setConnecting(false);
  }

  async function signIn() {
    setSigningIn(true);
    setAccountError("");
    try {
      const data = await api<{ url: string }>("/api/github_account/sign_in", { method: "POST" });
      // GitHub's page, in this tab. It comes back to this page when you are done there.
      window.location.href = data.url;
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
      setSigningIn(false);
    }
  }

  async function saveApp() {
    setSavingApp(true);
    setAccountError("");
    try {
      setAccount(await api<GithubAccountStatus>("/api/github_account/app", { method: "PUT", body: { client_id: clientId, client_secret: clientSecret } }));
      setClientId("");
      setClientSecret("");
      setSettingUp(false);
      // The header's Sign in goes straight to GitHub now.
      window.dispatchEvent(new Event("github-account"));
      toast.success("Saved. Now sign in with GitHub.");
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
    setSavingApp(false);
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
            No pull requests yet. A PR you approve in the Inbox shows here once it is on GitHub; signed in with GitHub (Account), so do the
            ones you opened or commented on by hand.
          </div>
        )}
        {props.section === "issues" && loaded && total === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No issues yet. Signed in with GitHub (Account), the issues you opened or commented on show here.</div>
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
              {account !== null && account.connected && (
                <div className="flex items-center gap-2">
                  <span>
                    Signed in as{" "}
                    <a href={`https://github.com/${account.login}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      @{account.login}
                    </a>
                  </span>
                  <span className="text-xs text-muted-foreground">{(account.scopes ?? []).join(", ")}</span>
                  <div className="ml-auto">
                    <Button variant="outline" size="sm" onClick={disconnectAccount}>
                      Sign out
                    </Button>
                  </div>
                </div>
              )}
              {account !== null && !account.connected && account.can_sign_in && !settingUp && !useToken && (
                <div className="space-y-2">
                  <Button onClick={signIn} disabled={signingIn}>
                    {signingIn && <Loader2 className="animate-spin" />}
                    {!signingIn && (
                      // GitHub's mark (lucide has no brand icons).
                      <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                    )}
                    Sign in with GitHub
                  </Button>
                  <div className="flex items-center gap-3 text-xs">
                    <button type="button" className="text-primary hover:underline" onClick={() => setUseToken(true)}>
                      Use a token instead
                    </button>
                    <button type="button" className="text-primary hover:underline" onClick={() => setSettingUp(true)}>
                      Change app settings
                    </button>
                  </div>
                </div>
              )}
              {account !== null && !account.connected && (!account.can_sign_in || settingUp) && !useToken && (
                <div className="space-y-3">
                  <p>To sign in with GitHub, register this app on GitHub once:</p>
                  <ol className="list-decimal space-y-2 pl-5">
                    <li>
                      Open{" "}
                      <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        GitHub's form for a new OAuth app
                      </a>
                      , fill it in with these and click Register application:
                      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                        <span className="text-muted-foreground">Application name</span>
                        <span className="font-mono select-all">Seraph</span>
                        <span className="text-muted-foreground">Homepage URL</span>
                        <span className="font-mono break-all select-all">{window.location.origin}</span>
                        <span className="text-muted-foreground">Authorization callback URL</span>
                        <span className="font-mono break-all select-all">{`${window.location.origin}/api/github_account/callback`}</span>
                      </div>
                    </li>
                    <li>On the app's page, copy the Client ID. Then click Generate a new client secret and copy that too.</li>
                    <li>Paste both here and Save.</li>
                  </ol>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="min-w-0 flex-1 font-mono text-xs"
                      placeholder="Client ID"
                      autoComplete="off"
                      spellCheck={false}
                      value={clientId}
                      onChange={(event) => setClientId(event.target.value)}
                    />
                    <Input
                      className="min-w-0 flex-1 font-mono text-xs"
                      placeholder="Client secret"
                      type="password"
                      // Sherpa never reads it.
                      data-secret
                      autoComplete="off"
                      spellCheck={false}
                      value={clientSecret}
                      onChange={(event) => setClientSecret(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && clientId.trim() !== "" && clientSecret.trim() !== "" && !savingApp) {
                          event.preventDefault();
                          saveApp();
                        }
                      }}
                    />
                    <Button size="sm" onClick={saveApp} disabled={clientId.trim() === "" || clientSecret.trim() === "" || savingApp}>
                      {savingApp && <Loader2 className="animate-spin" />}
                      Save
                    </Button>
                    {settingUp && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSettingUp(false);
                          setClientId("");
                          setClientSecret("");
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => setUseToken(true)}>
                    Use a token instead
                  </button>
                </div>
              )}
              {account !== null && !account.connected && useToken && (
                <div className="space-y-2">
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
                      Sign in
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setUseToken(false);
                        setToken("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    For an organization that blocks apps it hasn't approved. Paste a classic token (
                    <a
                      href="https://github.com/settings/tokens/new?scopes=repo,workflow,read:org,gist,notifications,user&description=Seraph"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      make one
                    </a>
                    ): fine-grained tokens can't open PRs on projects you don't own.
                  </p>
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Approve in the Inbox sends PRs and comments as this account, after you confirm, and so does Comment on a pull request or issue. It
                stays on this computer: agents, Sherpa and searches never use it.
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
