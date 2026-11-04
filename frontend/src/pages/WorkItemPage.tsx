import { ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import AssignDialog from "@/AssignDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import PageHeader from "@/components/PageHeader";
import { StageBadge, StageSteps, Timeline, Who } from "@/components/WorkBits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JobProgressBar, JobSteps, useNow } from "@/components/ui/job-progress";
import { JOB_LABEL } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Job } from "@/live";
import { askOf } from "@/model/inbox";
import { buildJobTimeline, buildTimeline } from "@/model/timeline";
import { OPEN_JOB, useWorkItems, type WorkItem } from "@/model/work";
import { questionWhen } from "@/pages/InboxPage";
import { href } from "@/routes";
import ThreadDialog from "@/ThreadDialog";

/*
One piece of work's page: an issue from open to merged, under its project. At the top, what it waits for you for (a
question, an approval, a Workflow pull request to merge) or, while it is open, what the issue is and Assign. Then its
stages, the job's steps while one goes, one timeline of everything that happened (model/timeline.ts), and on the
right everything it is linked to. Message opens the agent's chat; Stop asks first, then cancels the job (what was done
stays here).

A job that isn't on an issue (a task, a repo's set-up) has a page of its own at #/jobs/<id>, the same way; a job on
an issue opens that issue's page.
*/

function Related(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col bg-card px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}

function Banner(props: { tone: "warn" | "primary" | "plain"; children: ReactNode }) {
  let tone = "border bg-card";
  if (props.tone === "warn") {
    tone = "border border-warn/40 bg-warn/10";
  }
  if (props.tone === "primary") {
    tone = "border border-primary/40 bg-selected";
  }
  return <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 ${tone}`}>{props.children}</div>;
}

function StopButton(props: { job: Job }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
        Stop
      </Button>
      {confirming && (
        <ConfirmDialog
          title="Stop this work?"
          confirm="Stop"
          danger
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await api(`/api/jobs/${props.job.id}/cancel`, { method: "POST" });
            toast.success("Stopped. What was done so far stays here.");
          }}
        >
          <p>The agent stops working on it. What it did so far stays on this page, and nothing is sent.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

// A Workflow pull request that waits for you: Merge or Reject, each asking first.
function MergeBanner(props: { item: WorkItem }) {
  const pr = props.item.waitingPR!;
  const repo = props.item.workflow!.repo;
  const [dialog, setDialog] = useState<"merge" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  return (
    <Banner tone="primary">
      <span className="min-w-0 flex-1">
        Merge “{pr.title}”?
        {pr.review !== null && pr.review.advice !== null && (
          <span className="text-muted-foreground">
            {" "}
            The review agent says {pr.review.advice === "merge" ? "merge" : "don't merge"}: {pr.review.summary}
          </span>
        )}
      </span>
      <span className="flex gap-1.5">
        <Button size="sm" variant="outline" onClick={() => setDialog("reject")}>
          Reject
        </Button>
        <Button size="sm" onClick={() => setDialog("merge")}>
          Merge
        </Button>
      </span>
      {dialog === "merge" && (
        <ConfirmDialog
          title={`Merge “${pr.title}”?`}
          confirm="Merge"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api(`/api/workflow/${repo}/pulls/${pr.number}/merge`, { method: "POST" });
            toast.success("Merged.");
          }}
        >
          <p>It goes into {repo}'s main branch.</p>
        </ConfirmDialog>
      )}
      {dialog === "reject" && (
        <ConfirmDialog
          title="Reject this pull request?"
          confirm="Reject"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api(`/api/workflow/${repo}/pulls/${pr.number}/reject`, { method: "POST", body: { reason: reason.trim(), close_issue: false } });
            toast.success("Rejected. Its worker tries again with your note.");
          }}
        >
          <Textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why? Its worker reads this." />
        </ConfirmDialog>
      )}
    </Banner>
  );
}

function WorkView(props: { item: WorkItem }) {
  const item = props.item;
  const now = useNow();
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState(false);
  const openJob = item.job !== null && OPEN_JOB.includes(item.job.status) ? item.job : null;
  const issueUrl = item.issue?.html_url ?? item.workflowIssue?.url ?? `https://github.com/${item.repo}/issues/${item.number}`;
  const reviewers = new Set(item.drafts.map((draft) => draft.review?.agent).filter((agent): agent is string => typeof agent === "string"));
  for (const job of item.jobs) {
    if (job.kind === "review") {
      reviewers.add(job.agent);
    }
  }
  const vm = item.job?.vm ?? null;
  const facts = item.issue?.facts ?? null;

  const actions = (
    <div className="flex items-center gap-1.5">
      <StageBadge stage={item.stage} />
      {item.agent !== null && (
        <Button size="sm" variant="outline" asChild>
          <a href={href.agent(item.agent)}>Message</a>
        </Button>
      )}
      {openJob !== null && <StopButton job={openJob} />}
    </div>
  );

  return (
    <div>
      <PageHeader back title={item.title} meta={`${item.repo} #${item.number}`} right={actions} />
      <div className="flex flex-col gap-4 p-4">
        {item.waiting !== null && item.waiting.kind === "question" && (
          <Banner tone="warn">
            <span className="min-w-0 flex-1">
              <Who who={item.waiting.agent} /> asked you: <b className="font-medium">{item.waiting.title}</b>{" "}
              <span className="text-muted-foreground">{questionWhen(item.waiting, now)}</span>
            </span>
            <a href={href.inboxItem(item.waiting.id)} className="text-primary hover:underline">
              Answer
            </a>
          </Banner>
        )}
        {item.waiting !== null && item.waiting.kind !== "question" && (
          <Banner tone="primary">
            <span className="min-w-0 flex-1">
              Waiting for your approval: <b className="font-medium">{askOf(item.waiting)}</b> Nothing has been sent.
            </span>
            <a href={href.inboxItem(item.waiting.id)} className="text-primary hover:underline">
              Open
            </a>
          </Banner>
        )}
        {item.waitingPR !== null && <MergeBanner item={item} />}
        {item.pr !== null && (
          <Banner tone="plain">
            <span>
              Pull request #{item.pr.number} is {item.pr.state === "open" ? "open" : item.pr.state} on GitHub
              {item.pr.state === "open" && ` · checks ${item.pr.checks} · ${item.pr.review === "none" ? "not reviewed yet" : item.pr.review.replace("_", " ")}`}
            </span>
            <a href={item.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
              Open on GitHub <ExternalLink className="size-3" />
            </a>
          </Banner>
        )}
        {item.stage === "open" && item.issue !== null && (
          <Banner tone="plain">
            <span className="min-w-0 flex-1">
              Nobody works on it yet.
              {facts !== null && ` Opened by @${facts.author}, ${facts.comments} comments.`}
              {item.issue.tags?.merge && ` Merge: ${item.issue.tags.merge}.`}
              {item.issue.tags?.reason && <span className="text-muted-foreground"> {item.issue.tags.reason}</span>}
            </span>
            <span className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setRemoving(true)}>
                Remove
              </Button>
              <Button size="sm" onClick={() => setAssigning(true)}>
                Assign
              </Button>
            </span>
          </Banner>
        )}
        {item.workflowIssue !== null && item.stage === "open" && (
          <Banner tone="plain">
            <span>{item.workflowIssue.goal}</span>
          </Banner>
        )}

        <StageSteps stage={item.stage} openSource={item.workflow === null} />
        {openJob !== null && <JobProgressBar job={openJob} />}

        <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-5 max-md:grid-cols-1">
          <Timeline events={buildTimeline(item)} />
          <aside className="flex flex-col gap-px overflow-hidden rounded-lg border bg-border max-md:-order-1">
            {item.agent !== null && (
              <Related label="Agent">
                <Who who={item.agent} />
              </Related>
            )}
            {[...reviewers].map((reviewer) => (
              <Related key={reviewer} label="Reviewer">
                <Who who={reviewer} />
              </Related>
            ))}
            {vm !== null && (
              <Related label="Machine">
                <a href={href.machine(vm)} className="text-primary hover:underline">
                  {vm}
                </a>
              </Related>
            )}
            <Related label="On GitHub">
              <a href={issueUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                Issue #{item.number} ↗
              </a>
              {item.pr !== null && (
                <a href={item.pr.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                  Pull request #{item.pr.number} ↗
                </a>
              )}
            </Related>
            <Related label="Project">
              <a href={href.project(item.repo)} className="text-primary hover:underline">
                {item.repo}
              </a>
            </Related>
          </aside>
        </div>
      </div>
      {assigning && item.issue !== null && <AssignDialog issue={item.issue} onClose={() => setAssigning(false)} />}
      {removing && item.issue !== null && (
        <ConfirmDialog
          title="Remove it from Open?"
          confirm="Remove"
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api("/api/issues/remove", { method: "POST", body: { ids: [item.issue!.id] } });
            window.location.hash = href.project(item.repo);
          }}
        >
          <p>It leaves the project's Open column. Nothing is said on GitHub.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export function WorkItemPage(props: { repo: string; number: number }) {
  const items = useWorkItems();
  const [thread, setThread] = useState<string | null>(null);
  const item = items.get(`${props.repo.toLowerCase()}#${props.number}`);
  if (item === undefined) {
    return (
      <div>
        <PageHeader back title={`${props.repo} #${props.number}`} meta="Not part of any work here." />
        <div className="flex gap-2 p-4">
          <Button size="sm" variant="outline" onClick={() => setThread(`${props.repo}#${props.number}`)}>
            Show it
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={`https://github.com/${props.repo}/issues/${props.number}`} target="_blank" rel="noreferrer">
              Open on GitHub
            </a>
          </Button>
        </div>
        <ThreadDialog id={thread} onClose={() => setThread(null)} />
      </div>
    );
  }
  return <WorkView item={item} />;
}

export function JobPage(props: { id: string }) {
  const jobs = useLive("jobs");
  const drafts = useLive("inbox");
  const items = useWorkItems();
  const job = jobs.find((each) => each.id === props.id);
  const item = job !== undefined ? [...items.values()].find((each) => each.jobs.some((other) => other.id === job.id)) : undefined;

  // A job on an issue: that issue's page is where it shows.
  useEffect(() => {
    if (item !== undefined) {
      window.location.replace(href.work(item.repo, item.number));
    }
  }, [item]);

  if (job === undefined) {
    return <PageHeader back title="Job not found" />;
  }
  if (item !== undefined) {
    return null;
  }
  const open = OPEN_JOB.includes(job.status);
  return (
    <div>
      <PageHeader
        back
        title={job.title}
        meta={job.about || job.kind.replace("_", " ")}
        right={
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary">{JOB_LABEL[job.status] ?? job.status}</Badge>
            <Button size="sm" variant="outline" asChild>
              <a href={href.agent(job.agent)}>Message</a>
            </Button>
            {open && <StopButton job={job} />}
          </div>
        }
      />
      <div className="flex max-w-3xl flex-col gap-4 p-4">
        {job.steps.length > 0 && <JobSteps job={job} />}
        {job.notes !== "" && <div className="rounded-lg border bg-card px-3 py-2 whitespace-pre-wrap">{job.notes}</div>}
        <Timeline events={buildJobTimeline(job, drafts.filter((draft) => draft.job === job.id))} />
      </div>
    </div>
  );
}
