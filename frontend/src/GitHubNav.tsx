/*
The GitHub tab's left list: App shows it instead of the sidebar tree on the GitHub tab's pages (#/inbox, #/github...),
with the same look as the sidebar (Sidebar.tsx). Every line is a link to a page; the open one is marked:
- Inbox (Inbox.tsx): drafts the agents want to send, with how many wait for your decision (a filled pill, like
  unread mail).
- Pull requests and Issues (GitHub.tsx): your PRs and issues on other people's projects, each with how many are open.
- Your repositories: every repo you can push to, public and private (a lock), most recently pushed first, with how
  many issues and PRs are open (hover for each, and whether its checks passed; the icon is red when they failed).
  A click opens its page (Repository.tsx). While you aren't signed in, a line says to sign in for them.
- Starred: the repos you starred (not your own; those stay under Your repositories), most recently starred first, a
  lock on private ones (hover for open issues and PRs). A click opens its page, where Star and Unstar are; a repo you
  unstar leaves this list at once.
- Account, pinned at the bottom: your GitHub account, the one Approve sends as (GitHub.tsx's Account), with who you
  are signed in as, or "Not signed in".
Counts come straight from the live store, so the list updates itself.
*/

import { BookMarked, CircleDot, CircleUser, GitPullRequest, Inbox, Lock } from "lucide-react";
import { useEffect, useState } from "react";

import { api, useLive, type GithubAccountStatus } from "@/live";
import { cn } from "@/lib/utils";

export default function GitHubNav(props: { page: string; section: string; repo: string | null }) {
  const inbox = useLive("inbox");
  const prs = useLive("prs");
  const yourRepos = useLive("your_repos");
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);

  // Who the account is: at first, and again when you sign in or out (the Account page tells).
  useEffect(() => {
    let stopped = false;
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then((data) => {
          if (!stopped) {
            setAccount(data);
          }
        })
        .catch(() => {
          // The Account page says why.
        });
    }
    load();
    window.addEventListener("github-account", load);
    return () => {
      stopped = true;
      window.removeEventListener("github-account", load);
    };
  }, []);

  const pending = inbox.filter((draft) => draft.status === "pending").length;
  const openPRs = prs.items.filter((pr) => pr.state === "open").length;
  const openIssues = prs.issues.filter((issue) => issue.state === "open").length;

  // The same rows as the sidebar's (Sidebar.tsx).
  const row = "flex h-8 items-center gap-2 rounded-md px-2 font-medium hover:bg-sidebar-accent hover:text-foreground";
  const selected = "bg-selected text-foreground ring-1 ring-primary/15 ring-inset hover:bg-selected [&>a>svg]:text-primary [&>svg]:text-primary";

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground select-none">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <a href="#/inbox" className={cn(row, "pl-6", props.page === "inbox" && selected)}>
          <Inbox className="size-4 text-muted-foreground" />
          Inbox
          {/* Drafts waiting on the user hold an agent up, so they get a filled pill, like unread mail. */}
          <span
            className={cn(
              "ml-auto tabular-nums",
              pending > 0 ? "min-w-4.5 rounded-full bg-primary px-1.5 text-center text-xs leading-4.5 font-medium text-primary-foreground" : "text-muted-foreground",
            )}
          >
            {pending}
          </span>
        </a>

        <a href="#/github/pulls" className={cn(row, "pl-6", props.page === "github" && props.section === "pulls" && props.repo === null && selected)}>
          <GitPullRequest className="size-4 text-muted-foreground" />
          Pull requests
          <span className="ml-auto text-muted-foreground tabular-nums">{openPRs}</span>
        </a>

        <a href="#/github/issues" className={cn(row, "pl-6", props.page === "github" && props.section === "issues" && props.repo === null && selected)}>
          <CircleDot className="size-4 text-muted-foreground" />
          Issues
          <span className="ml-auto text-muted-foreground tabular-nums">{openIssues}</span>
        </a>

        <div className="mx-1 my-2 border-t" />
        <div className="pr-2 pb-1 pl-6 text-xs font-medium text-muted-foreground">Your repositories</div>
        {account !== null && !account.connected && (
          <a href="#/github/account" className="block pr-2 pb-1 pl-6 text-xs text-muted-foreground hover:text-foreground">
            Sign in to see them
          </a>
        )}
        {yourRepos.repos.map((repo) => (
          <a
            key={repo.name}
            href={`#/github/repo?repo=${encodeURIComponent(repo.name)}`}
            className={cn(row, "pl-6", props.page === "github" && props.section === "repo" && props.repo === repo.name && selected)}
            title={`${repo.name}${repo.private ? " (private)" : ""}: ${repo.open_issues} open ${repo.open_issues === 1 ? "issue" : "issues"}, ${repo.open_prs} open ${repo.open_prs === 1 ? "pull request" : "pull requests"}${repo.checks === "failed" ? ". Checks failed on " + repo.default_branch : ""}`}
          >
            {repo.private ? (
              <Lock className={cn("size-4 shrink-0 text-muted-foreground", repo.checks === "failed" && "text-destructive")} />
            ) : (
              <BookMarked className={cn("size-4 shrink-0 text-muted-foreground", repo.checks === "failed" && "text-destructive")} />
            )}
            <span className="truncate">{repo.name}</span>
            {repo.open_issues + repo.open_prs > 0 && <span className="ml-auto text-muted-foreground tabular-nums">{repo.open_issues + repo.open_prs}</span>}
          </a>
        ))}

        {yourRepos.starred.length > 0 && (
          <>
            <div className="mx-1 my-2 border-t" />
            <div className="pr-2 pb-1 pl-6 text-xs font-medium text-muted-foreground">Starred</div>
            {yourRepos.starred.map((repo) => (
              <a
                key={repo.name}
                href={`#/github/repo?repo=${encodeURIComponent(repo.name)}`}
                className={cn(row, "pl-6", props.page === "github" && props.section === "repo" && props.repo === repo.name && selected)}
                title={`${repo.name}${repo.private ? " (private)" : ""}: ${repo.open_issues} open ${repo.open_issues === 1 ? "issue" : "issues"}, ${repo.open_prs} open ${repo.open_prs === 1 ? "pull request" : "pull requests"}`}
              >
                {repo.private ? <Lock className="size-4 shrink-0 text-muted-foreground" /> : <BookMarked className="size-4 shrink-0 text-muted-foreground" />}
                <span className="truncate">{repo.name}</span>
              </a>
            ))}
          </>
        )}
      </div>

      <div className="border-t p-2">
        <a href="#/github/account" className={cn(row, "pl-6", props.page === "github" && props.section === "account" && selected)}>
          <CircleUser className="size-4 shrink-0 text-muted-foreground" />
          Account
          <span className="ml-auto truncate text-muted-foreground">
            {account === null ? "" : account.connected ? `@${account.login}` : "Not signed in"}
          </span>
        </a>
      </div>
    </nav>
  );
}
