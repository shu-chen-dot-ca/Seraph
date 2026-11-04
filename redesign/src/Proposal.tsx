import Pick from "@/Pick";

/*
Round 3's page, where you start. The design picked in rounds 1 and 2 is now clickable end to end, with no real logic:
clicks only change what the mock shows, and Reset in the top bar starts over. This page lists what changed from
round 2's notes, then each flow to play with (where to start, what to try), each with a Pick for round 4.
*/

const CHANGES = [
  "Papers are gone.",
  "One Inbox with a Questions tab and an Approvals tab. Projects show as boards. Every list uses two-line rows.",
  "A question either has a timer or waits for you. With a timer (long runs, a busy machine), the agent goes ahead with its recommended choice when time is up. Money, sensitive subjects and what gets sent to GitHub wait for you however long it takes.",
  "Small choices are never asked. The agent decides and writes why on the timeline.",
  "When someone else takes an issue, the agent checks who it is and decides itself: a maintainer, it stops; a bot or new account, it keeps going. You see it on the timeline and in Notifications, not as a question.",
  "These rules are in Settings (your picture, top right), as switches.",
];

const FLOWS = [
  {
    key: "answer",
    name: "Answer a question",
    start: "#/questions",
    steps: "Inbox → Questions. One goes ahead in 9 minutes by itself; two wait for you (money, and how things get sent). Open one, pick an answer, and land on its issue page, where the agent carries on.",
  },
  {
    key: "approve",
    name: "Approve one",
    start: "#/approvals/d1",
    steps: "Read the plain summary, what was checked, and what could go wrong. Approve asks once, then you land on the issue page: Sent, with the new pull request number.",
  },
  {
    key: "bulk",
    name: "Approve several at once",
    start: "#/approvals",
    steps: "Ctrl/⌘-click or drag down the rows, then Approve in the bar at the bottom. One “Are you sure?” lists them all.",
  },
  {
    key: "reject",
    name: "Reject with a note",
    start: "#/approvals/d7",
    steps: "Reject asks why. The agent gets your note and tries again; the issue page shows it.",
  },
  {
    key: "assign",
    name: "Assign an open issue",
    start: "#/p/tabularis",
    steps: "On the board, Open holds issues nobody works on. Assign → pick who (or a new agent) and which machine. The card moves to In progress.",
  },
  {
    key: "new",
    name: "Start something new",
    start: "#/p/Seraph",
    steps: "New in the header: Fix an issue (pick one, then assign), New issue (say it in plain words; it lands in Open), or Ask an agent (you land in its chat).",
  },
  {
    key: "add",
    name: "Add or find a project",
    start: "#/p/httpie",
    steps: "Add or find projects, at the bottom of the projects in the left list: add one by its link, or let agents find good open-source ones. It shows up in the left list.",
  },
  {
    key: "follow",
    name: "Follow a fix, message its agent, stop it",
    start: "#/p/matplotlib/w2",
    steps: "One page from issue to merged: steps, timeline with proof, and everything linked on the right. Message opens the agent's chat; Stop asks first.",
  },
  {
    key: "decided",
    name: "See what an agent decided on its own",
    start: "#/p/matplotlib/w10",
    steps: "A maintainer took this issue, so mpl-1 stopped by itself. On matplotlib #29411, a bot said it would fix it, so mpl-2 kept going.",
  },
  {
    key: "desktop",
    name: "Watch or take over a desktop",
    start: "#/machines/vm1",
    steps: "Machines → a VM → Watch a desktop. Take over pauses the agent until you Give back.",
  },
  {
    key: "settings",
    name: "Set when agents may ask you",
    start: "#/settings",
    steps: "Your picture → Settings → When agents ask you: what waits, how long the timer is, what agents decide alone.",
  },
  {
    key: "notifications",
    name: "Catch up on GitHub",
    start: "#/notifications",
    steps: "Each notification opens the issue it belongs to. Select some and Mark as read, or Mark all as read.",
  },
];

export default function Proposal() {
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-4 pt-10 pb-24">
        <div className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Round 3 · Nov 4</div>
        <h1 className="mt-2 max-w-2xl text-3xl leading-tight font-semibold tracking-tight text-balance">The picked design, clickable end to end</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          No real logic: clicking only changes what the mockup shows, and nothing leaves your laptop. Reset in the top bar starts over, and Phone shows it at phone
          width. Play with each flow below, then pick Keep or Change and say what to change.
        </p>

        <h2 className="mt-10 text-lg font-semibold">What your round 2 notes changed</h2>
        <ul className="mt-3 flex flex-col gap-px overflow-hidden rounded-xl border bg-border">
          {CHANGES.map((change) => (
            <li key={change} className="bg-card px-4 py-2.5">
              {change}
            </li>
          ))}
        </ul>

        <h2 className="mt-10 text-lg font-semibold">Flows to try</h2>
        <div className="mt-3 flex flex-col gap-3">
          {FLOWS.map((flow) => (
            <div key={flow.key} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[15px] font-semibold">{flow.name}</h3>
                <a href={flow.start} className="text-primary hover:underline">
                  Start here →
                </a>
              </div>
              <p className="text-muted-foreground">{flow.steps}</p>
              <Pick id={`r3-${flow.key}`} options={["Keep", "Change"]} />
            </div>
          ))}
        </div>

        <h2 className="mt-10 text-lg font-semibold">Anything else for round 4?</h2>
        <div className="mt-3 rounded-xl border bg-card p-4">
          <Pick id="r3-overall" />
        </div>
      </div>
    </div>
  );
}
