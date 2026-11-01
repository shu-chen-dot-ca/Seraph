/*
The Workspace tab's Home (#/home, #/home?repo=owner/name): your repositories, laid out like a chat app's list of chats.
Left: one card per repo, in a column: your repositories (every repo you can push to, public and private, most
recently pushed first), then under Starred the repos you starred. A card: a lock when private, owner/name, when it was
last pushed, its description (two lines at most), whether its checks passed on the default branch, its open issues and
PRs, and its stars. The open one is marked. Signed out, a line says to sign in (Account, on the GitHub tab).
Right: the open repo's page, like on GitHub (Repository.tsx, the same page as on the GitHub tab, with live): Agents
(every agent working with the repo and their chats, RepoAgents.tsx; a repo opens on it), Code (its files and README),
Issues, Pull requests, Commits and Actions, Star, New issue and Refresh. Its tabs and pop-ups keep this address (#/home?repo=owner/name&tab=...; no
tab is Agents). A repo opened before opens at once: its tabs are kept on this
computer and read from GitHub again every 15 minutes. With none open, a line says to pick one.
On a narrow screen (a phone) one side shows at a time: the cards, or the open repo with Repositories (back to the
cards) above it.
The list comes from the live store (github_searcher/your_repositories.py reads it every minute), so it updates itself.
*/

import { BookMarked, ChevronLeft, CircleCheck, CircleDashed, CircleDot, CircleX, GitPullRequest, Lock, Star } from "lucide-react";
import { Fragment } from "react";

import Repository from "@/Repository";
import { since, useNow } from "@/components/ui/job-progress";
import { useLive } from "@/live";
import { cn } from "@/lib/utils";

export default function Home(props: { repo: string | null; tab: string; state: string; open: string | null }) {
  const yourRepos = useLive("your_repos");
  const now = useNow();

  const cards = [...yourRepos.repos, ...yourRepos.starred];
  const signedOut = yourRepos.login === null && yourRepos.error === null;

  return (
    <div className="flex h-full">
      <div className={cn("flex w-80 shrink-0 flex-col border-r max-md:w-full max-md:border-r-0", props.repo !== null && "max-md:hidden")}>
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <h1 className="font-semibold">Repositories</h1>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{yourRepos.repos.length}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {signedOut && (
            <div className="px-1 py-2 text-muted-foreground">
              <a href="#/github/account" className="text-primary hover:underline">
                Sign in with GitHub
              </a>{" "}
              to see your repositories.
            </div>
          )}
          {yourRepos.error !== null && <div className="px-1 py-2 text-destructive">Could not read them: {yourRepos.error}</div>}
          {!signedOut && yourRepos.error === null && cards.length === 0 && <div className="px-1 py-2 text-muted-foreground">You have no repositories yet.</div>}
          {cards.map((repo, index) => (
            <Fragment key={repo.name}>
              {index === yourRepos.repos.length && <div className="px-1 pt-2 text-xs font-medium text-muted-foreground">Starred</div>}
              <a
                href={`#/home?repo=${encodeURIComponent(repo.name)}`}
                className={cn(
                  "block rounded-lg border bg-card p-3 hover:bg-accent/50",
                  repo.name === props.repo && "border-primary/40 bg-selected ring-1 ring-primary/15 ring-inset hover:bg-selected",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {repo.private ? <Lock className="size-4 shrink-0 text-muted-foreground" /> : <BookMarked className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 truncate">
                    <span className="text-muted-foreground">{repo.name.slice(0, repo.name.indexOf("/") + 1)}</span>
                    <span className="font-semibold">{repo.name.slice(repo.name.indexOf("/") + 1)}</span>
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{repo.pushed_at !== null ? `${since(repo.pushed_at, now)} ago` : ""}</span>
                </div>
                <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted-foreground">{repo.description !== "" ? repo.description : "No description."}</p>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  {repo.checks === "passed" && (
                    <span className="flex items-center gap-1 text-ok">
                      <CircleCheck className="size-3" /> Checks passed
                    </span>
                  )}
                  {repo.checks === "failed" && (
                    <span className="flex items-center gap-1 text-destructive">
                      <CircleX className="size-3" /> Checks failed
                    </span>
                  )}
                  {repo.checks === "running" && (
                    <span className="flex items-center gap-1 text-warn">
                      <CircleDashed className="size-3" /> Checks running
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1" title="Open issues">
                    <CircleDot className="size-3" /> {repo.open_issues}
                  </span>
                  <span className="flex items-center gap-1" title="Open pull requests">
                    <GitPullRequest className="size-3" /> {repo.open_prs}
                  </span>
                  <span className="flex items-center gap-1" title="Stars">
                    <Star className="size-3" /> {repo.stars}
                  </span>
                </div>
              </a>
            </Fragment>
          ))}
        </div>
      </div>

      <div className={cn("flex min-w-0 flex-1 flex-col", props.repo === null && "max-md:hidden")}>
        {props.repo === null && <div className="m-auto px-4 text-center text-muted-foreground">Pick a repository on the left.</div>}
        {props.repo !== null && (
          <>
            <a href="#/home" className="flex h-8 shrink-0 items-center gap-1 border-b px-2 text-muted-foreground hover:text-foreground md:hidden">
              <ChevronLeft className="size-4" /> Repositories
            </a>
            <div className="min-h-0 flex-1">
              <Repository
                key={props.repo}
                repo={props.repo}
                tab={props.tab}
                state={props.state}
                open={props.open}
                base={`#/home?repo=${encodeURIComponent(props.repo)}`}
                live
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
