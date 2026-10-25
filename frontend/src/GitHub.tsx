/*
The GitHub page (#/github, #/github?tab=closed|comments|account): your GitHub things in one place. Tabs:
- Open PRs / Closed PRs (merged ones too): your PRs on GitHub and how each one stands
  (github_searcher/pr_tracking.py): every PR the Inbox's Approve sent, and your other PRs on other people's
  projects (the ones you sent by hand, found with your account), the newest change first. The header says when
  they were last read from GitHub (every few minutes on its own, and right after Approve sends one) and has
  Check now. Each row, like GitHub's own PR list: the state (open, draft, merged, closed), the title, the repo
  and number, when it last changed, and in plain words where it stands:
  - Checks: "Waiting for a maintainer to approve the checks" (GitHub runs nothing for a first-time contributor's
    PR until a maintainer clicks approve, so this is normal and only needs waiting), running, passed, failed, or none.
  - Review: approved, changes asked for, reviewed with comments, or not reviewed yet.
  - How many comments and who wrote the latest (a maintainer, a bot, you), and the issue it fixes, open or closed.
  A click opens the row in place: each reviewer's latest review, the latest comment's text, the labels, the issues
  it fixes with who they are assigned to, why the last read failed (if it did), links (the PR on GitHub, the draft
  it was sent from in the Inbox, its job), and what you can do: Close PR on an open one; Reopen PR and Delete
  branch (from your fork) on a closed one; Delete branch on a merged one.
- Comments: the comments the app posted for you (approved comment drafts), newest first: where (repo and number),
  the start of the text, when. A click opens it: the whole text, links (on GitHub, its draft), and Delete comment.
- Account: your GitHub account, the one Approve in the Inbox sends PRs and comments as and these buttons act as
  (github_searcher/github_account.py). Paste a classic token with the public_repo scope and Connect: the backend
  checks it with GitHub (a fine-grained token, or one without that scope, is turned down with why) and keeps it on
  this computer. It never comes back to the browser: GET /api/github_account says only who it is (Connected as
  @login) and the token's scopes. Change token pastes a new one; Disconnect forgets it, and Approve then sends
  nothing again. "make one" opens GitHub's new-token page with public_repo ticked. Both tell the Inbox (a
  "github-account" window event), which shows who it sends as. Below: your forks the app sends PRs from.
Every button that changes something on GitHub asks "are you sure?" first (Enter confirms), then acts as you.
*/

import { ChevronRight, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { since, useNow } from "@/components/ui/job-progress";
import { Markdown } from "@/components/ui/markdown";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type GithubAccountStatus, type TrackedPR } from "@/live";
import { cn } from "@/lib/utils";

const TABS = ["open", "closed", "comments", "account"];

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

const REVIEW_STATE: Record<string, string> = {
  approved: "approved",
  changes_requested: "asked for changes",
  commented: "commented",
  dismissed: "review dismissed",
};

// What a button does, waiting for its "are you sure?".
type Confirm = { title: string; text: string; label: string; path: string };

// Who someone is, in plain words, from GitHub's role for them.
function who(login: string, role: string, pr: TrackedPR): string {
  if (login === pr.author) {
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

export default function GitHub(props: { tab: string | null }) {
  const prs = useLive("prs");
  const inbox = useLive("inbox");
  const loaded = useLoaded("prs");
  const [tab, setTab] = useState(props.tab !== null && TABS.includes(props.tab) ? props.tab : "open");
  const [open, setOpen] = useState<string[]>([]);
  // The last button clicked stays set while its "are you sure?" fades out, so the text doesn't blank.
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const openPRs = prs.items.filter((pr) => pr.state === "open");
  const closedPRs = prs.items.filter((pr) => pr.state !== "open");
  const comments = inbox.filter((draft) => draft.sent !== null && draft.sent.kind === "comment").sort((a, b) => (b.sent?.at ?? "").localeCompare(a.sent?.at ?? ""));
  // The forks Approve sent PRs from, once each.
  const forks: string[] = [];
  for (const draft of inbox) {
    if (draft.sent !== null && draft.sent.fork !== undefined && !forks.includes(draft.sent.fork)) {
      forks.push(draft.sent.fork);
    }
  }
  const rows = tab === "open" ? openPRs : closedPRs;

  function toggle(id: string) {
    if (open.includes(id)) {
      setOpen(open.filter((other) => other !== id));
      return;
    }
    setOpen([...open, id]);
  }

  async function checkNow() {
    try {
      await api("/api/github/refresh", { method: "POST" });
    } catch (err) {
      toast.error(`Could not check the PRs: ${err instanceof Error ? err.message : err}`);
    }
  }

  function ask(next: Confirm) {
    setConfirm(next);
    setConfirmOpen(true);
  }

  async function act() {
    if (confirm === null) {
      return;
    }
    const title = confirm.title;
    setBusy(true);
    try {
      const result = await api<{ done: string }>(confirm.path, { method: "POST" });
      toast.success(result.done);
    } catch (err) {
      toast.error(`${title.replace("?", "")}: ${err instanceof Error ? err.message : err}`);
    }
    setBusy(false);
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
      // Your PRs sent by hand show up now too.
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="open" className="px-2.5">
              Open PRs <span className="text-xs text-muted-foreground tabular-nums">{openPRs.length}</span>
            </TabsTrigger>
            <TabsTrigger value="closed" className="px-2.5">
              Closed PRs <span className="text-xs text-muted-foreground tabular-nums">{closedPRs.length}</span>
            </TabsTrigger>
            <TabsTrigger value="comments" className="px-2.5">
              Comments <span className="text-xs text-muted-foreground tabular-nums">{comments.length}</span>
            </TabsTrigger>
            <TabsTrigger value="account" className="px-2.5">
              Account
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {(tab === "open" || tab === "closed") && (
          <>
            <span className={cn("ml-auto text-xs text-muted-foreground", prs.error !== null && "text-destructive")} title={prs.error ?? undefined}>
              {prs.error !== null ? "Could not search for your PRs" : prs.checked_at !== null ? `Checked ${since(prs.checked_at, now)} ago` : ""}
            </span>
            <Button size="sm" variant="outline" disabled={prs.refreshing} onClick={checkNow}>
              {prs.refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check now
            </Button>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {(tab === "open" || tab === "closed") && (
          <>
            {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
            {loaded && prs.items.length === 0 && (
              <div className="px-3 py-2 text-muted-foreground">
                No PRs yet. A PR you approve in the Inbox shows here once it is on GitHub; with your account connected (Account), so do the ones
                you sent by hand.
              </div>
            )}
            {loaded && prs.items.length > 0 && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">None here.</div>}
          </>
        )}

        {(tab === "open" || tab === "closed") &&
          rows.map((pr) => {
            const isOpen = open.includes(pr.id);
            let icon = <GitPullRequest className="size-4 shrink-0 text-ok" />;
            if (pr.state === "open" && pr.draft) {
              icon = <GitPullRequestDraft className="size-4 shrink-0 text-muted-foreground" />;
            } else if (pr.state === "merged") {
              icon = <GitMerge className="size-4 shrink-0 text-violet-500" />;
            } else if (pr.state === "closed") {
              icon = <GitPullRequestClosed className="size-4 shrink-0 text-destructive" />;
            }
            const path = `/api/github/prs/${pr.repo}/${pr.number}`;
            return (
              <div key={pr.id} className="border-b">
                <div className={cn("flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/50", isOpen && "bg-accent/40")} onClick={() => toggle(pr.id)}>
                  <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="mt-px">{icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-medium">{pr.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {pr.state === "merged" && pr.closed_at !== null ? `merged ${since(pr.closed_at, now)} ago` : `updated ${since(pr.updated_at, now)} ago`}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span className="text-foreground">
                        {pr.repo} #{pr.number}
                      </span>
                      {pr.state === "open" && <span className={CHECKS_COLOR[pr.checks]}>{CHECKS_TEXT[pr.checks]}</span>}
                      {pr.state === "open" && <span className={REVIEW_COLOR[pr.review]}>{REVIEW_TEXT[pr.review]}</span>}
                      {pr.state === "merged" && pr.merged_by !== null && <span className="text-ok">Merged by {pr.merged_by}</span>}
                      {pr.state === "closed" && <span className="text-destructive">Closed without merging</span>}
                      <span>
                        {pr.comments === 1 ? "1 comment" : `${pr.comments} comments`}
                        {pr.last_comment !== null && `, the latest by ${who(pr.last_comment.login, pr.last_comment.role, pr)} ${since(pr.last_comment.at, now)} ago`}
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

                {isOpen && (
                  <div className="space-y-2 px-3 pb-3 pl-[52px] text-xs">
                    {pr.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {pr.labels.map((label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {pr.state === "open" && pr.checks === "waiting" && (
                      <div className="text-muted-foreground">
                        GitHub doesn't run a project's checks on a first-time contributor's PR until a maintainer approves them ({pr.waiting_runs}{" "}
                        {pr.waiting_runs === 1 ? "run waits" : "runs wait"}). Nothing is wrong: it waits for a maintainer. Once one of your PRs is merged
                        there, your next ones run right away.
                      </div>
                    )}
                    <div>
                      <div className="font-medium">Reviews</div>
                      {pr.reviewers.length === 0 && <div className="text-muted-foreground">Nobody reviewed it yet.</div>}
                      {pr.reviewers.map((reviewer) => (
                        <div key={reviewer.login}>
                          {who(reviewer.login, reviewer.role, pr)}: {REVIEW_STATE[reviewer.state] ?? reviewer.state}, {since(reviewer.at, now)} ago
                        </div>
                      ))}
                    </div>
                    {pr.last_comment !== null && (
                      <div>
                        <div className="font-medium">
                          Latest comment, by {who(pr.last_comment.login, pr.last_comment.role, pr)}, {since(pr.last_comment.at, now)} ago
                        </div>
                        <div className="text-muted-foreground">{pr.last_comment.text}</div>
                      </div>
                    )}
                    {pr.issues.length > 0 && (
                      <div>
                        <div className="font-medium">Fixes</div>
                        {pr.issues.map((issue) => (
                          <div key={issue.number}>
                            <a href={issue.url} target="_blank" rel="noreferrer" className="hover:underline">
                              #{issue.number} {issue.title}
                            </a>
                            <span className="text-muted-foreground">
                              {" "}
                              ({issue.state === "open" ? "open" : issue.reason === "not_planned" ? "closed as not planned" : "closed"}
                              {issue.assignees.length > 0 && `, assigned to ${issue.assignees.join(", ")}`})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {pr.error !== null && <div className="text-destructive">The last check failed: {pr.error}</div>}
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                        Open on GitHub <ExternalLink className="size-3" />
                      </a>
                      {pr.draft_id !== null && (
                        <a href={`#/inbox/${pr.draft_id}`} className="hover:underline">
                          Its draft
                        </a>
                      )}
                      {pr.job !== null && (
                        <a href={`#/jobs/${pr.job}`} className="hover:underline">
                          Its job
                        </a>
                      )}
                      <span className="ml-auto flex gap-1.5">
                        {pr.state === "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              ask({
                                title: `Close ${pr.repo} #${pr.number}?`,
                                text: "It closes on GitHub, as you, without merging. Its branch stays, so you can reopen it.",
                                label: "Close PR",
                                path: `${path}/close`,
                              })
                            }
                          >
                            Close PR
                          </Button>
                        )}
                        {pr.state === "closed" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              ask({
                                title: `Reopen ${pr.repo} #${pr.number}?`,
                                text: "It opens again on GitHub, as you, and the project's people are told.",
                                label: "Reopen PR",
                                path: `${path}/reopen`,
                              })
                            }
                          >
                            Reopen PR
                          </Button>
                        )}
                        {pr.state !== "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              ask({
                                title: `Delete the branch of ${pr.repo} #${pr.number}?`,
                                text: "Its branch is deleted from your fork, for good. The PR stays on GitHub, but it can't be reopened after.",
                                label: "Delete branch",
                                path: `${path}/delete_branch`,
                              })
                            }
                          >
                            Delete branch
                          </Button>
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

        {tab === "comments" && comments.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">No comments yet. A comment you approve in the Inbox shows here once it is on GitHub.</div>
        )}
        {tab === "comments" &&
          comments.map((draft) => {
            const sent = draft.sent!;
            const isOpen = open.includes(draft.id);
            const deleted = sent.deleted_at !== undefined;
            return (
              <div key={draft.id} className="border-b">
                <div className={cn("flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/50", isOpen && "bg-accent/40")} onClick={() => toggle(draft.id)}>
                  <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className={cn("truncate", deleted && "text-muted-foreground line-through")}>{draft.body.split("\n")[0]}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {deleted ? `deleted ${since(sent.deleted_at ?? null, now)} ago` : `posted ${since(sent.at, now)} ago`}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      on {sent.repo} #{sent.number}
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div className="space-y-2 px-3 pb-3 pl-[30px] text-xs">
                    <Markdown text={draft.body} repo={sent.repo} githubImagesOnly issueRefs />
                    <div className="flex flex-wrap items-center gap-3">
                      {!deleted && (
                        <a href={sent.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                          Open on GitHub <ExternalLink className="size-3" />
                        </a>
                      )}
                      <a href={`#/inbox/${draft.id}`} className="hover:underline">
                        Its draft
                      </a>
                      {!deleted && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto"
                          disabled={busy}
                          onClick={() =>
                            ask({
                              title: `Delete your comment on ${sent.repo} #${sent.number}?`,
                              text: "It is deleted from GitHub, for good. People who were notified may still have it in their email.",
                              label: "Delete comment",
                              path: `/api/github/comments/${draft.id}/delete`,
                            })
                          }
                        >
                          Delete comment
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

        {tab === "account" && (
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
                Approve in the Inbox sends PRs and comments as this account, after you confirm, and the buttons on this page act as it. It needs a
                classic token with the public_repo scope (
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

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant={confirm?.label === "Reopen PR" ? "default" : "destructive"} onClick={act}>
              {confirm?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
