import { useMemo } from "react";

import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import ApprovalsList from "@/dashboard/ApprovalsList";
import NotificationsList from "@/dashboard/NotificationsList";
import PullRequestsList from "@/dashboard/PullRequestsList";
import QuestionsList from "@/dashboard/QuestionsList";
import { api, useLive } from "@/live";
import { cn } from "@/lib/utils";
import { useInbox } from "@/model/inbox";
import { pullRows } from "@/model/pulls";
import { useWorkItems } from "@/model/work";
import { href, type DashboardCard } from "@/routes";

/*
The Dashboard: big cards with how many there are of each, and under them the list of the card you picked. A row opens
its question, its approval, its issue's page, or the GitHub thread.
- Questions: an agent asked you something. They hold an agent up, so they come first.
- Approvals: things to send or merge.
- In progress, Open, Merged, Closed: your pull requests from every project, from the ones agents are still making to
  the done ones (model/pulls.ts).
- Notifications: what GitHub told you. The card counts the unread ones.
A card is an address (#/dashboard/<card>), so back and refresh keep it. Without one the Dashboard opens on Questions
while any question waits, else on Approvals while any approval waits, else on In progress.
*/

const META: Record<DashboardCard, string> = {
  questions: "Agents asked you these.",
  approvals: "Nothing is sent until you approve.",
  "in-progress": "Agents are working on these. Nothing is on GitHub yet.",
  open: "Your pull requests open on GitHub.",
  merged: "Your merged pull requests.",
  closed: "Your pull requests closed without a merge.",
  notifications: "What GitHub told you.",
};

export default function DashboardPage(props: { card: DashboardCard | null }) {
  const { questions, approvals } = useInbox();
  const notifications = useLive("notifications");
  const items = useWorkItems();
  const pulls = useMemo(() => pullRows(items), [items]);
  const unread = notifications.items.filter((item) => item.unread).length;

  let card = props.card;
  if (card === null && questions.length > 0) {
    card = "questions";
  }
  if (card === null && approvals.length > 0) {
    card = "approvals";
  }
  if (card === null) {
    card = "in-progress";
  }

  const cards: { key: DashboardCard; label: string; count: number }[] = [
    { key: "questions", label: "Questions", count: questions.length },
    { key: "approvals", label: "Approvals", count: approvals.length },
    { key: "in-progress", label: "In progress", count: pulls.filter((row) => row.group === "in-progress").length },
    { key: "open", label: "Open", count: pulls.filter((row) => row.group === "open").length },
    { key: "merged", label: "Merged", count: pulls.filter((row) => row.group === "merged").length },
    { key: "closed", label: "Closed", count: pulls.filter((row) => row.group === "closed").length },
    { key: "notifications", label: "Notifications", count: unread },
  ];

  let meta = META[card];
  if (card === "notifications") {
    meta = notifications.error ?? `${META.notifications} · ${unread} unread`;
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        meta={meta}
        right={
          card === "notifications" && (
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => api("/api/notifications/refresh", { method: "POST" }).catch(() => {})}>
                Check now
              </Button>
              <Button size="sm" variant="outline" disabled={unread === 0} onClick={() => api("/api/notifications/read_all", { method: "POST" }).catch(() => {})}>
                Mark all as read
              </Button>
            </div>
          )
        }
      />
      <div className="grid grid-cols-3 gap-2 px-4 pt-3 pb-3 sm:grid-cols-4 xl:grid-cols-7">
        {cards.map((each) => (
          <a
            key={each.key}
            href={href.dashboard(each.key)}
            className={cn("rounded-md border bg-card px-3 py-2.5 hover:border-input", card === each.key && "border-primary hover:border-primary")}
          >
            <div className="truncate text-xs text-muted-foreground">{each.label}</div>
            <div className={cn("mt-1 text-2xl font-semibold tabular-nums md:text-3xl", each.key === "questions" && each.count > 0 && "text-warn")}>{each.count}</div>
          </a>
        ))}
      </div>
      <div className="border-t">
        {card === "questions" && <QuestionsList questions={questions} />}
        {card === "approvals" && <ApprovalsList approvals={approvals} />}
        {card === "notifications" && <NotificationsList />}
        {card !== "questions" && card !== "approvals" && card !== "notifications" && (
          <PullRequestsList key={card} group={card} rows={pulls.filter((row) => row.group === card)} />
        )}
      </div>
    </div>
  );
}
