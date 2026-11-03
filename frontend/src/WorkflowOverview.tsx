/*
A Workflow repository's Overview tab (Workflow.tsx): what matters first, in numbers and charts, then who is on what.
- The numbers: pull requests waiting for you (for a decision, when the review agent decides), in review, issues being
  worked on, open issues, and pull requests merged in the last 7 days.
- Waiting for you: those pull requests, each in one plain line with the review agent's advice (PullRequestRow).
- Where the work is: the open issues by how far they are (not started, being worked on, in review, waiting for you), one
  bar, its parts in order from light to dark.
- Pull requests, last 14 days: a column a day for the ones made that day, split by what became of them (merged,
  rejected, still open). Hovering a day says its numbers.
- Review agent and you: of the pull requests you decided on, how often its advice was what you did, and where not. When
  it stays high, letting the review agent decide (Settings) changes little.
- Merged, by area: the merged pull requests by the area their title names, the most first.
- Agents: each worker with the issue it is on and how far it is, and the review agent with what it reviews.
- Latest merged: the last five.
Chart colors are fixed per meaning and checked for color-blind readers in both themes; every chart says its numbers in
text too.
*/

import { useState } from "react";

import { PullRequestRow } from "@/WorkflowPullRequests";
import { JobProgressBar } from "@/components/ui/job-progress";
import { useLive, type Job, type WorkflowRepo } from "@/live";
import { cn } from "@/lib/utils";

// Validated colors (the dataviz palette's blue and orange, and its de-emphasis gray), light and dark.
const MERGED = "bg-[#2a78d6] dark:bg-[#3987e5]";
const REJECTED = "bg-[#eb6834] dark:bg-[#d95926]";
const STILL_OPEN = "bg-[#c3c2b7] dark:bg-[#4a4a46]";
// The four stages of an open issue, an ordered blue ramp: later is darker in light mode, lighter in dark mode.
const STAGE_COLORS = [
  "bg-[#86b6ef] dark:bg-[#184f95]",
  "bg-[#3987e5] dark:bg-[#256abf]",
  "bg-[#1c5cab] dark:bg-[#3987e5]",
  "bg-[#0d366b] dark:bg-[#86b6ef]",
];
// The meter's track: a light step of the same blue.
const TRACK = "bg-[#cde2fb] dark:bg-[#184f95]";
const DAYS = 14;
// The tallest column, in pixels.
const COLUMN_HEIGHT = 112;
// Areas shown; the rest are summed up as Other.
const AREAS_SHOWN = 7;

export default function WorkflowOverview(props: { record: WorkflowRepo; base: string }) {
  const record = props.record;
  const agents = useLive("agents");
  const jobs = useLive("jobs");
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const names: Record<string, string> = {};
  for (const agent of agents) {
    names[agent.id] = agent.name;
  }
  const prs = Object.values(record.prs);
  const issues = Object.values(record.issues);
  const waiting = prs.filter((pr) => pr.state === "waiting").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const inReview = prs.filter((pr) => pr.state === "review");
  const openIssues = issues.filter((issue) => issue.state === "open");
  const weekAgo = Date.now() - 7 * 86400 * 1000;
  const merged = prs.filter((pr) => pr.state === "merged").sort((a, b) => (b.decision?.at ?? b.at).localeCompare(a.decision?.at ?? a.at));
  const mergedWeek = merged.filter((pr) => Date.parse(pr.decision?.at ?? pr.at) > weekAgo).length;
  const waitingLabel = record.decides === "you" ? "Waiting for you" : "Waiting for a decision";

  // Where each open issue is.
  const stages = [
    { label: "Not started", count: 0 },
    { label: "Being worked on", count: 0 },
    { label: "In review", count: 0 },
    { label: waitingLabel, count: 0 },
  ];
  let stopped = 0;
  for (const issue of openIssues) {
    const own = prs.filter((pr) => pr.issue === issue.number && (pr.state === "review" || pr.state === "waiting"));
    if (own.some((pr) => pr.state === "waiting")) {
      stages[3].count += 1;
    } else if (own.length > 0) {
      stages[2].count += 1;
    } else if (issue.stopped) {
      stopped += 1;
    } else if (issue.job !== null) {
      stages[1].count += 1;
    } else {
      stages[0].count += 1;
    }
  }
  const staged = stages.reduce((sum, each) => sum + each.count, 0);

  // The last DAYS days, today last: the pull requests made each day, by what became of them.
  const days: { label: string; merged: number; rejected: number; open: number }[] = [];
  for (let back = DAYS - 1; back >= 0; back--) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - back);
    days.push({ label: day.toLocaleDateString(undefined, { month: "short", day: "numeric" }), merged: 0, rejected: 0, open: 0 });
  }
  const firstDay = new Date();
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - (DAYS - 1));
  for (const pr of prs) {
    const made = new Date(pr.created_at);
    made.setHours(0, 0, 0, 0);
    const index = Math.round((made.getTime() - firstDay.getTime()) / (86400 * 1000));
    if (index < 0 || index >= DAYS) {
      continue;
    }
    if (pr.state === "merged") {
      days[index].merged += 1;
    } else if (pr.state === "rejected" || pr.state === "closed") {
      days[index].rejected += 1;
    } else {
      days[index].open += 1;
    }
  }
  const dayMax = Math.max(1, ...days.map((day) => day.merged + day.rejected + day.open));
  const dayTotals = days.reduce((sum, day) => ({ merged: sum.merged + day.merged, rejected: sum.rejected + day.rejected, open: sum.open + day.open }), { merged: 0, rejected: 0, open: 0 });

  // The review agent's advice against your decisions.
  const decided = prs.filter((pr) => pr.decision !== null && pr.decision.by === "you" && pr.review !== null && pr.review.advice !== null);
  let agreed = 0;
  let saidMergeRejected = 0;
  let saidNotMerged = 0;
  for (const pr of decided) {
    if (pr.review?.advice === "merge" && pr.decision?.action === "merge") {
      agreed += 1;
    } else if (pr.review?.advice === "dont_merge" && pr.decision?.action === "reject") {
      agreed += 1;
    } else if (pr.review?.advice === "merge") {
      saidMergeRejected += 1;
    } else {
      saidNotMerged += 1;
    }
  }

  // Merged by area, the most first; the tail as Other.
  const byArea: Record<string, { count: number; lines: number }> = {};
  for (const pr of merged) {
    const area = pr.area || "Other";
    if (byArea[area] === undefined) {
      byArea[area] = { count: 0, lines: 0 };
    }
    byArea[area].count += 1;
    byArea[area].lines += pr.added + pr.removed;
  }
  let areas = Object.entries(byArea)
    .map(([name, value]) => ({ name: name, count: value.count, lines: value.lines }))
    .sort((a, b) => b.count - a.count);
  if (areas.length > AREAS_SHOWN) {
    const tail = areas.slice(AREAS_SHOWN - 1);
    areas = [...areas.slice(0, AREAS_SHOWN - 1), { name: "Other", count: tail.reduce((sum, each) => sum + each.count, 0), lines: tail.reduce((sum, each) => sum + each.lines, 0) }];
  }
  const areaMax = Math.max(1, ...areas.map((each) => each.count));

  // What each agent is on: its working job, else its next queued one, else one waiting on a decision.
  function current(agentId: string | null): Job | undefined {
    const own = jobs.filter((job) => job.agent === agentId);
    return own.find((job) => job.status === "working") ?? own.find((job) => job.status === "queued") ?? own.find((job) => job.status === "waiting_on_user");
  }

  const tiles = [
    { label: waitingLabel, value: waiting.length, href: `${props.base}&tab=pulls` },
    { label: "In review", value: inReview.length, href: `${props.base}&tab=pulls` },
    { label: "Being worked on", value: stages[1].count, href: `${props.base}&tab=issues` },
    { label: "Open issues", value: openIssues.length, href: `${props.base}&tab=issues` },
    { label: "Merged, 7 days", value: mergedWeek, href: `${props.base}&tab=pulls&state=closed` },
  ];
  const card = "space-y-3 rounded-lg border bg-card p-4";
  const cardTitle = "font-semibold";
  const shownDay = hoverDay !== null ? days[hoverDay] : null;
  const rowMax = Math.max(1, ...prs.map((pr) => pr.added + pr.removed));

  return (
    <div className="max-w-5xl space-y-5 p-4 max-md:p-3">
      <div className="grid grid-cols-5 gap-2 max-md:grid-cols-2">
        {tiles.map((tile) => (
          <a key={tile.label} href={tile.href} className="rounded-lg border bg-card px-3 py-2.5 hover:bg-accent/50">
            <div className="text-xs text-muted-foreground">{tile.label}</div>
            <div className="text-2xl font-semibold">{tile.value}</div>
          </a>
        ))}
      </div>

      {waiting.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
            <span className={cardTitle}>{waitingLabel}</span>
            <a href={`${props.base}&tab=pulls`} className="ml-auto text-xs text-muted-foreground hover:underline">
              All pull requests
            </a>
          </div>
          <div className="divide-y">
            {waiting.slice(0, 5).map((pr) => (
              <PullRequestRow key={pr.number} record={record} pr={pr} base={props.base} names={names} max={rowMax} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 max-lg:grid-cols-1">
        <div className={card}>
          <div className={cardTitle}>Where the work is</div>
          {staged === 0 && <div className="text-muted-foreground">No open issues{stopped > 0 ? `, apart from ${stopped} stopped` : ""}.</div>}
          {staged > 0 && (
            <>
              <div className="flex h-6 gap-[2px]">
                {stages.map((each, index) =>
                  each.count === 0 ? null : (
                    <div
                      key={each.label}
                      className={cn("h-6 first:rounded-l-[4px] last:rounded-r-[4px]", STAGE_COLORS[index])}
                      style={{ width: `${(each.count / staged) * 100}%` }}
                      title={`${each.label}: ${each.count}`}
                    />
                  ),
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {stages.map((each, index) => (
                  <div key={each.label} className="flex items-center gap-2">
                    <span className={cn("size-2.5 shrink-0 rounded-[2px]", STAGE_COLORS[index])} />
                    <span className="min-w-0 truncate text-muted-foreground">{each.label}</span>
                    <span className="ml-auto font-medium tabular-nums">{each.count}</span>
                  </div>
                ))}
              </div>
              {stopped > 0 && <div className="text-xs text-muted-foreground">And {stopped} stopped: Try again on each, in Issues.</div>}
            </>
          )}
        </div>

        <div className={card}>
          <div className="flex items-baseline gap-2">
            <span className={cardTitle}>Pull requests, last {DAYS} days</span>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {shownDay !== null
                ? `${shownDay.label}: ${shownDay.merged} merged, ${shownDay.rejected} rejected, ${shownDay.open} open`
                : `${dayTotals.merged} merged, ${dayTotals.rejected} rejected, ${dayTotals.open} open`}
            </span>
          </div>
          <div className="flex items-end gap-[2px] border-b" style={{ height: COLUMN_HEIGHT + 2 }} onMouseLeave={() => setHoverDay(null)}>
            {days.map((day, index) => {
              const total = day.merged + day.rejected + day.open;
              return (
                <div key={day.label} className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center" onMouseEnter={() => setHoverDay(index)}>
                  <div
                    className={cn("flex w-full max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]", hoverDay === index && "opacity-80")}
                    style={{ height: total === 0 ? 0 : Math.max(4, (total / dayMax) * COLUMN_HEIGHT) }}
                  >
                    {day.merged > 0 && <div className={MERGED} style={{ flexGrow: day.merged }} />}
                    {day.rejected > 0 && <div className={REJECTED} style={{ flexGrow: day.rejected }} />}
                    {day.open > 0 && <div className={STILL_OPEN} style={{ flexGrow: day.open }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{days[0].label}</span>
            <span>Today</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-[2px]", MERGED)} /> Merged
            </span>
            <span className="flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-[2px]", REJECTED)} /> Rejected
            </span>
            <span className="flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-[2px]", STILL_OPEN)} /> Still open
            </span>
          </div>
        </div>

        <div className={card}>
          <div className={cardTitle}>Review agent and you</div>
          {decided.length === 0 && <div className="text-muted-foreground">Once you merge or reject reviewed pull requests, this shows how often its advice was what you did.</div>}
          {decided.length > 0 && (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold">{Math.round((agreed / decided.length) * 100)}%</span>
                <span className="text-muted-foreground">
                  its advice was your decision on {agreed} of {decided.length}
                </span>
              </div>
              <div className={cn("h-2 overflow-hidden rounded-full", TRACK)}>
                <div className={cn("h-2 rounded-full", MERGED)} style={{ width: `${(agreed / decided.length) * 100}%` }} />
              </div>
              <div className="space-y-0.5 text-muted-foreground">
                <div className="flex">
                  <span>It said merge, you rejected</span>
                  <span className="ml-auto font-medium text-foreground tabular-nums">{saidMergeRejected}</span>
                </div>
                <div className="flex">
                  <span>It said don't merge, you merged</span>
                  <span className="ml-auto font-medium text-foreground tabular-nums">{saidNotMerged}</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className={card}>
          <div className={cardTitle}>Merged, by area</div>
          {areas.length === 0 && <div className="text-muted-foreground">Nothing merged yet.</div>}
          <div className="space-y-1.5">
            {areas.map((each) => (
              <div key={each.name} className="flex items-center gap-2" title={`${each.name}: ${each.count} merged, ${each.lines} lines changed`}>
                <span className="w-24 shrink-0 truncate text-muted-foreground">{each.name}</span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className={cn("h-3 rounded-r-[4px]", MERGED)} style={{ width: `${(each.count / areaMax) * 85}%` }} />
                  <span className="shrink-0 text-xs tabular-nums">{each.count}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <div className="border-b bg-card px-3 py-2 font-semibold">Agents</div>
        <div className="divide-y">
          {record.workers.map((agentId) => {
            const job = current(agentId);
            return (
              <div key={agentId} className="flex min-w-0 items-center gap-2 px-3 py-2">
                <a href={`#/agents/${agentId}`} className="w-40 shrink-0 truncate hover:underline max-md:w-28">
                  {names[agentId] ?? "Worker"}
                </a>
                {job === undefined && <span className="text-muted-foreground">{record.on ? "Waiting for an issue" : "Paused"}</span>}
                {job !== undefined && (
                  <>
                    <JobProgressBar job={job} className="shrink-0 max-md:hidden" />
                    <span className="min-w-0 truncate">{job.title}</span>
                    <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground max-md:hidden">
                      {job.status === "waiting_on_user" ? "Its pull request is in review or waiting" : job.headline}
                    </span>
                  </>
                )}
              </div>
            );
          })}
          {record.reviewer !== null && (
            <div className="flex min-w-0 items-center gap-2 px-3 py-2">
              <a href={`#/agents/${record.reviewer}`} className="w-40 shrink-0 truncate hover:underline max-md:w-28">
                {names[record.reviewer] ?? "Review agent"}
              </a>
              <span className="min-w-0 truncate">{current(record.reviewer)?.title ?? <span className="text-muted-foreground">Nothing to review</span>}</span>
            </div>
          )}
        </div>
      </div>

      {merged.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b bg-card px-3 py-2">
            <span className={cardTitle}>Latest merged</span>
            <a href={`${props.base}&tab=pulls&state=closed`} className="ml-auto text-xs text-muted-foreground hover:underline">
              All closed
            </a>
          </div>
          <div className="divide-y">
            {merged.slice(0, 5).map((pr) => (
              <PullRequestRow key={pr.number} record={record} pr={pr} base={props.base} names={names} max={rowMax} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
