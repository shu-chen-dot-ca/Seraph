/*
Made-up sample data for the mockups, shaped like Seraph's real records.

A work item is one piece of work from start to end: the issue, the job an agent does on it, what it asks you and
its pull request, shown as one page under its project. An open issue is one nobody works on yet: it waits in its
project's Open column to be assigned.

What an agent needs from you is a question (it is stopped until you answer) or an approval (something to send or
merge). Each starts with `ask`: what the agent needs, in plain words. A question either has a timer (after it, the
agent goes ahead with the choice it recommends: long runs, a busy machine) or waits for you however long it takes
(`why`: money, anything sensitive, what gets sent to GitHub). Small choices are never asked: the agent decides and
writes why on the timeline. When someone else takes an issue, the agent checks who it is and decides itself.
*/

export type Stage = "working" | "review" | "approval" | "sent" | "merged" | "cancelled";
export type WorkType = "Open source" | "My project";
// One piece of proof on a timeline: a screenshot (its caption), a command's output, or a list of things checked.
export type Proof = { shot?: string; run?: string[]; check?: string[] };
export type Event = {
  time: string;
  who: string;
  text: string;
  proof?: Proof[];
  link?: { kind: string; id: string; text: string };
  live?: boolean;
};
export type Work = {
  id: string;
  title: string;
  repo: string;
  short: string;
  ref: string;
  type: WorkType;
  stage: Stage;
  agent: string;
  reviewer: string | null;
  vm: string;
  desk: number;
  draft: string | null;
  pr: number | null;
  updated: string;
  minutes: number;
  step: string;
  sent: string | null;
  timeline: Event[];
};
export type Draft = {
  id: string;
  group: "question" | "approval";
  kind: string;
  work: string;
  ask: string;
  age: string;
  minutes: number;
  // A question with a timer: how long until the agent goes ahead with its recommended choice.
  timer: string | null;
  // A question that waits for you: why it can't go ahead without you.
  why: string | null;
};
export type OpenIssue = { id: string; short: string; ref: string; title: string; plain: string; level: string; opened: string; minutes: number };
export type Notification = { id: string; reason: string; text: string; work: string; age: string; minutes: number };
export type Agent = {
  status: "Working" | "Idle" | "In queue" | "Paused";
  note: string;
  work: string;
  vm: string | null;
  desk: number | null;
  recent: string[];
};
export type VM = {
  status: "Running" | "Stopped";
  image: string;
  desktops: { n: number; holder: string | null }[];
  waiting: string[];
  cpu: number;
  mem: number;
};
export type Project = { id: string; full: string; group: "Private" | "Open source" };

export const STAGE_LABEL: Record<Stage, string> = {
  working: "In progress",
  review: "In review",
  approval: "Approval",
  sent: "Sent",
  merged: "Merged",
  cancelled: "Stopped",
};
export const STEPS: Record<WorkType, string[]> = {
  "Open source": ["Issue", "In progress", "In review", "Approval", "Sent", "Merged"],
  "My project": ["Issue", "In progress", "In review", "Approval", "Merged", "Released"],
};

export const WORK: Work[] = [
  {
    id: "w1",
    title: "Exported CSV drops the last row",
    repo: "TabularisDB/tabularis",
    short: "tabularis",
    ref: "tabularis #1388",
    type: "Open source",
    stage: "approval",
    agent: "tabularis-1",
    reviewer: "tabularis-review",
    vm: "vm1",
    desk: 2,
    draft: "d1",
    pr: null,
    updated: "12 min",
    minutes: 12,
    step: "Fixed and reviewed",
    sent: null,
    timeline: [
      { time: "Mon 09:40", who: "you", text: "Assigned to tabularis-1, on vm1." },
      { time: "09:52", who: "tabularis-1", text: "Saw it happen: a 3-row table exports as a file with 2 rows.", proof: [{ shot: "Before: the last row is missing" }] },
      { time: "10:05", who: "tabularis-1", text: "Ran the project's own tests on the unchanged code: all pass." },
      { time: "10:41", who: "tabularis-1", text: "Fixed: the last row was skipped when the file didn't end with a line break." },
      { time: "10:58", who: "tabularis-1", text: "Ran the same tests on the fix: all pass, plus one new test.", proof: [{ shot: "After: every row is there" }] },
      { time: "11:20", who: "tabularis-review", text: "Tried to break it. Advice: send.", proof: [{ check: ["Empty table", "One row", "Commas inside values", "10,000 rows"] }] },
      { time: "11:21", who: "app", text: "It's ready for your approval. Nothing has been sent.", link: { kind: "draft", id: "d1", text: "Open the approval" } },
    ],
  },
  {
    id: "w2",
    title: "Legend overlaps the title with constrained layout",
    repo: "matplotlib/matplotlib",
    short: "matplotlib",
    ref: "matplotlib #29411",
    type: "Open source",
    stage: "working",
    agent: "mpl-2",
    reviewer: null,
    vm: "vm2",
    desk: 1,
    draft: "d3",
    pr: null,
    updated: "2 min",
    minutes: 2,
    step: "Asked you; goes ahead in 9 min",
    sent: null,
    timeline: [
      { time: "08:15", who: "you", text: "Assigned to mpl-2, on vm2." },
      { time: "08:40", who: "mpl-2", text: "Saw it happen: with a long legend, the legend covers the chart's title.", proof: [{ shot: "Before: legend over the title" }] },
      { time: "09:30", who: "mpl-2", text: "Picked the project's usual way to test charts. A small choice, so it didn't ask." },
      { time: "09:50", who: "mpl-2", text: "A new account with no history (@fixbot-9281) said it would fix this too. It looks like a bot, so mpl-2 kept going." },
      { time: "10:02", who: "mpl-2", text: "Has a fix. Asked you before a 40-minute test run; goes ahead in 9 min if you don't answer.", link: { kind: "draft", id: "d3", text: "Answer" } },
    ],
  },
  {
    id: "w3",
    title: "Theme choice is forgotten after reload",
    repo: "openclaw/openclaw",
    short: "openclaw",
    ref: "openclaw #812",
    type: "Open source",
    stage: "sent",
    agent: "openclaw-1",
    reviewer: null,
    vm: "vm1",
    desk: 1,
    draft: "d2",
    pr: 815,
    updated: "25 min",
    minutes: 25,
    step: "Changes asked; reply ready",
    sent: "Sent by you on Oct 30 as pull request #815. A maintainer asked for changes on Nov 2.",
    timeline: [
      { time: "Oct 29", who: "you", text: "Assigned to openclaw-1." },
      { time: "Oct 30 10:12", who: "you", text: "Approved. Sent as pull request #815." },
      { time: "Nov 2 18:03", who: "gh:@kuro", text: "“Can you also cover the system theme? It still resets.”" },
      { time: "Nov 2 18:05", who: "app", text: "Told openclaw-1, which looks after this pull request." },
      { time: "09:10", who: "openclaw-1", text: "Saw the system-theme case happen first.", proof: [{ shot: "System theme resets on reload" }] },
      { time: "09:48", who: "openclaw-1", text: "Fixed it too and wrote a reply. The project's own tests pass, before and after.", link: { kind: "draft", id: "d2", text: "Open the approval" } },
    ],
  },
  {
    id: "w4",
    title: "Sort Jobs by any column",
    repo: "shu-chen-dot-ca/Seraph",
    short: "Seraph",
    ref: "Seraph #58",
    type: "My project",
    stage: "approval",
    agent: "seraph-worker-2",
    reviewer: "seraph-reviewer",
    vm: "seraph-workflow",
    desk: 1,
    draft: "d4",
    pr: 64,
    updated: "1 h",
    minutes: 60,
    step: "Reviewed: merge",
    sent: null,
    timeline: [
      { time: "Nov 2", who: "seraph-chat", text: "Made issue #58 from your message “jobs should sort like repos”." },
      { time: "07:30", who: "seraph-worker-2", text: "Made pull request #64. Seraph's own tests pass." },
      {
        time: "08:55",
        who: "seraph-reviewer",
        text: "Tried it: sorted Jobs by agent, then by time, and reloaded. Advice: merge.",
        proof: [{ shot: "Jobs sorted by agent" }, { check: ["Every column sorts", "Sort kept after reload"] }],
      },
      { time: "08:56", who: "app", text: "It's ready for your approval.", link: { kind: "draft", id: "d4", text: "Open the approval" } },
    ],
  },
  {
    id: "w5",
    title: "Bulk approve in the Inbox",
    repo: "shu-chen-dot-ca/Seraph",
    short: "Seraph",
    ref: "Seraph #61",
    type: "My project",
    stage: "working",
    agent: "seraph-worker-1",
    reviewer: null,
    vm: "seraph-workflow",
    desk: 1,
    draft: "d8",
    pr: null,
    updated: "15 min",
    minutes: 15,
    step: "Stopped until you answer",
    sent: null,
    timeline: [
      { time: "08:10", who: "seraph-chat", text: "Made issue #61 from your message “let me approve many at once”." },
      { time: "08:20", who: "seraph-worker-1", text: "Took it, checked it isn't a duplicate, and saw that the button is missing." },
      { time: "09:40", who: "seraph-worker-1", text: "Asked you how careful approving many at once should be. It waits for you.", link: { kind: "draft", id: "d8", text: "Answer" } },
    ],
  },
  {
    id: "w14",
    title: "Export to a hosted database times out",
    repo: "TabularisDB/tabularis",
    short: "tabularis",
    ref: "tabularis #1405",
    type: "Open source",
    stage: "working",
    agent: "tabularis-2",
    reviewer: null,
    vm: "vm1",
    desk: 2,
    draft: "d9",
    pr: null,
    updated: "30 min",
    minutes: 30,
    step: "Stopped until you answer",
    sent: null,
    timeline: [
      { time: "08:30", who: "you", text: "Assigned to tabularis-2, on vm1." },
      { time: "09:15", who: "tabularis-2", text: "Saw it happen with a local copy of the database." },
      { time: "09:40", who: "tabularis-2", text: "Checking it against a hosted database costs money, so it asked you. It waits for you.", link: { kind: "draft", id: "d9", text: "Answer" } },
    ],
  },
  {
    id: "w8",
    title: "--offline still reads proxy settings",
    repo: "httpie/cli",
    short: "httpie",
    ref: "httpie #1602",
    type: "Open source",
    stage: "merged",
    agent: "httpie-1",
    reviewer: null,
    vm: "vm1",
    desk: 1,
    draft: null,
    pr: 1610,
    updated: "2 d",
    minutes: 2880,
    step: "Merged by a maintainer",
    sent: "Sent by you on Oct 31 as pull request #1610. Merged Nov 1.",
    timeline: [
      { time: "Oct 31 09:02", who: "you", text: "Approved. Sent as pull request #1610." },
      { time: "Nov 1 16:40", who: "gh:@jkbr", text: "Merged it." },
    ],
  },
  {
    id: "w9",
    title: "Show the machine on each approval",
    repo: "shu-chen-dot-ca/Seraph",
    short: "Seraph",
    ref: "Seraph #63",
    type: "My project",
    stage: "review",
    agent: "seraph-worker-1",
    reviewer: "seraph-reviewer",
    vm: "seraph-workflow",
    desk: 2,
    draft: null,
    pr: 66,
    updated: "20 min",
    minutes: 20,
    step: "The reviewer is trying it",
    sent: null,
    timeline: [
      { time: "07:55", who: "seraph-worker-1", text: "Made pull request #66. Seraph's own tests pass." },
      { time: "now", who: "seraph-reviewer", text: "Trying it on seraph-workflow · desktop 2.", live: true },
    ],
  },
  {
    id: "w10",
    title: "Colorbar ticks wrong on a log scale",
    repo: "matplotlib/matplotlib",
    short: "matplotlib",
    ref: "matplotlib #29399",
    type: "Open source",
    stage: "cancelled",
    agent: "mpl-1",
    reviewer: null,
    vm: "vm2",
    desk: 1,
    draft: null,
    pr: null,
    updated: "1 h",
    minutes: 61,
    step: "Stopped: a maintainer took it",
    sent: null,
    timeline: [
      { time: "07:50", who: "you", text: "Assigned to mpl-1." },
      { time: "08:30", who: "mpl-1", text: "Saw it happen on a log-scale colorbar.", proof: [{ shot: "Ticks at the wrong places" }] },
      {
        time: "09:05",
        who: "mpl-1",
        text: "@phobson was assigned on GitHub. They're a matplotlib maintainer who merged 40 changes this year, so mpl-1 stopped on its own. What it found is kept here.",
      },
    ],
  },
  {
    id: "w11",
    title: "Typo on the onboarding screen",
    repo: "openclaw/openclaw",
    short: "openclaw",
    ref: "openclaw #790",
    type: "Open source",
    stage: "sent",
    agent: "openclaw-1",
    reviewer: null,
    vm: "vm1",
    desk: 1,
    draft: null,
    pr: 793,
    updated: "4 d",
    minutes: 5760,
    step: "Waiting for a maintainer",
    sent: "Sent by you on Oct 30 as pull request #793. No reply yet.",
    timeline: [{ time: "Oct 30 11:30", who: "you", text: "Approved. Sent as pull request #793." }],
  },
  {
    id: "w12",
    title: "Editing a cell silently changes another column",
    repo: "TabularisDB/tabularis",
    short: "tabularis",
    ref: "tabularis #1340",
    type: "Open source",
    stage: "merged",
    agent: "tabularis-1",
    reviewer: "tabularis-review",
    vm: "vm1",
    desk: 2,
    draft: null,
    pr: 1361,
    updated: "5 d",
    minutes: 7200,
    step: "Merged after 4 review rounds",
    sent: "Sent by you on Oct 28 as pull request #1361. Merged Nov 2.",
    timeline: [
      { time: "Oct 28", who: "you", text: "Approved. Sent as pull request #1361." },
      { time: "Oct 29 – Nov 1", who: "gh:@debba", text: "Asked for changes 3 times. Each time tabularis-1 saw the problem first and sent a new version you approved." },
      { time: "Nov 2", who: "gh:@debba", text: "Merged it." },
    ],
  },
  {
    id: "w13",
    title: "Download progress bar flickers in narrow terminals",
    repo: "httpie/cli",
    short: "httpie",
    ref: "httpie #1625",
    type: "Open source",
    stage: "approval",
    agent: "httpie-1",
    reviewer: "httpie-review",
    vm: "vm1",
    desk: 2,
    draft: "d7",
    pr: null,
    updated: "2 h",
    minutes: 120,
    step: "Fixed and reviewed",
    sent: null,
    timeline: [
      { time: "07:10", who: "you", text: "Assigned to httpie-1, on vm1." },
      { time: "07:30", who: "httpie-1", text: "Saw it happen: in a narrow window the progress bar jumps between two lines.", proof: [{ shot: "Before: the bar flickers" }] },
      { time: "08:40", who: "httpie-1", text: "Fixed it. The project's own tests pass, before and after.", proof: [{ shot: "After: the bar stays still" }] },
      { time: "09:05", who: "httpie-review", text: "Tried very narrow and very wide windows. Advice: send." },
      { time: "09:06", who: "app", text: "It's ready for your approval. Nothing has been sent.", link: { kind: "draft", id: "d7", text: "Open the approval" } },
    ],
  },
];

export const WORK_BY_ID: Record<string, Work> = Object.fromEntries(WORK.map((work) => [work.id, work]));

export const DRAFTS: Draft[] = [
  { id: "d1", group: "approval", kind: "Fix", work: "w1", ask: "Send this fix to tabularis?", age: "12 min", minutes: 12, timer: null, why: null },
  { id: "d2", group: "approval", kind: "Reply", work: "w3", ask: "Send this reply and the updated fix to openclaw?", age: "25 min", minutes: 25, timer: null, why: null },
  { id: "d4", group: "approval", kind: "Merge", work: "w4", ask: "Merge this change into Seraph?", age: "1 h", minutes: 60, timer: null, why: null },
  { id: "d7", group: "approval", kind: "Fix", work: "w13", ask: "Send this fix to httpie?", age: "2 h", minutes: 120, timer: null, why: null },
  { id: "d3", group: "question", kind: "Question", work: "w2", ask: "Run all of matplotlib's tests now? It takes about 40 minutes.", age: "3 min", minutes: 3, timer: "9 min", why: null },
  { id: "d8", group: "question", kind: "Question", work: "w5", ask: "Ask once, or for each item, when approving many?", age: "15 min", minutes: 15, timer: null, why: "It decides how carefully things are sent to GitHub." },
  { id: "d9", group: "question", kind: "Question", work: "w14", ask: "Pay $5 for a month of a test database?", age: "30 min", minutes: 30, timer: null, why: "It costs money." },
];

export const DRAFT_BY_ID: Record<string, Draft> = Object.fromEntries(DRAFTS.map((draft) => [draft.id, draft]));

export const AGENTS: Record<string, Agent> = {
  "tabularis-1": { status: "Idle", note: "Its fix for #1388 waits for your approval", work: "w1", vm: "vm1", desk: null, recent: ["w1", "w12"] },
  "tabularis-2": { status: "Paused", note: "Waits for your answer on #1405", work: "w14", vm: "vm1", desk: null, recent: ["w14"] },
  "tabularis-review": { status: "Idle", note: "Reviewed #1388: send", work: "w1", vm: "vm1", desk: null, recent: ["w1", "w12"] },
  "mpl-2": { status: "Working", note: "Asked you; goes ahead in 9 min", work: "w2", vm: "vm2", desk: 1, recent: ["w2"] },
  "mpl-1": { status: "Idle", note: "Stopped #29399: a maintainer took it", work: "w10", vm: "vm2", desk: null, recent: ["w10"] },
  "openclaw-1": { status: "Working", note: "Reply to @kuro ready", work: "w3", vm: "vm1", desk: 1, recent: ["w3", "w11"] },
  "seraph-worker-1": { status: "Paused", note: "Waits for your answer on #61", work: "w5", vm: "seraph-workflow", desk: 1, recent: ["w5", "w9"] },
  "seraph-worker-2": { status: "In queue", note: "Waiting for seraph-workflow", work: "w4", vm: "seraph-workflow", desk: null, recent: ["w4"] },
  "seraph-reviewer": { status: "Working", note: "Trying #66", work: "w9", vm: "seraph-workflow", desk: 2, recent: ["w9", "w4"] },
  "seraph-chat": { status: "Idle", note: "Last: made issue #61", work: "w5", vm: null, desk: null, recent: ["w5", "w4"] },
  "httpie-1": { status: "Idle", note: "Its fix for #1625 waits for your approval", work: "w13", vm: "vm1", desk: null, recent: ["w13", "w8"] },
  "httpie-review": { status: "Idle", note: "Reviewed #1625: send", work: "w13", vm: "vm1", desk: null, recent: ["w13"] },
};

export const VMS: Record<string, VM> = {
  vm1: { status: "Running", image: "ubuntu-dev · Oct 30", desktops: [{ n: 1, holder: "openclaw-1" }, { n: 2, holder: null }], waiting: [], cpu: 38, mem: 61 },
  vm2: { status: "Running", image: "python-sci · Oct 28", desktops: [{ n: 1, holder: "mpl-2" }], waiting: [], cpu: 86, mem: 74 },
  "seraph-workflow": {
    status: "Running",
    image: "seraph · Nov 2",
    desktops: [{ n: 1, holder: "seraph-worker-1" }, { n: 2, holder: "seraph-reviewer" }],
    waiting: ["seraph-worker-2"],
    cpu: 55,
    mem: 48,
  },
  "gpu-vm": { status: "Stopped", image: "cuda · Oct 26", desktops: [{ n: 1, holder: null }], waiting: [], cpu: 0, mem: 0 },
};

export const PROJECTS: Project[] = [
  { id: "Seraph", full: "shu-chen-dot-ca/Seraph", group: "Private" },
  { id: "tabularis", full: "TabularisDB/tabularis", group: "Open source" },
  { id: "matplotlib", full: "matplotlib/matplotlib", group: "Open source" },
  { id: "openclaw", full: "openclaw/openclaw", group: "Open source" },
  { id: "httpie", full: "httpie/cli", group: "Open source" },
];

// Issues nobody works on yet, waiting in their project's Open column.
export const OPEN_ISSUES: OpenIssue[] = [
  { id: "i1", short: "tabularis", ref: "tabularis #1402", title: "Column widths reset after sorting", plain: "When you sort a table, columns you made wider or narrower go back to their old width.", level: "Easy", opened: "2 d", minutes: 2880 },
  { id: "i2", short: "tabularis", ref: "tabularis #1397", title: "Tooltip text unreadable in dark mode", plain: "In dark mode, the little help boxes show dark text on a dark background.", level: "Easy", opened: "4 d", minutes: 5760 },
  { id: "i3", short: "matplotlib", ref: "matplotlib #29420", title: "Hatch patterns ignore line width in PDF output", plain: "Striped fills look right on screen but too thin when saved as a PDF.", level: "Medium", opened: "1 d", minutes: 1440 },
  { id: "i4", short: "openclaw", ref: "openclaw #830", title: "Settings search misses nested options", plain: "Searching in Settings doesn't find options that sit inside a group.", level: "Medium", opened: "3 d", minutes: 4320 },
  { id: "i5", short: "httpie", ref: "httpie #1631", title: "--print=b drops the trailing newline", plain: "When it prints only the response body, the last line break goes missing.", level: "Easy", opened: "5 d", minutes: 7200 },
  { id: "i6", short: "Seraph", ref: "Seraph #65", title: "Phone menu doesn't close after picking a page", plain: "On the phone, the menu stays open after you pick a page.", level: "Easy", opened: "1 h", minutes: 60 },
];

// What GitHub told you, each next to the work it belongs to.
export const NOTIFICATIONS: Notification[] = [
  { id: "n1", reason: "Changes asked", text: "@kuro asked for changes on #815", work: "w3", age: "Nov 2", minutes: 960 },
  { id: "n2", reason: "Assigned", text: "@phobson was assigned #29399; mpl-1 stopped", work: "w10", age: "1 h", minutes: 61 },
  { id: "n3", reason: "Checks", text: "Checks passed on #66", work: "w9", age: "20 min", minutes: 20 },
  { id: "n4", reason: "Merged", text: "@jkbr merged #1610", work: "w8", age: "2 d", minutes: 2880 },
  { id: "n5", reason: "Merged", text: "@debba merged #1361", work: "w12", age: "2 d", minutes: 2900 },
];

// What agents bring back when you ask them to find open-source projects (Add or find projects).
export const FOUND_PROJECTS = [
  { full: "pola-rs/polars", line: "Fast data tables. Merged 31 outside pull requests last month; first replies in about a day." },
  { full: "Textualize/rich", line: "Pretty terminal output. Merged 12 outside pull requests last month; friendly to newcomers." },
  { full: "streamlink/streamlink", line: "Video streams in a player. Merged 9 outside pull requests last month; AI-written fixes allowed." },
];
