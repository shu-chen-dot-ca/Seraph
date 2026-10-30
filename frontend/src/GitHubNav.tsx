/*
The GitHub tab's left list: App shows it instead of the sidebar tree on the GitHub tab's pages (#/inbox, #/github...),
with the same look as the sidebar (Sidebar.tsx). Every line is a link to a page; the open one is marked:
- Inbox (Inbox.tsx): drafts the agents want to send, with how many wait for your decision (a filled pill, like
  unread mail).
- Pull requests and Issues (GitHub.tsx): your PRs and issues on other people's projects, each with how many are open.
- Account, pinned at the bottom: your GitHub account, the one Approve sends as (GitHub.tsx's Account), with who you
  are signed in as, or "Not signed in".
Counts come straight from the live store, so the list updates itself.
*/

import { CircleDot, CircleUser, GitPullRequest, Inbox } from "lucide-react";
import { useEffect, useState } from "react";

import { api, useLive, type GithubAccountStatus } from "@/live";
import { cn } from "@/lib/utils";

export default function GitHubNav(props: { page: string; section: string; repo: string | null }) {
  const inbox = useLive("inbox");
  const prs = useLive("prs");
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
