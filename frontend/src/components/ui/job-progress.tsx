import { Check } from "lucide-react"
import { useEffect, useState } from "react"

import type { AgentSummary, Job } from "@/live"
import { cn } from "@/lib/utils"

// A job's progress, as every page shows it. The agent sets the step it is on and a headline in everyday
// words (job_progress); the rest comes by itself: the agent's last action, its todo list, the times.
// Waiting on the user, done and cancelled are not steps: the job's status says them, after the last step.
//
//   <JobProgressBar job={job} />   compact: one segment per step, and the step's name
//   <JobSteps job={job} />         full: every step by name, the current one marked
//
// Times are shown relative to now, so a page that shows them re-renders with useNow().

// No event for this long while the agent is in a turn: it may be stuck (or running something slow).
const STUCK_MS = 5 * 60 * 1000

// "set_up" → "Set up"
function stepLabel(step: string): string {
  const words = step.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// How long ago, short: "40s", "12m", "1h 5m", "2d 3h". Empty for no time.
function since(iso: string | null, now: number): string {
  if (iso === null) {
    return ""
  }
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// The current time, refreshed every 30 seconds, for the "12m" times to move along.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

// The job an agent is on: the one it works on (the latest changed), else the next one it will start.
function currentJob(agentId: string, jobs: Job[]): Job | undefined {
  const mine = jobs.filter((job) => job.agent === agentId)
  const working = mine.filter((job) => job.status === "working").sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  if (working.length > 0) {
    return working[0]
  }
  const queued = mine.filter((job) => job.status === "queued").sort((a, b) => a.created_at.localeCompare(b.created_at))
  return queued[0]
}

// How long the agent has been quiet in its turn, when that is long enough to look stuck; else "".
// Not while a tool runs (a command, the test suite): that is work, and every tool has a time limit.
function stuckFor(agent: AgentSummary, now: number): string {
  if (!agent.busy || agent.last_event_at === null || agent.in_tool) {
    return ""
  }
  if (now - new Date(agent.last_event_at).getTime() < STUCK_MS) {
    return ""
  }
  return since(agent.last_event_at, now)
}

// Where a job is: the index of its step (-1 before the first), and what to call it.
function position(job: Job): { index: number; label: string } {
  const index = job.step !== null ? job.steps.indexOf(job.step) : -1
  if (job.status === "waiting_on_user") {
    return { index, label: "Waiting on you" }
  }
  if (job.status === "done") {
    return { index: job.steps.length, label: "Done" }
  }
  if (job.status === "cancelled") {
    return { index, label: "Cancelled" }
  }
  if (index === -1) {
    return { index, label: job.status === "queued" ? "Not started" : "Starting" }
  }
  return { index, label: `${stepLabel(job.steps[index])} ${index + 1}/${job.steps.length}` }
}

function JobProgressBar(props: { job: Job; className?: string }) {
  const job = props.job
  const { index, label } = position(job)
  return (
    <span className={cn("flex min-w-0 items-center gap-2", props.className)} title={job.steps.map(stepLabel).join(" → ")}>
      <span className="flex h-1.5 w-16 shrink-0 gap-px overflow-hidden rounded-full">
        {job.steps.map((step, stepIndex) => (
          <span
            key={step}
            className={cn(
              "h-full flex-1 bg-muted",
              stepIndex < index && (job.status === "cancelled" ? "bg-idle" : "bg-ok"),
              // The step being worked on breathes, so a working job looks alive at a glance.
              stepIndex === index && job.status === "working" && "animate-pulse bg-primary",
              stepIndex === index && job.status === "queued" && "bg-primary/60",
              stepIndex === index && job.status === "waiting_on_user" && "bg-warn",
              stepIndex === index && job.status === "cancelled" && "bg-idle"
            )}
          />
        ))}
      </span>
      <span
        className={cn(
          "truncate text-xs tabular-nums",
          job.status === "waiting_on_user" ? "text-warn" : "text-muted-foreground",
          job.status === "working" && "text-foreground"
        )}
      >
        {label}
      </span>
    </span>
  )
}

function JobSteps(props: { job: Job; className?: string }) {
  const job = props.job
  const { index } = position(job)
  // After the steps: the job's status once it is past working.
  let end = ""
  if (job.status === "waiting_on_user") {
    end = "Waiting on you"
  }
  if (job.status === "done") {
    end = "Done"
  }
  if (job.status === "cancelled") {
    end = "Cancelled"
  }
  return (
    <div className={cn("flex flex-wrap items-center gap-x-1 gap-y-1 text-xs", props.className)}>
      {job.steps.map((step, stepIndex) => (
        <span key={step} className="flex items-center gap-1">
          {stepIndex > 0 && <span className="text-muted-foreground/60">→</span>}
          <span
            className={cn(
              "flex h-5 items-center gap-1 rounded-sm px-1.5",
              // Done steps (with a check) and the ones still to come read alike: only the current step stands out.
              stepIndex !== index && "text-muted-foreground",
              stepIndex === index && job.status === "working" && "bg-primary font-medium text-primary-foreground",
              stepIndex === index && job.status === "queued" && "bg-primary/15 font-medium",
              stepIndex === index && job.status === "waiting_on_user" && "bg-warn/20 font-medium",
              stepIndex === index && job.status === "cancelled" && "bg-muted font-medium"
            )}
          >
            {stepIndex < index && <Check className="size-3 text-ok" />}
            {stepLabel(step)}
          </span>
        </span>
      ))}
      {end !== "" && (
        <span className="flex items-center gap-1">
          <span className="text-muted-foreground/60">→</span>
          <span
            className={cn(
              "flex h-5 items-center rounded-sm px-1.5 font-medium",
              job.status === "waiting_on_user" && "bg-warn/20",
              job.status === "done" && "bg-ok/20",
              job.status === "cancelled" && "bg-muted text-muted-foreground"
            )}
          >
            {end}
          </span>
        </span>
      )}
    </div>
  )
}

// The project's tests for a job, in plain words: on the code as it was, then with the change.
// Both must pass: the first before the agent may change anything, the second before it may draft a PR.
// The basic checks (the tests that cover the change), or the project's official checks (what its rules ask to run
// before a PR); it says which.
function JobTests(props: { job: Job; className?: string }) {
  const before = props.job.tests?.before ?? null
  const after = props.job.tests?.after ?? null
  if (before === null && after === null) {
    return <div className={cn("text-xs text-muted-foreground", props.className)}>Project's tests: not run yet.</div>
  }
  const runs = [
    { label: "on the code as it was", run: before },
    { label: "with the change", run: after },
  ]
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", props.className)}>
      <span className="text-muted-foreground">
        {before !== null && before.scope === "focused" ? "Basic checks (the project's tests that cover the change):" : "Project's official checks:"}
      </span>
      {runs.map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          {item.run === null && <span className="text-muted-foreground">not run {item.label} yet</span>}
          {item.run !== null && (
            <>
              <span className={cn("font-medium", item.run.passed ? "text-ok" : "text-destructive")}>
                {item.run.passed ? "passed" : item.run.exit_code === null ? "stopped (too long)" : "failed"}
              </span>
              <span className="text-muted-foreground">
                {item.label} · {item.run.seconds >= 60 ? `${Math.floor(item.run.seconds / 60)}m` : `${item.run.seconds}s`}
              </span>
            </>
          )}
        </span>
      ))}
      {before !== null && <code className="truncate font-mono text-muted-foreground" title={before.command}>{before.command}</code>}
    </div>
  )
}

export { JobProgressBar, JobSteps, JobTests, currentJob, since, stepLabel, stuckFor, useNow }
