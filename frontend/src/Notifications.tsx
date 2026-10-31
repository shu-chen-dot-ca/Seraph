/*
The GitHub tab's Notifications page (#/github/notifications): GitHub's own notifications for you, the bell on
github.com (github_searcher/notifications.py), read with your sign-in about once a minute, the newest first.
The bar on top: tabs All and Unread (with how many), on the right when they were last read, Mark all as read and
Check now. A line under it says why, when the last read failed; signed out, a line says to sign in.
Each row, like a mail list: a dot when unread (its title in bold), what it is (issue, pull request, release, checks,
discussion, commit), the repo and number, the title, why you got it in GitHub's words (Review requested, Mention,
Assigned, Comment, CI activity, Subscribed, ...) and how long ago. Hovering a row shows Done, which takes it off the
list for good, like Done on GitHub. A click marks it read and opens it: an issue or PR in the thread pop-up
(ThreadDialog.tsx; the address gets open=owner/name%23n), anything else on GitHub in a new tab.
*/

import { Bell, Check, CircleDot, GitCommitHorizontal, GitPullRequest, Loader2, MessagesSquare, RefreshCw, Tag, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import ThreadDialog from "@/ThreadDialog";
import { Button } from "@/components/ui/button";
import { since, useNow } from "@/components/ui/job-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type GithubNotification } from "@/live";
import { cn } from "@/lib/utils";

// Why you got it, in GitHub's own words.
const REASON_TEXT: Record<string, string> = {
  approval_requested: "Approval requested",
  assign: "Assigned",
  author: "Author",
  ci_activity: "CI activity",
  comment: "Comment",
  invitation: "Invitation",
  manual: "Subscribed",
  member_feature_requested: "Feature requested",
  mention: "Mention",
  review_requested: "Review requested",
  security_advisory_credit: "Security advisory",
  security_alert: "Security alert",
  state_change: "State change",
  subscribed: "Subscribed",
  team_mention: "Team mention",
};

export default function Notifications(props: { open: string | null }) {
  const notifications = useLive("notifications");
  const loaded = useLoaded("notifications");
  const [tab, setTab] = useState("all");
  const [checking, setChecking] = useState(false);
  const now = useNow();

  const unread = notifications.items.filter((item) => item.unread);
  const rows = tab === "unread" ? unread : notifications.items;

  async function checkNow() {
    setChecking(true);
    try {
      await api("/api/notifications/refresh", { method: "POST" });
    } catch (err) {
      toast.error(`Could not read your notifications: ${err instanceof Error ? err.message : err}`);
    }
    setChecking(false);
  }

  async function markAllRead() {
    try {
      await api("/api/notifications/read_all", { method: "POST" });
    } catch (err) {
      toast.error(`Could not mark them read: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function done(item: GithubNotification) {
    try {
      await api(`/api/notifications/${item.id}/done`, { method: "POST" });
    } catch (err) {
      toast.error(`Could not mark it done: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Opening one marks it read, as on GitHub.
  function open(item: GithubNotification) {
    if (item.unread) {
      api(`/api/notifications/${item.id}/read`, { method: "POST" }).catch(() => {});
    }
    if (item.number !== null && (item.type === "Issue" || item.type === "PullRequest")) {
      window.location.hash = `#/github/notifications?open=${encodeURIComponent(`${item.repo}#${item.number}`)}`;
      return;
    }
    window.open(item.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 max-md:h-auto max-md:min-h-9 max-md:flex-wrap max-md:py-1">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all" className="px-2.5">
              All <span className="text-xs text-muted-foreground tabular-nums">{notifications.items.length}</span>
            </TabsTrigger>
            <TabsTrigger value="unread" className="px-2.5">
              Unread <span className="text-xs text-muted-foreground tabular-nums">{unread.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="ml-auto text-xs text-muted-foreground max-md:hidden">
          {notifications.checked_at !== null ? `Checked ${since(notifications.checked_at, now)} ago` : ""}
        </span>
        <Button size="sm" variant="outline" className="max-md:ml-auto" disabled={unread.length === 0} onClick={markAllRead}>
          <Check /> Mark all as read
        </Button>
        <Button size="sm" variant="outline" disabled={checking} onClick={checkNow}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check now
        </Button>
      </div>
      {notifications.error !== null && (
        <div className="shrink-0 border-b bg-destructive/10 px-3 py-1.5 text-destructive">Could not read your notifications: {notifications.error}</div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && notifications.login === null && notifications.error === null && (
          <div className="px-3 py-2 text-muted-foreground">
            <a href="#/github/account" className="text-primary hover:underline">
              Sign in with GitHub
            </a>{" "}
            to see your notifications here.
          </div>
        )}
        {loaded && notifications.login !== null && rows.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">{tab === "unread" ? "No unread notifications." : "No notifications."}</div>
        )}
        {rows.map((item) => {
          let icon = <Bell className="size-4 shrink-0 text-muted-foreground" />;
          if (item.type === "Issue") {
            icon = <CircleDot className="size-4 shrink-0 text-muted-foreground" />;
          } else if (item.type === "PullRequest") {
            icon = <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />;
          } else if (item.type === "Release") {
            icon = <Tag className="size-4 shrink-0 text-muted-foreground" />;
          } else if (item.type === "CheckSuite") {
            icon = <Workflow className="size-4 shrink-0 text-muted-foreground" />;
          } else if (item.type === "Discussion") {
            icon = <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />;
          } else if (item.type === "Commit") {
            icon = <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />;
          }
          return (
            <div
              key={item.id}
              className="group flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 hover:bg-accent/50"
              onClick={() => open(item)}
            >
              <span className={cn("size-2 shrink-0 rounded-full", item.unread ? "bg-primary" : "bg-transparent")} />
              {icon}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={cn("truncate", item.unread && "font-medium")}>{item.title}</span>
                </div>
                <div className="flex min-w-0 items-center gap-x-2 text-xs text-muted-foreground">
                  <span className="text-foreground">
                    {item.repo}
                    {item.number !== null && ` #${item.number}`}
                  </span>
                  <span>{REASON_TEXT[item.reason] ?? item.reason}</span>
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted-foreground group-hover:hidden">{since(item.updated_at, now)} ago</span>
              <Button
                variant="ghost"
                size="xs"
                className="hidden shrink-0 group-hover:inline-flex"
                onClick={(event) => {
                  event.stopPropagation();
                  done(item);
                }}
              >
                Done
              </Button>
            </div>
          );
        })}
      </div>

      <ThreadDialog id={props.open} onClose={() => (window.location.hash = "#/github/notifications")} />
    </div>
  );
}
