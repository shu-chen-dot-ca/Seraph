/*
Live data from the backend, and the one fetch helper.

One websocket to /api/live. On connect the server sends every topic, then only the topics that changed:
{"topic": "repos" | "issues" | "tracked" | "explore" | "github" | "jobs" | "inbox" | "issue_drafts" | "prs" | "your_repos" | "notifications" | "agents"
| "vms" | "images" | "resource" | "updates" | "projects" | "crashes" | "workflow",
"data": ...}.
Each message replaces that topic in the store, and components read it with useLive(topic), so the page never
polls and never re-fetches lists. When the socket drops it reconnects after a second, and the server sends
everything again. When the app that answers is another version than this page's (an update restarted it, see
UpdateDialog.tsx), the page reloads into the new version, at the same place (the page is in the URL). Through the remote access address without a sign in, the server closes it with 4401 and the page
opens the Sign in page instead (backend/app.py).

The page sends one thing back: {"watch_resource": true | false}, whether a Resource page is open
(useWatchResource). Only then does the backend ask the NVIDIA GPU for its numbers, so it can sleep otherwise.

The types below mirror the records in the spec (data/*.json and the live summaries).
*/

import { useEffect, useSyncExternalStore } from "react";

// ---- Records ----

export type RepoItem = {
  full_name: string;
  description: string;
  stars: number;
  default_branch: string;
  html_url: string;
  note: string;
  added_by: string; // "user", "explore" or an agent id
  added_at: string;
  lane?: string; // repos Explore found: the profile lane it was found for ("prestige", "ai", ...)
  fit?: number; // repos Explore found: how well Claude thinks it fits the profile, 0..1
  tag?: string; // the user's own group for the repo, the Repos list's on every page when it is in it; missing or "" when none
};

// What a repo's contribution files say about AI (github_searcher/repo_signals.py).
export type AIPolicyTag = "welcome" | "disclose" | "no_ai" | "unclear" | "none";

export type AIPolicy = {
  tag: AIPolicyTag;
  quote: string; // the sentence that decides it ("" for unclear and none)
  file: string;
  basis: string;
};

export type BeginnerIssue = {
  number: number;
  title: string;
  created_at: string;
  labels: string[];
  assignees: number;
  cross_references: number; // a PR or issue that mentions it: above 0 usually means someone is on it
};

// How a repo treats outside contributors, from GitHub (github_searcher/repo_signals.py). Over outside contributors'
// PRs opened in the last 90 days; null when there are too few to tell.
export type RepoSignals = {
  fetched_at: string;
  stars: number;
  description: string;
  topics: string[];
  language: string | null;
  archived: boolean;
  fork: boolean;
  pushed_at: string;
  outside_prs_90d: number;
  outside_merged_90d: number;
  outside_closed_90d: number;
  outside_merge_rate: number | null; // merged / (merged + closed unmerged)
  median_days_to_first_reply: number | null;
  median_days_to_merge: number | null;
  stale_outside_prs: number; // open over 30 days, nobody answered
  active_mergers_30d: number; // people who merged a PR in 30 days: the page calls them maintainers
  active_contributors?: number; // people who opened a PR in the window; missing until the next fetch
  commits_30d: number;
  beginner_issues: BeginnerIssue[];
  unclaimed_beginner_issues: number;
  pr_window_days?: number; // how many days the 100 newest PRs reach back (at most 90)
  // Missing on signals fetched before these were counted (until their next daily fetch).
  newcomers?: Newcomers;
  reviewers?: Reviewers;
  activity?: RepoActivity;
  community?: Community;
  atmosphere?: Atmosphere | null; // null until Claude first read the reviews
  ai_policy: AIPolicy;
};

export type NewcomerTag = "welcomes" | "ok" | "turned_away" | "left_waiting" | "few";

// Who reviews outside contributors' PRs: how many got a review or comment only from an AI reviewer (a bot like
// CodeRabbit or Copilot), from both, or only from maintainers; tag is the one most are ("few": too few to tell).
export type ReviewerTag = "agent" | "both" | "human" | "few";
export type Reviewers = { agent: number; both: number; human: number; tag: ReviewerTag };

// Outside authors who never opened a PR in the repo before the window, and how their first PRs went.
export type Newcomers = {
  prs: number;
  merged: number;
  closed: number;
  merge_rate: number | null;
  median_days_to_first_reply: number | null;
  returned: number; // opened a second PR
  authors_checked: number;
  tag: NewcomerTag;
};

// Monthly averages over 90 days, and the last 30 days as they are.
export type RepoActivity = {
  prs_opened_month: number;
  prs_merged_month: number;
  issues_opened_month: number;
  issues_closed_month: number;
  commits_month: number;
  prs_opened_30d: number;
  prs_merged_30d: number;
  issues_opened_30d: number;
  issues_closed_30d: number;
  trend: "up" | "down" | "flat";
  last_release: string | null;
  last_release_at: string | null;
  issue_reply_rate: number | null; // share of outsiders' new issues a maintainer answered within a week
  issues_checked: number;
};

export type Community = {
  contributing: boolean;
  code_of_conduct: boolean;
  discussions: boolean;
  channels: string[]; // "Discord", "Slack", ...
};

export type Tone = "warm" | "neutral" | "strict" | "curt" | "unknown";

// How maintainers' feedback on outside PRs feels, read by Claude at most once a week.
export type Atmosphere = {
  tone: Tone;
  summary: string;
  asks_for: string[];
  prs: number;
  judged_at: string;
};

// A repo in the Repos list, with what the live feed merges in.
export type ListedRepo = RepoItem & {
  signals: RepoSignals | null; // null until fetched (within seconds of being added)
};

export type IssueItem = {
  id: string; // "owner/name#812"
  repo: string;
  number: number;
  title: string;
  labels: string[];
  state: "OPEN" | "CLOSED";
  comments: number;
  html_url: string;
  note: string;
  added_by: string;
  added_at: string;
  facts?: IssueFacts | null; // Merged in by the live feed; null until fetched from GitHub.
  tags?: IssueTags | null; // Merged in by the live feed; null until made.
};

// The tags the app puts on an issue, the same on the Tracked and Issues pages (github_searcher/issue_tags.py), in
// place of GitHub's labels. status: free (a newcomer can start now), assigned (someone is on it) or waiting (nobody
// is, but it isn't ready). merge is whether a pull request from us would get merged: likely, or the first thing in the
// way; out of scope (we don't take it: not a pull request to that repo for its own users, made and run in a Linux VM,
// or it touches politics) can't be assigned. lines is a rough guess of the lines the fix adds and removes, tests
// included. checks, kind and lines are null when it is assigned on GitHub (not asked); merge is missing on tags from
// before it (they had a level), until they are read again.
export type IssueTags = {
  // fixed: open on GitHub, but a merged pull request or commit already does what it asks; it only needs closing.
  status: "free" | "assigned" | "waiting" | "fixed";
  merge?: Merge;
  // The yes / no answers merge follows from by fixed rules, with the status and the repo's numbers.
  checks?: Record<string, boolean> | null;
  kind: "bug" | "feature" | "docs" | "question" | null;
  lines?: number | null;
  reason: string;
  updated_at: string;
  judged_at: string;
};

export type Merge =
  | "likely"
  | "fixed"
  | "out of scope"
  | "claimed"
  | "maintainers only"
  | "waiting"
  | "no outside prs"
  | "large feature"
  | "big change"
  | "can't validate";

// What GitHub says about an issue right now (github_searcher/issue_facts.py).
// Roles are GitHub's author association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...) or BOT.
export type IssueFacts = {
  state: "OPEN" | "CLOSED";
  title: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  author: string;
  author_role: string;
  assignees: string[];
  participants: number;
  thumbs_up: number;
  comments: number;
  last_comment_at: string | null;
  last_comment_by: string | null;
  last_comment_role: string | null;
  linked_prs: { number: number; repo: string; state: "OPEN" | "CLOSED" | "MERGED"; url: string; author: string }[];
  repo_stars: number;
  repo_pushed_at: string;
  fetched_at: string;
};

// One open issue a tracked repo's last check found (github_searcher/tracked_issues.py).
export type TrackedIssue = {
  number: number;
  title: string;
  url: string;
  created_at: string;
  updated_at?: string; // its last change on GitHub, a new comment too; missing in checks made before it was asked for
  author: string;
  labels: string[];
  comments: number;
  assignees: number;
  tags?: IssueTags | null; // Merged in by the live feed; null until made.
};

// A tracked repo's latest check. An issue is new for three days after it was opened, unless it is in read.
export type TrackedCheck = {
  checked_at: string;
  error: string | null; // why the last check failed (the issues are from the check before)
  stars: number | null;
  description: string;
  issues: TrackedIssue[]; // newest first
  read?: number[]; // the issues Mark all as read saw; missing in checks made before it was there
};

// A repo in the Tracked list, with its latest check merged in by the live feed (null until the first one).
// signals: the same as a Repos row's, null until fetched (within seconds of being tracked).
export type TrackedRepo = RepoItem & { check: TrackedCheck | null; signals: RepoSignals | null };

// Explore (github_searcher/explore.py): the profile it searches with, the current or last run, and the found list.
export type ExploreLane = {
  id: string;
  label: string;
  about: string; // what the lane is for, given to Claude when it judges fit
  share: number; // 0..100: the part of the finds that should come from this lane
  queries: string[]; // GitHub repo searches
};

// The user writes about, and each type of repo (a lane's label and about); Claude plans each one's
// searches when the profile is saved. The types are the tags that classify repos (a repo's "lane").
export type ExploreProfile = {
  about: string;
  lanes: ExploreLane[];
};

// A repo Explore found, waiting for the user to approve it into Repos or remove it. Kept across runs.
export type ExploreFound = {
  name: string;
  lane: string;
  description: string;
  stars: number;
  default_branch: string;
  html_url: string;
  fit: number;
  ai_policy: AIPolicyTag;
  newcomers: NewcomerTag;
  tone: Tone | null;
  atmosphere: string; // its one-sentence summary
  prs_month: number;
  issues_month: number;
  commits_month: number;
  trend: "up" | "down" | "flat";
  note: string;
  found_at: string;
  // From its signals: outside PRs merged (of those merged or closed, 0..1), how newcomers' first PRs went (counts and
  // their merge rate; prs is how many new contributors it had in window_days), median days to a maintainer's first
  // reply on an outside PR, how many days its 100 newest PRs cover, who merged PRs in 30 days, outside PRs over 30
  // days nobody answered, who reviews outside PRs.
  // Null when not counted (too few PRs, or found before these were).
  merged: number | null;
  newcomer_stats: Newcomers | null;
  reply: number | null;
  window_days: number | null;
  maintainers: number | null;
  unanswered: number | null;
  reviewers?: Reviewers | null;
};

export type ExploreRun = {
  status: "running" | "done" | "stopped" | "failed";
  started_at: string;
  ended_at: string | null;
  end_reason: string;
  count: number | null;
  minutes: number | null;
  workers: number;
  filters: Record<string, "include" | "exclude">; // the tags it keeps to or keeps out (explore.py FILTERS)
  found: number;
  looked_at: number;
  lanes: Record<string, { label: string; share: number; found: number; in_flight: number; exhausted: boolean }>;
  checking: { name: string; lane: string; since: string }[];
  skipped: Record<string, number>; // why → how many
  errors: { name: string; error: string; at: string }[];
};

export type ExploreData = {
  profile: ExploreProfile;
  run: ExploreRun | null;
  found: ExploreFound[]; // waiting for a decision, oldest first
};

// GitHub's rate limits (github_searcher/token_balancer.py), per kind of request and token. remaining and limit are
// null until known; a quota whose reset_at has passed is full again. Times are ISO.
export type GithubKind = "core" | "graphql" | "search" | "code_search";

export type GithubStatus = Record<
  GithubKind,
  {
    waiting: number;
    tokens: { name: string; remaining: number | null; limit: number | null; reset_at: string | null; paused_until: string | null; running: number }[];
  }
>;

export type ListData<T> = {
  items: T[];
  can_undo: boolean;
  can_redo: boolean;
};

// Proof an agent shows for its drafts (github_searcher/jobs.py). Files are served by /api/evidence/<name>.
export type EvidenceItem = {
  id: string;
  kind: "screenshot" | "image" | "command";
  topic: string; // pairs a before with its after
  stage: "before" | "after" | "other";
  context?: string; // how to read the comparison, in plain words (missing on early evidence)
  caption: string;
  file: string | null; // screenshot and image: "ev_a1b2c3.jpg"
  command: string | null;
  exit_code: number | null;
  output_file: string | null; // command: the whole output, "ev_a1b2c3.txt"
  output_tail: string; // command: its last lines
  output_size: number; // command: bytes of the whole output
  created_at: string;
};

export type JobStatus = "queued" | "working" | "waiting_on_user" | "done" | "cancelled";

export type Job = {
  id: string;
  kind: string; // "fix_issue" | "task" | "reproduce_paper" | future kinds
  title: string;
  agent: string;
  issue: string | null;
  thread: string | null; // follow_up: the PR or issue on GitHub it answers ("owner/name#n")
  paper: string | null; // reproduce_paper: the PDF in the agent's artifacts ("papers/name.pdf")
  repo: string | null;
  vm: string | null;
  status: JobStatus;
  instructions: string;
  notes: string;
  drafts: string[];
  evidence: EvidenceItem[];
  created_by: string;
  created_at: string;
  updated_at: string;
  // Progress, set by the agent (job_progress). steps are this kind's fixed steps, step the one it is on.
  steps: string[];
  step: string | null;
  step_at: string | null; // when it got to that step
  started_at: string | null; // when the job first became "working"
  about: string; // what the job is about, in everyday words
  headline: string; // where it stands now, in everyday words
  detail: string; // the same, technical
  // The project's tests: on the unchanged code (must pass before any change) and on the finished change.
  tests: { before: TestRun | null; after: TestRun | null };
  // What happened, oldest first (github_searcher/jobs.py): made, each step the agent reached (its headline), status
  // changes, test runs, and what the app told the agent. [] on jobs from before it was kept.
  timeline: JobEvent[];
};

export type JobEvent = { at: string; kind: "created" | "step" | "status" | "tests" | "notice"; text: string; step?: string };

export type TestRun = {
  command: string;
  scope?: "full" | "focused"; // full: the project's official checks; focused: the basic ones, the tests that cover the change. Missing: full
  base: string;
  exit_code: number | null; // null: stopped at the time limit
  passed: boolean;
  diff_hash: string; // the code it ran on ("" for before)
  evidence: string; // the evidence item with its output
  seconds: number;
  at: string;
};

// What a draft is about, in plain words for the user (github_searcher/inbox.py). PRs have problem, cause, fix, risks,
// checklist and also_tested; comments have problem and why. A report on a paper (draft_report) has paper, claims,
// verdict, results, problems and unchecked.
export type DraftOverview = {
  project?: string;
  problem?: string;
  cause?: string;
  fix?: string;
  risks?: string[];
  checklist?: ChecklistPoint[]; // every point that was asked, done or not (PRs from before it have none)
  also_tested?: string[]; // the cases of the same kind the agent ran beyond the asked example
  why?: string;
  paper?: string;
  claims?: string;
  verdict?: string;
  results?: ReportResult[];
  problems?: ReportProblem[];
  unchecked?: string[];
};

// One point a PR draft was asked for (the issue's requirement, or a reviewer's point): whether it does it, and what shows
// it or why not.
export type ChecklistPoint = { item: string; done: boolean; how: string };

// One number of a paper next to the agent's (and what the authors' own code gives, "" when not run).
export type ReportResult = { what: string; paper: string; ours: string; authors: string; note: string };

// A problem the agent found in a paper; evidence is the command run on the job that shows it.
export type ReportProblem = { title: string; what: string; why: string; evidence: string };

export type DraftStatus = "pending" | "approved" | "rejected" | "replied";

export type Draft = {
  id: string;
  kind: "pr" | "comment" | "question" | "taken" | "report" | "edit"; // taken: made by the app, an issue an agent works on isn't free anymore; report: on a paper; edit: a new title and description for your own PR or issue
  agent: string;
  job: string | null;
  repo: string | null;
  target: string | null;
  title: string;
  body: string;
  diff: string;
  branch: string;
  base: string;
  vm: string | null;
  path: string | null;
  evidence: EvidenceItem[]; // the job's evidence when the draft was made
  overview: DraftOverview; // for the user; {} on drafts from before overviews
  template: string | null; // the repo's PR template the body was checked against
  status: DraftStatus;
  reply: string;
  created_at: string;
  decided_at: string | null;
  base_sha: string; // the commit the diff starts from; "" on drafts from before sending
  commits: DraftCommit[]; // PRs: the branch's commits since base, replayed when it is sent ([]: one commit)
  sent: DraftSent | null; // what went to GitHub as you (github_searcher/github_account.py); null until then
  update_of: string | null; // PR: a new version of your open PR "owner/name#n"; approving pushes it onto that PR
  rebase_of: string | null; // PR update: a rebase, its commits replace the PR's; the PR's commit it replaces (approving force-pushes)
  edited: boolean; // you edited its title or text before deciding
  review: DraftReview | null; // a project's PR: its review (only passed ones reach the Inbox)
  replaces: string | null; // a project's PR made again on the new main: the PR "owner/name#n" it replaces
  previous: { title: string; body: string } | null; // edit: the title and description as they were when drafted
  options: string[]; // question: the answers to pick from, one button each ([]: answer in your own words)
};

// A project's PR draft is reviewed by the project's reviewer before it reaches the Inbox (github_searcher/inbox.py).
export type DraftReview = {
  state: "waiting" | "passed" | "changes";
  agent: string | null; // the reviewer
  job: string | null;
  notes: string;
  at: string;
};

// One of a PR branch's commits, sent with your name. own: the agent's (the VM's git address); every commit of a new
// draft is (draft_pr refuses anyone else's), and a draft with someone else's commit isn't sent.
export type DraftCommit = {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  own: boolean;
  vm_email: string;
  diff: string;
};

// A PR or comment Approve sent to GitHub from your account. PRs keep what following them up will need.
export type DraftSent = {
  kind: "pr" | "comment" | "edit";
  url: string;
  number: number;
  repo: string;
  as: string; // your GitHub login
  at: string;
  fork?: string; // PR: "you/name"
  branch?: string; // PR: its branch in the fork
  base_branch?: string;
  base_sha?: string;
  commit?: string;
  id?: number; // comment: its id on GitHub
  deleted_at?: string; // comment: when you deleted it on the GitHub tab
  title?: string; // edit: the new title it set
  update?: boolean; // PR: a new version pushed onto a PR that was already open
  rebase_of?: string | null; // PR update: the PR's commit a rebase replaced (a force push)
  comment_url?: string | null; // PR update: the comment posted with it (null: none was)
  comment_error?: string | null; // PR update: why GitHub refused the comment, when it did (the push went through)
};

// One of your PRs on GitHub and how it stands (github_searcher/pr_tracking.py): the ones Approve sent, and your
// other PRs on other people's projects. role is GitHub's word for the person (MEMBER, COLLABORATOR, OWNER, ..., BOT).
export type TrackedPR = {
  id: string; // "owner/name#number"
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: "open" | "merged" | "closed";
  draft: boolean; // GitHub's draft PR
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_by: string | null;
  labels: string[];
  checks: "waiting" | "running" | "passed" | "failed" | "none"; // waiting: GitHub Actions waits for a maintainer to approve
  waiting_runs: number;
  review: "approved" | "changes_requested" | "commented" | "none";
  reviewers: { login: string; state: string; at: string; role: string }[]; // each reviewer's latest review
  comments: number;
  last_comment: { login: string; role: string; at: string; text: string } | null;
  issues: { number: number; title: string; url: string; state: "open" | "closed"; reason: string | null; assignees: string[] }[];
  draft_id: string | null; // the Inbox draft it was sent from
  job: string | null;
  agent: string | null; // the agent that follows it: the one you picked, else the one whose draft it was sent from
  agent_mode: AgentMode;
  relation: "author" | "commented"; // you opened it, or only commented on it
  head: { repo: string; branch: string; sha: string } | null; // its branch and newest commit (null: the branch is gone)
  base: string | null; // the branch it goes into
  mergeable: "yes" | "conflicts" | "unknown"; // whether it conflicts with base (unknown while GitHub works it out)
  last_activity: ThreadActivity | null;
  your_last_at: string | null; // your newest comment or review there
  checked_at: string;
  error: string | null; // why the last read failed (the status before stays)
};

// drafts: its agent drafts replies and fixes when someone else writes there or its checks fail, and you approve
// each in the Inbox; off: no drafts. Nothing ever goes to GitHub without your approval.
export type AgentMode = "drafts" | "off";

// The newest comment or review on a PR or issue by someone other than you (bots don't count).
export type ThreadActivity = { login: string; at: string; what: "comment" | "review" };

// One of your issues on GitHub (pr_tracking.py): ones you opened and ones you commented on, on other people's projects.
export type GithubIssue = {
  id: string; // "owner/name#number"
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: "open" | "closed";
  reason: string | null; // closed: completed, not_planned or duplicate
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: string[];
  assignees: string[];
  comments: number;
  last_comment: { login: string; role: string; at: string; text: string } | null;
  relation: "author" | "commented";
  agent: string | null;
  agent_mode: AgentMode;
  last_activity: ThreadActivity | null;
  your_last_at: string | null;
  checked_at: string;
  error: string | null;
};

export type PRsData = {
  items: TrackedPR[]; // the newest change first
  issues: GithubIssue[]; // the newest change first
  checked_at: string | null;
  error: string | null; // why the search for your PRs or issues failed
  refreshing: boolean;
};

// A repo of yours on GitHub (public or private, one you can push to) or one you starred
// (github_searcher/your_repositories.py, read with your sign-in). checks: the default branch's newest commit's.
export type YourRepo = {
  name: string; // owner/name
  private: boolean;
  fork: boolean;
  description: string;
  url: string;
  default_branch: string;
  pushed_at: string | null;
  checks: "passed" | "failed" | "running" | "none";
  open_issues: number;
  open_prs: number;
  stars: number;
  starred: boolean; // you starred it
  can_push: boolean; // one of your repositories: a maintainer's buttons
  parent: string | null; // a fork: the repo it was forked from
};

export type YourReposData = {
  repos: YourRepo[]; // the ones you can push to, most recently pushed first
  starred: YourRepo[]; // the ones you starred and can't push to, most recently starred first
  parents: YourRepo[]; // the repos your forks were forked from, when in neither list
  login: string | null; // who they were read for; null when not signed in
  checked_at: string | null;
  error: string | null;
};

// One of GitHub's own notifications for you (github_searcher/notifications.py). reason and type are GitHub's words.
export type GithubNotification = {
  id: string;
  unread: boolean;
  reason: string; // mention, review_requested, assign, author, comment, ci_activity, state_change, subscribed, ...
  updated_at: string;
  title: string;
  type: string; // Issue, PullRequest, Release, CheckSuite, Discussion, Commit, ...
  repo: string;
  number: number | null; // an issue's or PR's
  url: string;
};

export type NotificationsData = {
  items: GithubNotification[]; // the newest first
  login: string | null;
  checked_at: string | null;
  error: string | null;
};

// Your GitHub account (GET /api/github_account, the GitHub tab's Account page), the one that sends what you approve
// and that the GitHub tab's buttons act as. Never the token.
export type GithubAccountStatus = {
  connected: boolean;
  // Whether Sign in with GitHub is set up (the app registered on GitHub, its client ID and secret saved).
  can_sign_in?: boolean;
  login?: string;
  name?: string;
  scopes?: string[];
  connected_at?: string;
};

// in_priority: it stepped aside from its VM while its run goes, and gets the VM back first.
export type AgentStatus = "idle" | "working" | "in_queue" | "in_priority" | "using_vm";

export type AgentSummary = {
  id: string;
  name: string;
  target_vm: string | null;
  status: AgentStatus;
  busy: boolean;
  vm: string | null; // the VM it is queued for or holds
  desktop: number | null; // the desktop of that VM it holds, stepped aside from or asked for (null: any)
  place: number | null; // 0 = holder, n = place in the queue (or in the priority line, for in_priority)
  context_used: number;
  context_max: number;
  cost_usd: number;
  history_length: number;
  pending: number; // user messages waiting for the current turn to end
  queued: string[]; // their texts, oldest first
  activity: string; // the last tool summary or system line
  last_event_at: string | null; // when something last happened in its turn (to tell a slow command from a stuck agent)
  in_tool: boolean; // a tool call is running (a command, the test suite): quiet then is not stuck
  todo_done: number; // from its latest todo list
  todo_total: number;
  created_at: string;
  archived_at: string | null; // archived: stopped, its conversation kept
  prs: number; // PR drafts that wait for you or were approved: it can only be archived, not deleted
  artifacts_stamp: number; // goes up on every change to its artifacts (the Artifacts tab reads its folder again)
  repo: string | null; // a repository's agent (the Workspace tab's Live): the repo it belongs to
  live: LiveSetUp | null; // and how far its set-up is
  project: string | null; // a project's worker or reviewer: the project's repo
  role: "worker" | "reviewer" | null;
  workflow: string | null; // one of the Workflow tab's agents: its repository
  workflow_role: "chat" | "worker" | "reviewer" | null;
};

// How far a repository's agent's set-up is (github_searcher/agents.py, prepare_live): its VM coming up and the code
// going in, then ready (it has its set_up_repo job), or failed with why (Try again).
export type LiveSetUp = { state: "preparing" | "ready" | "failed"; error: string | null };

// An issue a repository's agent drafted for you (github_searcher/issue_drafts.py), a card in its chat.
export type IssueDraft = {
  id: string;
  agent: string;
  repo: string;
  title: string;
  body: string; // markdown
  labels: string[];
  status: "pending" | "created" | "discarded";
  url: string | null; // the issue on GitHub, once created
  number: number | null;
  created_at: string;
  decided_at: string | null;
};

export type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export type HistoryEntry =
  | { type: "user"; text: string; time: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; text: string; is_error: boolean; image: boolean }
  | { type: "system"; text: string; time: string }
  | { type: "turn_end"; stopped: boolean; cost_usd: number; time: string };

export type VMStatus = "creating" | "running" | "stopping" | "stopped" | "starting" | "failed" | "missing";

// The numbers are null until the first readings after the VM starts (CPU % needs two).
export type VMUsage = {
  on: boolean;
  responding: boolean; // false while it boots, or when it froze or crashed though Incus says Running
  cpu_percent: number | null;
  memory_used_gb: number | null;
  disk_used_gb: number | null;
  net_down_rate: number | null; // internet only (not the desktop or terminals), bytes a second
  net_up_rate: number | null;
};

// Internet use counted since the user last reset it, in bytes. The rest is the backend's bookkeeping.
export type VMTraffic = {
  down: number;
  up: number;
  since: string;
};

// A note on what is set up in a VM, for the next agent (and the user) to know.
export type VMNote = {
  id: string;
  text: string;
  by: string; // an agent id or "user"
  at: string;
  desktop?: number; // the desktop an agent wrote it on (its ~ is that desktop's home); the user's have none
};

// One desktop of a VM: who uses it, and who stepped aside from it. Each has its own screen, mouse, keyboard and home folder.
export type VMDesktop = {
  number: number; // fixed: removing a desktop never renumbers the others, and a new one takes the lowest number free
  holder: string | null; // null, "user" or an agent id
  priority: string[]; // agents that stepped aside while their run goes; they come before the queue, first = checked first
};

// A long command an agent left going in a VM (a test suite, a build): it goes on by itself until it ends.
export type VMRun = {
  id: string;
  agent: string; // the agent id
  desktop?: number; // the desktop it runs on (none: desktop 1)
  kind: "bash" | "tests";
  label: string; // the command, as you see it
  started_at: string;
  background: boolean; // false while the agent's tool call still waits for it
  stopped_by_user: boolean;
};

// Where an agent last clicked, dragged or scrolled on a desktop, in pixels of that desktop's screen (width x height).
export type VMPointer = { agent: string; x: number; y: number; width: number; height: number };

export type VMSummary = {
  name: string;
  incus_name: string;
  image: string; // the image's name when the VM was made ("" for older VMs); see image_fingerprint
  image_fingerprint: string; // the exact image it was made from: images can be renamed or rebuilt
  secrets_in_vm: string[]; // env variables whose values are written in the VM's files now
  forked_from: string; // the VM this one is a copy of, or ""
  cpus: number;
  memory_gb: number;
  disk_gb: number;
  internet: boolean;
  env_names: string[];
  autostart: boolean;
  status: VMStatus;
  created_at: string;
  desktops: VMDesktop[]; // lowest number first; agents on different desktops work at the same time
  queue: string[]; // agent ids waiting for a desktop, first = next
  wants: Record<string, number>; // the desktop some of them asked for (the others take the first that frees up)
  runs: VMRun[]; // long commands agents left going in the VM
  usage: VMUsage | null;
  samples: { cpu_percent: number | null; memory_used_gb: number | null; net_down_rate: number | null; net_up_rate: number | null }[];
  traffic: VMTraffic;
  notes: VMNote[]; // what agents and the user set up in it, oldest first
  locked_by: Record<string, "user" | "agent">; // per desktop number: who locked your mouse and keyboard out
  pointers: Record<string, VMPointer>; // per desktop number: where an agent last put the mouse (AgentCursor.tsx)
  error: string | null; // why the last create, start or stop failed
};

// What an image has, listed once in a throwaway VM (sandbox/image/inventory.py). The live feed carries this
// summary; the packages themselves come from GET /api/images/inventory/<fingerprint> (ImageInventory).
export type Probe = { name: string; version: string; raw: string };

export type InventoryHighlights = {
  image: { name: string; fingerprint: string; created_at: string };
  inspected_at: string;
  system: { os: string; kernel: string; arch: string; desktop: string; user: string; disk_used_gb: number };
  languages: Probe[];
  tools: Probe[];
  docker_images: string[];
  models: string[];
  caches: { name: string; path: string; size_gb: number }[];
  counts: Record<string, number>; // packages per kind: apt, pip, npm, cargo, snap, flatpak, vscode, docker, playwright
};

export type Package = { kind: string; name: string; version: string; manual?: boolean };

export type Inventory = Omit<InventoryHighlights, "docker_images" | "counts"> & { packages: Package[] };

export type Image = {
  name: string;
  aliases: string[];
  fingerprint: string;
  size_gb: number;
  created_at: string;
  default: boolean;
  used_by: string[]; // names of the VMs made from this exact image, stopped ones too
  inventory: InventoryHighlights | null; // null until it is inspected
  inspecting: boolean; // a build, save or inspect of it is running
  definition_changed: boolean; // its image.yaml changed since it was built: a Rebuild applies it
  definition_updated_at: number; // when its image.yaml last changed (seconds), so a view of it knows to fetch again
  description: string; // the description in its image.yaml ("" without one)
};

// An image's image.yaml, what defines it (GET /api/images/<name>/definition), and a diff from what it was built
// from ("" when the same, or never built).
export type ImageDefinition = { definition: string; diff: string };

// The mechanical check of an image.yaml or the defaults (POST /api/image-check): what is wrong, or nothing.
export type ImageCheck = { problems: string[] };

// The defaults every new image.yaml starts as (GET /api/image-defaults): the user's, "" before they wrote any.
export type ImageDefaults = { defaults: string };

// What New image offers (GET /api/images/new/options): system ids and labels, desktops (the first is the default,
// the last is "None (terminal only)"), and the system picked first.
export type NewImageOptions = {
  systems: { id: string; label: string }[];
  desktops: string[];
  system: string;
};

// The chat with an image's agent (sandbox/image_agent.py), from GET /api/images/<name>/agent.
export type ImageAgentEntry =
  | { type: "user"; text: string; time: string }
  | { type: "text"; text: string }
  | { type: "system"; text: string; time: string }
  | { type: "tool"; id: string; name: string; summary: string }
  | { type: "tool_result"; id: string; text: string; is_error: boolean }
  | { type: "turn_end"; stopped: boolean; cost_usd: number; time: string };

export type ImageAgentChat = { history: ImageAgentEntry[]; busy: boolean; cost_usd: number };

// A build (Build, Rebuild or the image agent), a VM being saved as an image, or an inspect.
// Tasks that worked disappear once their image is listed; failed ones stay until dismissed.
export type ImageTask = {
  id: string;
  kind: "build" | "save" | "inspect";
  name: string;
  vm: string | null; // the VM being saved
  status: "running" | "failed";
  error: string | null;
  started_at: string;
  log_tail: string[];
};

// An image with an image.yaml (saved by New image) that was never built: no Incus image yet.
export type UnbuiltImage = {
  name: string;
  system: string; // its system's label ("" while image.yaml isn't right)
  description: string; // the description in its image.yaml ("" without one)
  updated_at: number; // when its image.yaml last changed (seconds)
  building: boolean; // its first build is running
};

export type ImagesData = {
  images: Image[];
  unbuilt: UnbuiltImage[];
  default: string;
  tasks: ImageTask[];
};

// ---- One-off responses (fetched with api(), not live) ----

export type VMOptions = {
  cpus: number[];
  cpus_default: number;
  memory_gb: number[];
  memory_gb_default: number;
  disk_gb_min: number;
  disk_gb_max: number;
  disk_gb_default: number;
  desktops: number[]; // 1, 2, 3: how many desktops (agents at the same time) a VM can have
  next_name: string;
};

export type VMSettings = {
  cpus: number;
  memory_gb: number;
  disk_gb: number;
  internet: boolean;
  autostart: boolean;
  env: Record<string, string>;
};

export type TreeFile = {
  path: string;
  type: "blob" | "tree";
  size: number;
};

export type RepoTree = {
  ref: string;
  files: TreeFile[];
  truncated: boolean;
  readme: string | null;
};

export type RepoFile = {
  path: string;
  text: string | null;
  size: number;
  binary: boolean;
  too_big: boolean;
};

export type Readme = {
  markdown: string | null;
  ref?: string;
};

export type Thread = {
  title: string;
  state: string;
  author: string;
  body: string;
  labels: string[];
  assignees: string[];
  comments: { author: string; at: string; body: string }[];
  html_url: string;
};

// This computer's use (sandbox/resource_usage.py), a new reading about once a second. Rates are bytes a second.
// A number is null when this computer doesn't have it, or before the second reading.
export type GPUState = "on" | "asleep" | "not_watched" | "in_vm" | "no_driver" | "unknown" | "error";

export type GPUUsage = {
  address: string; // PCI address, "0000:01:00.0"
  vendor: "nvidia" | "amd" | "intel" | "other";
  name: string;
  state: GPUState; // only "on" has numbers
  percent: number | null;
  memory_used_gb: number | null;
  memory_total_gb: number | null;
  shared_used_gb: number | null; // system memory a built-in GPU borrows
  shared_total_gb: number | null;
  temp_c: number | null;
  power_w: number | null;
  mhz: number | null;
};

export type ResourceSample = {
  cpu_percent: number | null;
  memory_used_gb: number;
  gpu_percent: (number | null)[]; // one per GPU, in the order of gpus
  disk_read_rate: number | null;
  disk_write_rate: number | null;
  net_down_rate: number | null;
  net_up_rate: number | null;
};

export type ResourceUsage = {
  cpu: { name: string; threads: number; percent: number | null; per_thread: (number | null)[]; mhz: number | null; temp_c: number | null };
  memory: { total_gb: number; used_gb: number; swap_total_gb: number; swap_used_gb: number };
  gpus: GPUUsage[];
  disk: { total_gb: number; used_gb: number; read_rate: number | null; write_rate: number | null; temp_c: number | null };
  network: { interface: string | null; down_rate: number | null; up_rate: number | null };
  battery: { percent: number; status: string; power_w: number | null; plugged_in: boolean | null } | null;
  fans: number[]; // rpm
  samples: ResourceSample[]; // the last 60, one a second
};

// The live copy's updates (github_searcher/updates.py): the version that runs, and a newer release that is ready.
export type UpdatesData = {
  live: boolean; // false in the dev copy (./run.sh): no updates there
  running: string; // the release that runs, e.g. "v0.1.0", or "dev"
  latest: { tag: string; name: string; notes: string; published_at: string; url: string } | null; // on GitHub
  ready: string | null; // a newer release, downloaded and ready: Update in the header
  preparing: string | null; // the release being made ready now
  checking: boolean;
  checked_at: string | null;
  error: string;
  previous: string | null; // the release before this one (Previous version)
  switched_at: string | null; // when this one went live
  failed: string | null; // the release the last update went to, when it didn't start or was taken back
  failed_reason: string; // why ("" when not known)
  restarting: boolean;
};

// One of your repositories agents develop all the time (github_searcher/projects.py): Development and Releases.
export type ProjectIssue = {
  number: number;
  title: string;
  state: "working" | "denied" | "stopped" | "closed" | "done";
  job: string | null;
  agent: string | null;
  kind: string | null; // denied: not_valid, duplicate, conflicting, out_of_scope, cannot_reproduce
  why: string; // denied: the agent's reason
  at: string;
};

export type ProjectPR = {
  number: number;
  title: string;
  url: string;
  draft: string | null; // the Inbox draft Approve opened it from
  job: string | null;
  agent: string | null;
  issue: number | null;
  state: "open" | "merged" | "closed";
  checks: "passed" | "failed" | "running" | "none";
  mergeable: boolean | null; // false: conflicts with main
  redo: boolean; // its agent makes it again on the new main
  replaces: string | null;
  at: string;
};

export type Project = {
  repo: string;
  on: boolean;
  mode: "drafts" | "auto";
  agents: number; // workers
  goals: string;
  vm: string | null;
  chat: string | null; // the chat agent (the repository's agent)
  workers: string[];
  reviewer: string | null;
  issues: Record<string, ProjectIssue>;
  prs: Record<string, ProjectPR>;
  crashes_sent_at: string | null;
  error: string; // why the last round failed
  created_at: string;
  app: boolean; // the app's own repo: its errors become its issues
};

// One of the app's own errors (github_searcher/crashes.py), which the app's own project turns into issues.
export type Crash = {
  id: string;
  source: "backend" | "browser" | "agent" | "release";
  message: string;
  detail: string;
  count: number;
  first_at: string;
  last_at: string;
  version: string;
  state: "new" | "sent" | "filed" | "skipped";
  issue: number | null;
  note: string;
};

// The Workflow tab (github_searcher/workflow.py): your own repositories that agents develop one confined issue at a
// time, each as a pull request the review agent checks before it is merged or rejected.
export type WorkflowIssue = {
  number: number;
  title: string;
  goal: string; // one sentence
  requirements: string[]; // empty: not written down yet (its worker does that first)
  validation: string; // how to check it is done
  state: "open" | "closed";
  reason: "merged" | "duplicate" | "not_valid" | "cannot_reproduce" | "too_big" | "by_you" | "on_github" | null;
  why: string;
  by: string; // "you", "github" (opened there by hand) or the agent's id
  found_in: number | null; // the issue or pull request it was found while working on
  url: string | null; // on GitHub
  agent: string | null; // its worker
  job: string | null;
  pr: number | null; // its newest pull request
  stopped: boolean; // its job was cancelled: Try again gives it out again
  created_at: string;
  closed_at: string | null;
  at: string;
};

export type WorkflowReview = {
  agent: string;
  job: string | null;
  advice: "merge" | "dont_merge" | null; // null: still reviewing
  summary: string; // what changes, in a plain line
  important: string[];
  checked: string; // what it ran and saw
  evidence: EvidenceItem[];
  at: string;
};

export type WorkflowPR = {
  number: number;
  id: string;
  title: string;
  by: string; // the worker's id, or "you" (opened on GitHub by hand)
  author: string | null; // that one's GitHub login
  issue: number | null;
  job: string | null;
  agent: string | null;
  state: "review" | "waiting" | "merged" | "rejected" | "closed";
  url: string | null; // on GitHub
  github: number | null; // its number on GitHub
  head: string | null;
  area: string; // its title's scope
  files: { path: string; added: number; removed: number }[];
  added: number;
  removed: number;
  review: WorkflowReview | null;
  decision: { by: "you" | "agent"; action: "merge" | "reject"; reason: string; at: string } | null;
  checks: "passed" | "failed" | "running" | "none" | null;
  mergeable: boolean | null;
  error: string; // why the last merge failed
  created_at: string;
  at: string;
};

export type WorkflowRepo = {
  repo: string;
  on: boolean; // workers take new issues
  prs_on: "seraph" | "github";
  decides: "you" | "agent";
  agents: number; // workers
  vm: string | null;
  chat: string | null;
  workers: string[];
  reviewer: string | null;
  next_number: number;
  issues: Record<string, WorkflowIssue>;
  prs: Record<string, WorkflowPR>;
  error: string; // why the last round failed
  created_at: string;
};

// What a pull request is made of (GET /api/workflow/{repo}/pulls/{n}): a worker's has all of it, one opened on GitHub
// by hand only its body and diff.
export type WorkflowPRParts = {
  body: string;
  diff: string;
  overview?: DraftOverview;
  commits?: DraftCommit[];
  base?: string;
  base_sha?: string;
  branch?: string;
  evidence?: EvidenceItem[];
  tests?: { before: TestRun | null; after: TestRun | null };
};

// ---- The live store ----

export type Topics = {
  repos: ListData<ListedRepo>;
  issues: ListData<IssueItem>;
  tracked: ListData<TrackedRepo>;
  explore: ExploreData;
  github: GithubStatus | null;
  jobs: Job[];
  inbox: Draft[];
  issue_drafts: IssueDraft[];
  prs: PRsData;
  your_repos: YourReposData;
  notifications: NotificationsData;
  agents: AgentSummary[];
  vms: VMSummary[];
  images: ImagesData;
  resource: ResourceUsage | null; // null until the backend's first reading
  updates: UpdatesData;
  projects: Project[];
  crashes: Crash[]; // the newest first
  workflow: WorkflowRepo[];
};

// Empty until the first message, so components never deal with "not loaded yet".
// `loaded` says which topics have arrived, for the few places that must tell "empty" from "not yet".
const store = {
  topics: {
    repos: { items: [], can_undo: false, can_redo: false },
    issues: { items: [], can_undo: false, can_redo: false },
    tracked: { items: [], can_undo: false, can_redo: false },
    explore: { profile: { about: "", lanes: [] }, run: null, found: [] },
    github: null,
    jobs: [],
    inbox: [],
    issue_drafts: [],
    prs: { items: [], issues: [], checked_at: null, error: null, refreshing: false },
    your_repos: { repos: [], starred: [], parents: [], login: null, checked_at: null, error: null },
    notifications: { items: [], login: null, checked_at: null, error: null },
    agents: [],
    vms: [],
    images: { images: [], unbuilt: [], default: "", tasks: [] },
    resource: null,
    updates: {
      live: false,
      running: "dev",
      latest: null,
      ready: null,
      preparing: null,
      checking: false,
      checked_at: null,
      error: "",
      previous: null,
      switched_at: null,
      failed: null,
      failed_reason: "",
      restarting: false,
    },
    projects: [],
    crashes: [],
    workflow: [],
  } as Topics,
  loaded: {} as Partial<Record<keyof Topics, boolean>>,
  connected: false,
};

const listeners = new Set<() => void>();

// The open socket, and how many Resource pages this tab shows (useWatchResource).
let liveSocket: WebSocket | null = null;
let resourceWatchers = 0;
// The version of the app this page came from: the first one the backend says it runs.
let pageVersion: string | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/live`);

  socket.onopen = () => {
    liveSocket = socket;
    // A new connection starts not watching: say so again when a Resource page is open.
    if (resourceWatchers > 0) {
      socket.send(JSON.stringify({ watch_resource: true }));
    }
    store.connected = true;
    listeners.forEach((listener) => listener());
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data) as { topic: keyof Topics; data: never };
    // A new topics object (not a mutation), so useSyncExternalStore sees the change.
    store.topics = { ...store.topics, [message.topic]: message.data };
    store.loaded = { ...store.loaded, [message.topic]: true };
    listeners.forEach((listener) => listener());
    // Another version answers now (an update or Previous version restarted the app): load its page.
    if (message.topic === "updates") {
      const running = (message.data as UpdatesData).running;
      if (pageVersion === null) {
        pageVersion = running;
      } else if (running !== pageVersion) {
        window.location.reload();
      }
    }
  };

  // onclose also follows onerror, so this is the one place that reconnects.
  socket.onclose = (event) => {
    // Through the remote access address without a sign in (or this device was removed): the Sign in page instead.
    if (event.code === 4401) {
      window.location.href = "/api/remote_access/sign_in";
      return;
    }
    liveSocket = null;
    if (store.connected) {
      store.connected = false;
      listeners.forEach((listener) => listener());
    }
    setTimeout(connect, 1000);
  };
}

connect();

// The latest data of one topic. Re-renders only when that topic changes.
export function useLive<K extends keyof Topics>(topic: K): Topics[K] {
  return useSyncExternalStore(subscribe, () => store.topics[topic]);
}

// One value worked out from the topics, for a component that needs only a little of a busy topic: the VM list
// changes every second while a VM runs (its usage samples). select must return a string, number or boolean, so
// the component re-renders only when that value changes, e.g. useLiveValue((topics) => topics.vms.length).
export function useLiveValue<T extends string | number | boolean>(select: (topics: Topics) => T): T {
  return useSyncExternalStore(subscribe, () => select(store.topics));
}

// Whether a topic has arrived at least once since the page loaded.
export function useLoaded(topic: keyof Topics): boolean {
  return useSyncExternalStore(subscribe, () => store.loaded[topic] === true);
}

// For a Resource page: tells the backend one is open while it is mounted, so the NVIDIA GPU's numbers are read.
export function useWatchResource() {
  useEffect(() => {
    resourceWatchers += 1;
    if (resourceWatchers === 1 && liveSocket !== null) {
      liveSocket.send(JSON.stringify({ watch_resource: true }));
    }
    return () => {
      resourceWatchers -= 1;
      if (resourceWatchers === 0 && liveSocket !== null) {
        liveSocket.send(JSON.stringify({ watch_resource: false }));
      }
    };
  }, []);
}

// Whether the websocket is open right now (the header shows "Offline" when it is not).
export function useConnected(): boolean {
  return useSyncExternalStore(subscribe, () => store.connected);
}

// ---- The fetch helper ----

// api("/api/repos/undo", { method: "POST" }), api<RepoTree>(`/api/repos/tree?name=${...}`).
// Sends body as JSON. Returns the parsed JSON (or the text for non-JSON answers).
// Throws Error(detail) on a non-2xx answer, with the backend's HTTPException detail as the message.
// A 401 with sign_in: true (through the remote access address, signed out) opens the Sign in page.
export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? "GET" };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    if (isJson) {
      const body = await response.json().catch(() => null);
      if (response.status === 401 && body && body.sign_in === true) {
        window.location.href = "/api/remote_access/sign_in";
      }
      if (body && typeof body.detail === "string") {
        detail = body.detail;
      } else if (body && body.detail !== undefined) {
        detail = JSON.stringify(body.detail);
      }
    }
    throw new Error(detail);
  }
  if (isJson) {
    return (await response.json()) as T;
  }
  return (await response.text()) as T;
}
