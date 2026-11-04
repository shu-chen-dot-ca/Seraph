import DataList from "@/components/DataList";
import { Badge } from "@/components/ui/badge";
import { since, useNow } from "@/components/ui/job-progress";
import { useLive } from "@/live";
import type { PullGroup, PullRow } from "@/model/pulls";
import { isQuestion } from "@/model/work";
import { href } from "@/routes";

/*
The Dashboard's In progress, Open, Merged and Closed: your pull requests from every project (model/pulls.ts).

A click on a row opens its issue's page. The links in it go to the project, the issue and the pull request on GitHub,
the newest comment there, the agents on it and their machine. A Question or Approval tag opens that question or
approval (a private project's Merge is on its issue's page).
*/

const LINK = "text-primary hover:underline";
const GITHUB_LINK = "hover:text-foreground hover:underline";

const EMPTY: Record<PullGroup, string> = {
  "in-progress": "No agent is working on an issue right now.",
  open: "No open pull requests.",
  merged: "No merged pull requests yet.",
  closed: "No closed pull requests.",
};

export default function PullRequestsList(props: { group: PullGroup; rows: PullRow[] }) {
  const agentList = useLive("agents");
  const now = useNow();
  const agentName = (id: string) => agentList.find((agent) => agent.id === id)?.name ?? id;

  return (
    <DataList
      id={`pull-requests-${props.group}`}
      rows={props.rows}
      rowId={(row) => row.item.key}
      rowHref={(row) => href.work(row.item.repo, row.item.number)}
      defaultSort={{ key: "updated", dir: -1 }}
      empty={EMPTY[props.group]}
      search={(row) => `${row.item.title} ${row.item.repo} #${row.item.number} #${row.number ?? ""} ${row.agents.map(agentName).join(" ")}`}
      columns={[
        { key: "title", label: "Title", main: true, sortValue: (row) => row.item.title, cell: (row) => row.item.title },
        {
          key: "state",
          label: "State",
          sortValue: (row) => row.state,
          cell: (row) => (
            <span className="flex items-center gap-1.5">
              {row.item.waiting !== null && isQuestion(row.item.waiting) && (
                <Badge variant="warn" asChild>
                  <a href={href.inboxItem(row.item.waiting.id)}>Question</a>
                </Badge>
              )}
              {row.item.waiting !== null && !isQuestion(row.item.waiting) && (
                <Badge asChild>
                  <a href={href.inboxItem(row.item.waiting.id)}>Approval</a>
                </Badge>
              )}
              {row.item.waiting === null && row.item.waitingPR !== null && (
                <Badge asChild>
                  <a href={href.work(row.item.repo, row.item.number)}>Approval</a>
                </Badge>
              )}
              <span className="truncate">{row.state}</span>
            </span>
          ),
        },
        {
          key: "project",
          label: "Project",
          sortValue: (row) => row.item.repo.toLowerCase(),
          cell: (row) => (
            <a href={href.project(row.item.repo)} className={LINK}>
              {row.item.repo}
            </a>
          ),
        },
        {
          key: "github",
          label: "Pull request",
          sortValue: (row) => row.number ?? 0,
          cell: (row) => (
            <span className="flex gap-2">
              {row.issueUrl !== null && (
                <a href={row.issueUrl} target="_blank" rel="noreferrer" className={GITHUB_LINK}>
                  Issue #{row.item.number} ↗
                </a>
              )}
              {row.url !== null && (
                <a href={row.url} target="_blank" rel="noreferrer" className={GITHUB_LINK}>
                  PR #{row.number} ↗
                </a>
              )}
              {props.group === "open" && row.tracked !== null && row.tracked.last_activity !== null && (
                <a href={row.tracked.url} target="_blank" rel="noreferrer" className={GITHUB_LINK}>
                  @{row.tracked.last_activity.login} {row.tracked.last_activity.what === "review" ? "reviewed" : "commented"}{" "}
                  {since(row.tracked.last_activity.at, now)} ago ↗
                </a>
              )}
            </span>
          ),
        },
        {
          key: "agent",
          label: "Agent",
          sortValue: (row) => (row.agents.length > 0 ? agentName(row.agents[0]) : ""),
          cell: (row) => (
            <span className="flex gap-2">
              {row.agents.map((id) => (
                <a key={id} href={href.agent(id)} className={LINK}>
                  {agentName(id)}
                </a>
              ))}
            </span>
          ),
        },
        {
          key: "machine",
          label: "Machine",
          sortValue: (row) => row.vm ?? "",
          cell: (row) =>
            row.vm !== null && (
              <a href={href.machine(row.vm)} className={LINK}>
                {row.vm}
              </a>
            ),
        },
        { key: "updated", label: "Updated", time: true, sortValue: (row) => row.item.updatedAt, cell: (row) => `${since(row.item.updatedAt, now)} ago` },
      ]}
      bulk={() => []}
    />
  );
}
