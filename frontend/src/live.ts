/*
Live data from the backend, and the one fetch helper.

One websocket to /api/live. On connect the server sends every topic, then only the topics that changed:
{"topic": "repos" | "issues" | "tracked" | "explore" | "github" | "jobs" | "inbox" | "agents" | "vms" | "images", "data": ...}.
Each message replaces that topic in the store, and components read it with useLive(topic), so the page never
polls and never re-fetches lists. When the socket drops it reconnects after a second, and the server sends
everything again.

The types below mirror the records in the spec (data/*.json and the live summaries).
*/

import { useSyncExternalStore } from "react";

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
  activity?: RepoActivity;
  community?: Community;
  atmosphere?: Atmosphere | null; // null until Claude first read the reviews
  ai_policy: AIPolicy;
};

export type NewcomerTag = "welcomes" | "ok" | "wait" | "few";

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
  score: number | null; // 0..100
  rejected_before: number; // how many times the user rejected it before
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
// is, but it isn't ready). level is like LeetCode's. level and kind are null when it is assigned on GitHub (not asked).
export type IssueTags = {
  status: "free" | "assigned" | "waiting";
  level: "easy" | "medium" | "hard" | null;
  kind: "bug" | "feature" | "docs" | "question" | null;
  reason: string;
  updated_at: string;
  judged_at: string;
};

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

// A tracked repo's latest check. An issue is new for three days after it was opened.
export type TrackedCheck = {
  checked_at: string;
  error: string | null; // why the last check failed (the issues are from the check before)
  stars: number | null;
  description: string;
  issues: TrackedIssue[]; // newest first
};

// A repo in the Tracked list, with its latest check merged in by the live feed (null until the first one).
// signals: the same as a Repos row's, null until fetched (within seconds of being tracked).
export type TrackedRepo = RepoItem & { check: TrackedCheck | null; signals: RepoSignals | null };

// Explore (github_searcher/explore.py): the profile it searches with, the current or last run, and rejected repos.
export type ExploreLane = {
  id: string;
  label: string;
  about: string; // what the lane is for, given to Claude when it judges fit
  share: number; // 0..100: the part of the finds that should come from this lane
  seeds: string[]; // owner/name, looked at first
  queries: string[]; // GitHub repo searches
};

// The user writes about, and each type of repo (a lane's label and about); Claude plans each one's seeds and
// searches when the profile is saved. The types are the tags that classify repos (a repo's "lane").
export type ExploreProfile = {
  about: string;
  lanes: ExploreLane[];
};

// A repo Explore found, waiting for the user to approve it into Repos or reject it. Kept across runs.
export type ExploreFound = {
  name: string;
  lane: string;
  description: string;
  stars: number;
  default_branch: string;
  html_url: string;
  fit: number;
  score: number | null;
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
  // From its signals: who opened PRs lately, who merged PRs in 30 days, outside PRs over 30 days nobody answered.
  // Null when not counted (found before these were).
  contributors: number | null;
  maintainers: number | null;
  unanswered: number | null;
};

export type ExploreRun = {
  status: "running" | "done" | "stopped" | "failed";
  started_at: string;
  ended_at: string | null;
  end_reason: string;
  count: number | null;
  minutes: number | null;
  workers: number;
  filters: string[]; // the tags it keeps to or keeps out (explore.py FILTERS)
  found: number;
  looked_at: number;
  lanes: Record<string, { label: string; share: number; found: number; in_flight: number; exhausted: boolean }>;
  checking: { name: string; lane: string; since: string }[];
  skipped: Record<string, number>; // why → how many
  errors: { name: string; error: string; at: string }[];
};

export type Rejection = {
  name: string;
  until: string; // blocked until then
  history: { at: string }[];
};

export type ExploreData = {
  profile: ExploreProfile;
  run: ExploreRun | null;
  found: ExploreFound[]; // waiting for a decision, oldest first
  rejections: Rejection[];
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
  kind: string; // "fix_issue" | "task" | future kinds
  title: string;
  agent: string;
  issue: string | null;
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
  // The project's full test suite: on the unchanged code (must pass before any change) and on the finished change.
  tests: { before: TestRun | null; after: TestRun | null };
};

export type TestRun = {
  command: string;
  base: string;
  exit_code: number | null; // null: stopped at the time limit
  passed: boolean;
  diff_hash: string; // the code it ran on ("" for before)
  evidence: string; // the evidence item with its output
  seconds: number;
  at: string;
};

// What a draft is about, in plain words for the user (github_searcher/inbox.py). PRs have problem, cause, fix and
// risks; comments have problem and why.
export type DraftOverview = {
  project?: string;
  problem?: string;
  cause?: string;
  fix?: string;
  risks?: string[];
  why?: string;
};

export type DraftStatus = "pending" | "approved" | "rejected" | "replied";

export type Draft = {
  id: string;
  kind: "pr" | "comment" | "question";
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
};

export type AgentStatus = "idle" | "working" | "in_queue" | "using_vm";

export type AgentSummary = {
  id: string;
  name: string;
  target_vm: string | null;
  status: AgentStatus;
  busy: boolean;
  vm: string | null; // the VM it is queued for or holds
  place: number | null; // 0 = holder, n = place in the queue
  context_used: number;
  context_max: number;
  cost_usd: number;
  history_length: number;
  pending: number; // user messages waiting for the current turn to end
  activity: string; // the last tool summary or system line
  last_event_at: string | null; // when something last happened in its turn (to tell a slow command from a stuck agent)
  in_tool: boolean; // a tool call is running (a command, the test suite): quiet then is not stuck
  todo_done: number; // from its latest todo list
  todo_total: number;
  created_at: string;
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
  holder: string | null; // null, "user" or an agent id
  queue: string[]; // agent ids, first = next
  usage: VMUsage | null;
  samples: { cpu_percent: number | null; memory_used_gb: number | null; net_down_rate: number | null; net_up_rate: number | null }[];
  traffic: VMTraffic;
  locked_by: "user" | "agent" | null;
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

// Sherpa (github_searcher/sherpa.py), from GET /api/sherpa: its chat (entries like the image agent's), and the page
// action it waits for, done by the browser tab its message came from.
export type SherpaAction =
  | { kind: "look" }
  | { kind: "screenshot"; numbers: boolean }
  | { kind: "go_to"; address: string }
  | { kind: "click"; element: number }
  | { kind: "fill"; element: number; text: string }
  | { kind: "point"; element: number };

export type SherpaChat = {
  id: string | null; // null: a new chat, kept once its first message is sent
  history: ImageAgentEntry[];
  busy: boolean;
  cost_usd: number;
  context_used: number; // tokens the chat fills of the context window
  context_cap: number; // where it is compacted (the agents' cap, 500k)
  queued: string[]; // messages waiting for the turn to end, oldest first
  pending: { id: number; tab: string; action: SherpaAction } | null;
};

// A chat in Sherpa's history (GET /api/sherpa/chats), the newest first. Its title is its first message.
export type SherpaChatSummary = { id: string; title: string; updated_at: string };

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

// ---- The live store ----

export type Topics = {
  repos: ListData<ListedRepo>;
  issues: ListData<IssueItem>;
  tracked: ListData<TrackedRepo>;
  explore: ExploreData;
  github: GithubStatus | null;
  jobs: Job[];
  inbox: Draft[];
  agents: AgentSummary[];
  vms: VMSummary[];
  images: ImagesData;
};

// Empty until the first message, so components never deal with "not loaded yet".
// `loaded` says which topics have arrived, for the few places that must tell "empty" from "not yet".
const store = {
  topics: {
    repos: { items: [], can_undo: false, can_redo: false },
    issues: { items: [], can_undo: false, can_redo: false },
    tracked: { items: [], can_undo: false, can_redo: false },
    explore: { profile: { about: "", lanes: [] }, run: null, found: [], rejections: [] },
    github: null,
    jobs: [],
    inbox: [],
    agents: [],
    vms: [],
    images: { images: [], unbuilt: [], default: "", tasks: [] },
  } as Topics,
  loaded: {} as Partial<Record<keyof Topics, boolean>>,
  connected: false,
};

const listeners = new Set<() => void>();

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
    store.connected = true;
    listeners.forEach((listener) => listener());
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data) as { topic: keyof Topics; data: never };
    // A new topics object (not a mutation), so useSyncExternalStore sees the change.
    store.topics = { ...store.topics, [message.topic]: message.data };
    store.loaded = { ...store.loaded, [message.topic]: true };
    listeners.forEach((listener) => listener());
  };

  // onclose also follows onerror, so this is the one place that reconnects.
  socket.onclose = () => {
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

// Whether the websocket is open right now (the header shows "Offline" when it is not).
export function useConnected(): boolean {
  return useSyncExternalStore(subscribe, () => store.connected);
}

// ---- The fetch helper ----

// api("/api/repos/undo", { method: "POST" }), api<RepoTree>(`/api/repos/tree?name=${...}`).
// Sends body as JSON. Returns the parsed JSON (or the text for non-JSON answers).
// Throws Error(detail) on a non-2xx answer, with the backend's HTTPException detail as the message.
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
