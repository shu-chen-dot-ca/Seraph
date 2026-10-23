/*
Live data from the backend, and the one fetch helper.

One websocket to /api/live. On connect the server sends every topic, then only the topics that changed:
{"topic": "repos" | "issues" | "tracked" | "jobs" | "inbox" | "agents" | "vms" | "images", "data": ...}.
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
  added_by: string; // "user" or an agent id
  added_at: string;
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
  author: string;
  labels: string[];
  comments: number;
  assignees: number;
  good_first: boolean; // has a good-first-issue kind of label
};

// A tracked repo's latest check. An issue is new when it was opened after seen_at.
export type TrackedCheck = {
  checked_at: string;
  error: string | null; // why the last check failed (the issues are from the check before)
  seen_at: string;
  stars: number | null;
  description: string;
  issues: TrackedIssue[]; // newest first
};

// A repo in the Tracked list, with its latest check merged in by the live feed (null until the first one).
export type TrackedRepo = RepoItem & { check: TrackedCheck | null };

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

export type Image = {
  name: string;
  aliases: string[];
  fingerprint: string;
  description: string;
  size_gb: number;
  created_at: string;
  default: boolean;
  used_by: string[]; // names of the VMs made from this exact image
};

// A build (sandbox/image/build.sh, about an hour) or a VM being saved as an image (minutes).
// Tasks that worked disappear once their image is listed; failed ones stay until dismissed.
export type ImageTask = {
  id: string;
  kind: "build" | "save";
  name: string;
  vm: string | null;
  description: string;
  status: "running" | "failed";
  error: string | null;
  started_at: string;
  log_tail: string[];
};

export type ImagesData = {
  images: Image[];
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
  repos: ListData<RepoItem>;
  issues: ListData<IssueItem>;
  tracked: ListData<TrackedRepo>;
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
    jobs: [],
    inbox: [],
    agents: [],
    vms: [],
    images: { images: [], default: "", tasks: [] },
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
