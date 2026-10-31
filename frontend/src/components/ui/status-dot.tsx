import { cn } from "@/lib/utils"

// The one status dot used everywhere. Colors (tokens in index.css):
// green = working / running / using, amber = waiting on you / in queue / changing state,
// gray = idle / off / done, red = error / failed.
type Tone = "green" | "amber" | "gray" | "red"

const TONE_CLASS: Record<Tone, string> = {
  green: "bg-ok",
  amber: "bg-warn",
  gray: "bg-idle",
  red: "bg-destructive",
}

// Status → tone for each record kind. Unknown statuses fall back to gray at the call site: TONE[x] ?? "gray".
const AGENT_TONE: Record<string, Tone> = {
  idle: "gray",
  working: "green",
  in_queue: "amber",
  in_priority: "amber",
  using_vm: "green",
}

const VM_TONE: Record<string, Tone> = {
  running: "green",
  creating: "amber",
  starting: "amber",
  stopping: "amber",
  stopped: "gray",
  failed: "red",
  missing: "red",
}

const JOB_TONE: Record<string, Tone> = {
  queued: "amber",
  working: "green",
  waiting_on_user: "amber",
  done: "gray",
  cancelled: "gray",
}

const JOB_LABEL: Record<string, string> = {
  queued: "Queued",
  working: "Working",
  waiting_on_user: "Waiting on you",
  done: "Done",
  cancelled: "Cancelled",
}

const DRAFT_TONE: Record<string, Tone> = {
  pending: "amber",
  approved: "green",
  rejected: "red",
  replied: "gray",
}

function StatusDot(props: { tone: Tone | undefined; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        TONE_CLASS[props.tone ?? "gray"],
        props.className
      )}
    />
  )
}

export { StatusDot, AGENT_TONE, VM_TONE, JOB_TONE, JOB_LABEL, DRAFT_TONE }
export type { Tone }
