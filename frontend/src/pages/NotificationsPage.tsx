import { useState } from "react";
import { toast } from "sonner";

import DataList from "@/components/DataList";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { since, useNow } from "@/components/ui/job-progress";
import { api, useLive, type GithubNotification } from "@/live";
import { useWorkItems } from "@/model/work";
import { href } from "@/routes";
import ThreadDialog from "@/ThreadDialog";

/*
Notifications: what GitHub told you (its own notifications, read with your sign-in), newest first. Each opens the
issue it belongs to when that issue is work here; otherwise the pull request or issue opens in a pop-up, and anything
else on GitHub. Opening one marks it read. Select several to mark them read or done; or Mark all as read.
*/

const REASON_TEXT: Record<string, string> = {
  approval_requested: "Approval requested",
  assign: "Assigned",
  author: "Yours",
  ci_activity: "Checks",
  comment: "Comment",
  invitation: "Invitation",
  manual: "Subscribed",
  mention: "Mention",
  review_requested: "Review requested",
  security_alert: "Security alert",
  state_change: "State change",
  subscribed: "Subscribed",
  team_mention: "Team mention",
};

export default function NotificationsPage() {
  const notifications = useLive("notifications");
  const items = useWorkItems();
  const now = useNow();
  const [thread, setThread] = useState<string | null>(null);

  function workHref(item: GithubNotification): string {
    if (item.number === null) {
      return "";
    }
    const work = items.get(`${item.repo.toLowerCase()}#${item.number}`);
    return work !== undefined ? href.work(work.repo, work.number) : "";
  }

  function open(item: GithubNotification) {
    if (item.unread) {
      api(`/api/notifications/${item.id}/read`, { method: "POST" }).catch(() => {});
    }
    if (workHref(item) !== "") {
      return;
    }
    if (item.number !== null && (item.type === "Issue" || item.type === "PullRequest")) {
      setThread(`${item.repo}#${item.number}`);
      return;
    }
    window.open(item.url, "_blank", "noreferrer");
  }

  async function markAll(rows: GithubNotification[], action: "read" | "done") {
    try {
      for (const row of rows) {
        await api(`/api/notifications/${row.id}/${action}`, { method: "POST" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const unread = notifications.items.filter((item) => item.unread).length;

  return (
    <div>
      <PageHeader
        title="Notifications"
        meta={notifications.error ?? `What GitHub told you · ${unread} unread`}
        right={
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => api("/api/notifications/refresh", { method: "POST" }).catch(() => {})}>
              Check now
            </Button>
            <Button size="sm" variant="outline" disabled={unread === 0} onClick={() => api("/api/notifications/read_all", { method: "POST" }).catch(() => {})}>
              Mark all as read
            </Button>
          </div>
        }
      />
      <DataList
        id="notifications"
        rows={notifications.items}
        rowId={(item) => item.id}
        rowHref={workHref}
        onOpen={open}
        quiet={(item) => !item.unread}
        defaultSort={{ key: "when", dir: -1 }}
        empty={notifications.login === null ? "Sign in to GitHub in Settings to see your notifications." : "No notifications."}
        search={(item) => `${item.title} ${item.repo}`}
        chips={[{ key: "unread", label: "Unread", test: (item) => item.unread }]}
        columns={[
          { key: "title", label: "Title", main: true, sortValue: (item) => item.title, cell: (item) => item.title },
          { key: "reason", label: "Reason", sortValue: (item) => item.reason, cell: (item) => <Badge variant="secondary">{REASON_TEXT[item.reason] ?? item.reason}</Badge> },
          { key: "repo", label: "Where", sortValue: (item) => item.repo, cell: (item) => `${item.repo}${item.number !== null ? ` #${item.number}` : ""}` },
          { key: "when", label: "When", time: true, sortValue: (item) => item.updated_at, cell: (item) => `${since(item.updated_at, now)} ago` },
        ]}
        bulk={() => [
          { label: "Mark as read", onClick: (rows) => markAll(rows, "read") },
          { label: "Done", onClick: (rows) => markAll(rows, "done") },
        ]}
      />
      <ThreadDialog id={thread} onClose={() => setThread(null)} />
    </div>
  );
}
