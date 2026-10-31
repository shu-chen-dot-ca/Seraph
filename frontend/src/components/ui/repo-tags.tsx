import { Badge } from "@/components/ui/badge"
import type { AIPolicyTag, NewcomerTag, Reviewers, ReviewerTag } from "@/live"

// A repo's status as small tags: how well it fits, what its contribution files say about AI, how newcomers fare, who
// reviews outside PRs (an AI reviewer, maintainers or both), how busy it is, and how many contributors, maintainers and
// unanswered PRs it has; and the labels behind them. The Repos and Explore tables show the same things as plain text
// columns, with these labels; the tags themselves are for places that show one repo, like an open Repos row (and the
// Tracked table's AI policy and newcomers).
//
// What Claude judges is always one of a fixed set (the same keys as the backend), so repos rank the same way every
// time: the AI policy (POLICY_LABEL), what reviewers ask for (ASK_LABEL, from
// repo_signals.py ASKS) and the fit (FIT_LEVELS, from explore.py FIT_LEVELS). A label not in a set (written before
// the set existed) is shown as it is.

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

const POLICY_LABEL: Record<AIPolicyTag, string> = {
  welcome: "AI welcome",
  disclose: "AI: disclose",
  no_ai: "No AI",
  unclear: "AI: unclear",
  none: "No AI policy",
}

// Each tag's color, a Badge variant: green for good news (a lighter green, fine, for second best), amber for "have a
// look", red for bad, gray for the rest.
// Most tags are gray on purpose, so the few colored ones stand out.
type TagVariant = "ok" | "fine" | "warn" | "bad" | "secondary"

const POLICY_VARIANT: Record<AIPolicyTag, TagVariant> = {
  welcome: "ok",
  disclose: "secondary",
  no_ai: "bad",
  unclear: "secondary",
  none: "fine",
}

const POLICY_MEANING: Record<AIPolicyTag, string> = {
  welcome: "AI-assisted contributions are fine",
  disclose: "AI-assisted contributions are allowed under conditions, e.g. saying so",
  no_ai: "AI-generated contributions are not accepted",
  unclear: "AI is mentioned, but what's allowed isn't said",
  none: "Its contribution files say nothing about AI",
}

const NEWCOMER_LABEL: Record<NewcomerTag, string> = {
  welcomes: "Welcomes newcomers",
  ok: "Newcomers OK",
  turned_away: "Turns newcomers away",
  left_waiting: "Leaves newcomers waiting",
  few: "Few newcomers",
}

const NEWCOMER_VARIANT: Record<NewcomerTag, TagVariant> = { welcomes: "ok", ok: "secondary", turned_away: "bad", left_waiting: "bad", few: "secondary" }

const NEWCOMER_MEANING: Record<NewcomerTag, string> = {
  welcomes: "Most first PRs from newcomers get merged, with a first reply within 3 days",
  ok: "Newcomers' first PRs fare neither clearly well nor badly; a slow first reply (over a week) is still OK",
  turned_away: "Newcomers' first PRs are mostly closed unmerged",
  left_waiting: "Newcomers' first PRs over a month old are mostly still open: neither merged nor closed",
  few: "Too few newcomers lately to tell",
}

// Who reviews outside contributors' PRs (repo_signals.py reviewers). Agent only is amber: a PR there may only ever get
// a bot's review.
const REVIEWER_LABEL: Record<ReviewerTag, string> = {
  agent: "Agent only",
  both: "Agent and human",
  human: "Human only",
  few: "Few reviews",
}

const REVIEWER_VARIANT: Record<ReviewerTag, TagVariant> = { agent: "warn", both: "secondary", human: "secondary", few: "secondary" }

const REVIEWER_MEANING: Record<ReviewerTag, string> = {
  agent: "Most outside PRs get a review or comment only from an AI reviewer (a bot like CodeRabbit or Copilot), not from a maintainer",
  both: "Most outside PRs get reviewed by both an AI reviewer and a maintainer",
  human: "Most outside PRs get reviewed only by maintainers, no AI reviewer",
  few: "Too few reviewed outside PRs lately to tell",
}

// What reviewers ask contributors for (repo_signals.py ASKS).
const ASK_LABEL: Record<string, string> = {
  tests: "tests",
  changelog: "a changelog entry",
  docs: "docs",
  issue_first: "an issue first",
  small_prs: "smaller PRs",
  cla: "a signed CLA",
  rebase: "rebasing",
  style: "code style",
  benchmarks: "benchmarks",
  description: "a clear description",
  screenshots: "screenshots",
  design: "agreeing on the design",
}

// How well a repo fits the profile: the number Explore keeps, and the lowest number of each level (explore.py FIT_LEVELS
// keeps 1, 0.75, 0.5 and 0.25; repos added before the levels have any number in between).
const FIT_LEVELS: { level: string; label: string; from: number; variant: TagVariant }[] = [
  { level: "strong", label: "Strong fit", from: 0.875, variant: "ok" },
  { level: "good", label: "Good fit", from: 0.625, variant: "secondary" },
  { level: "some", label: "Some fit", from: 0.375, variant: "secondary" },
  { level: "weak", label: "Weak fit", from: 0, variant: "secondary" },
]

function FitTag(props: { fit: number }) {
  const level = FIT_LEVELS.find((each) => props.fit >= each.from) ?? FIT_LEVELS[FIT_LEVELS.length - 1]
  return (
    <Badge variant={level.variant} title="How well Claude thinks it fits your Explore profile">
      {level.label}
    </Badge>
  )
}

function NewcomersTag(props: { tag: NewcomerTag; detail?: string }) {
  return (
    <Badge variant={NEWCOMER_VARIANT[props.tag]} title={props.detail ? `${NEWCOMER_MEANING[props.tag]}. ${props.detail}` : NEWCOMER_MEANING[props.tag]}>
      {NEWCOMER_LABEL[props.tag]}
    </Badge>
  )
}

// Hover: what it means, and how many reviewed outside PRs went each way. CI and other bots don't count.
function ReviewersTag(props: { reviewers: Reviewers }) {
  const reviewers = props.reviewers
  const total = reviewers.agent + reviewers.both + reviewers.human
  const detail = `${total} reviewed outside PRs: ${reviewers.agent} agent only, ${reviewers.both} agent and human, ${reviewers.human} human only`
  return (
    <Badge variant={REVIEWER_VARIANT[reviewers.tag]} title={`${REVIEWER_MEANING[reviewers.tag]}. ${detail}`}>
      {REVIEWER_LABEL[reviewers.tag]}
    </Badge>
  )
}

// "62 PRs · 41 issues · 180 commits /mo", with an arrow when the last 30 days are well above or below that.
function ActivityTag(props: { prs: number; issues: number; commits: number; trend: "up" | "down" | "flat" }) {
  const arrow = props.trend === "up" ? " ↑" : props.trend === "down" ? " ↓" : ""
  const trend = props.trend === "up" ? "busier" : props.trend === "down" ? "quieter" : "about as busy"
  return (
    <Badge variant="secondary" title={`A month on average over 90 days; the last 30 days were ${trend}`}>
      {COUNT.format(props.prs)} PRs · {COUNT.format(props.issues)} issues · {COUNT.format(props.commits)} commits /mo{arrow}
    </Badge>
  )
}

function PolicyTag(props: { tag: AIPolicyTag; quote?: string; file?: string }) {
  const title = props.quote ? `${POLICY_MEANING[props.tag]}: "${props.quote}" (${props.file})` : POLICY_MEANING[props.tag]
  return (
    <Badge variant={POLICY_VARIANT[props.tag]} title={title}>
      {POLICY_LABEL[props.tag]}
    </Badge>
  )
}

// People and the PRs left alone, as numbers, always shown once counted: who opened PRs lately (contributors), who
// merged PRs in the last 30 days (maintainers; amber at one or none), and outside PRs over 30 days old that nobody
// answered (amber from 5).
function ContributorsTag(props: { count: number }) {
  return (
    <Badge variant="secondary" title="People who opened a PR lately (the newest 100 PRs, at most 90 days; bots not counted)">
      {props.count} {props.count === 1 ? "contributor" : "contributors"}
    </Badge>
  )
}

function MaintainersTag(props: { count: number }) {
  return (
    <Badge variant={props.count <= 1 ? "warn" : "secondary"} title="People who merged a PR in the last 30 days (bots not counted)">
      {props.count} {props.count === 1 ? "maintainer" : "maintainers"}
    </Badge>
  )
}

function UnansweredTag(props: { count: number }) {
  return (
    <Badge variant={props.count >= 5 ? "warn" : "secondary"} title="Outside contributors' PRs open over 30 days that nobody answered">
      {props.count} unanswered {props.count === 1 ? "PR" : "PRs"}
    </Badge>
  )
}

export {
  ActivityTag,
  ASK_LABEL,
  ContributorsTag,
  FIT_LEVELS,
  FitTag,
  MaintainersTag,
  NEWCOMER_LABEL,
  NewcomersTag,
  POLICY_LABEL,
  PolicyTag,
  ReviewersTag,
  UnansweredTag,
}
