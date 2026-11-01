/*
The Workspace tab's Papers page (#/papers): research papers you gave agents to reproduce, newest first.

Add paper (NewPaperDialog.tsx) gives a paper, a PDF or a link to one, to an agent: a reproduce_paper job. The agent
reads it, rebuilds what it describes in a VM from the paper alone, lines its numbers up with the paper's (and with the
authors' own code), tests the claims, and puts a report in the Inbox (github_searcher/agent/work_tools.py,
draft_report): the paper's numbers next to its own, the problems it found, each with the run that shows it, and its
code. Approving the report ends the job.

Each row is one job: its status, its progress (the step the agent is on), the paper's title with the agent's headline
under it while it works, the agent, the paper's PDF (a download), its newest report (a link to the Inbox) and when it
last changed. A click on a row opens the job (#/jobs/<job id>, on the Home tab).
*/

import { Download, Plus } from "lucide-react";
import { useState } from "react";

import NewPaperDialog from "@/NewPaperDialog";
import { Button } from "@/components/ui/button";
import { JobProgressBar } from "@/components/ui/job-progress";
import { DRAFT_TONE, JOB_LABEL, JOB_TONE, StatusDot } from "@/components/ui/status-dot";
import { useLive, useLoaded } from "@/live";
import { cn } from "@/lib/utils";

// Phone mode (App.tsx) keeps Status and Paper.
const COLUMNS = "grid grid-cols-[120px_165px_minmax(0,1fr)_120px_40px_100px_120px] items-center gap-2 max-md:grid-cols-[110px_minmax(0,1fr)]";

const OPEN = ["queued", "working", "waiting_on_user"];

export default function Papers() {
  const jobs = useLive("jobs");
  const agents = useLive("agents");
  const inbox = useLive("inbox");
  const loaded = useLoaded("jobs");
  const [adding, setAdding] = useState(false);

  const agentNames: Record<string, string> = {};
  for (const each of agents) {
    agentNames[each.id] = each.name;
  }
  const papers = jobs.filter((each) => each.kind === "reproduce_paper").sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          {papers.length} {papers.length === 1 ? "paper" : "papers"}
        </span>
        <span className="text-xs text-muted-foreground max-md:hidden">An agent reproduces each one in a VM and puts its report in the Inbox.</span>
        <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus /> Add paper
        </Button>
      </div>

      <div className={cn(COLUMNS, "h-7 shrink-0 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground")}>
        <span>Status</span>
        <span className="max-md:hidden">Progress</span>
        <span>Paper</span>
        <span className="max-md:hidden">Agent</span>
        <span className="max-md:hidden">PDF</span>
        <span className="max-md:hidden">Report</span>
        <span className="max-md:hidden">Updated</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && papers.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">
            No papers yet. Use Add paper: an agent reads it, rebuilds it in a VM, checks its numbers and claims, and puts a report in the Inbox.
          </div>
        )}
        {papers.map((each) => {
          const isOpen = OPEN.includes(each.status);
          // The newest report on it, if the agent drafted one.
          const reports = inbox.filter((draft) => draft.kind === "report" && each.drafts.includes(draft.id));
          reports.sort((a, b) => b.created_at.localeCompare(a.created_at));
          const report = reports[0];
          return (
            <div
              key={each.id}
              className={cn(COLUMNS, "cursor-pointer border-b px-3 hover:bg-accent/50", isOpen && each.headline !== "" ? "h-11" : "h-7")}
              onClick={() => {
                window.location.hash = `#/jobs/${each.id}`;
              }}
            >
              <span className="flex items-center gap-1.5">
                <StatusDot tone={JOB_TONE[each.status]} />
                {JOB_LABEL[each.status] ?? each.status}
              </span>
              <JobProgressBar job={each} className="max-md:hidden" />
              <span className="min-w-0">
                <span className={cn("block truncate", !isOpen && "text-muted-foreground")}>{each.title.replace(/^Reproduce /, "")}</span>
                {isOpen && each.headline !== "" && (
                  <span className="block truncate text-xs text-muted-foreground" title={each.headline}>
                    {each.headline}
                  </span>
                )}
              </span>
              <a href={`#/agents/${each.agent}`} className="truncate hover:underline max-md:hidden" onClick={(event) => event.stopPropagation()}>
                {agentNames[each.agent] ?? each.agent}
              </a>
              <span className="max-md:hidden">
                {each.paper !== null && (
                  <a
                    href={`/api/agents/${each.agent}/artifacts/file?path=${encodeURIComponent(each.paper)}&download=1`}
                    className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                    title={`Download ${each.paper.split("/").pop()}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Download className="size-3.5" />
                  </a>
                )}
              </span>
              <span className="truncate max-md:hidden">
                {report !== undefined && (
                  <a href={`#/inbox/${report.id}`} className="flex items-center gap-1.5 hover:underline" onClick={(event) => event.stopPropagation()}>
                    <StatusDot tone={DRAFT_TONE[report.status]} />
                    Report
                  </a>
                )}
              </span>
              <span className="truncate text-xs whitespace-nowrap text-muted-foreground tabular-nums max-md:hidden">
                {new Date(each.updated_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </span>
            </div>
          );
        })}
      </div>

      {adding && <NewPaperDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
