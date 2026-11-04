import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import DataList from "@/DataList";
import Dialog from "@/Dialog";
import PageHeader from "@/PageHeader";
import { DRAFT_BY_ID, NOTIFICATIONS, WORK_BY_ID, type Draft } from "@/data";
import { Go, href, toast } from "@/links";
import { cn } from "@/lib/utils";
import { openDrafts, useStore } from "@/store";
import { ProofList } from "@/WorkPage";

/*
The Inbox: what agents need from you, in two tabs (picked in round 2), so each works one way.
- Questions: an agent is stopped until you answer. A question either has a timer (after it, the agent goes ahead
  with the choice it recommends) or waits for you (money, anything sensitive, what gets sent to GitHub). Answered
  one at a time.
- Approvals: only things to send or merge, so Approve works the same on each, and on many at once.
Every item starts with what the agent needs, as a plain question; details are folded away. Approve and Reject ask
first. Handled items leave the list, and their work item shows what happened.
*/

const QUESTION_TEXT: Record<string, { about: string; options: { label: string; means: string; recommended?: boolean }[]; asked: string }> = {
  d3: {
    about: "mpl-2 has a fix for the chart problem and wants to check it with all of matplotlib's own tests. While they run, other agents can't use vm2.",
    options: [
      { label: "Run them now", means: "Results in about 40 minutes.", recommended: true },
      { label: "Run them tonight", means: "Nobody waits for vm2 today, but the fix is ready tomorrow." },
    ],
    asked: "Run the full test suite (pytest -n 4, about 40 min) on vm2 now? It holds desktop 1 while it runs.",
  },
  d8: {
    about: "seraph-worker-1 is adding “approve many at once” to Seraph. It needs to know how careful that should be.",
    options: [
      { label: "Ask once for all", means: "One “Are you sure?”, then everything selected is sent.", recommended: true },
      { label: "Ask for each one", means: "Safer, but slow when many are selected." },
    ],
    asked: "Bulk approve: one confirmation dialog for N items, or N dialogs?",
  },
  d9: {
    about: "tabularis-2 fixed an export that times out. It's checked with a local database. Checking it with a hosted one, like the person who reported it uses, needs a paid account.",
    options: [
      { label: "Pay $5 for one month", means: "The fix is checked the same way the reporter uses it." },
      { label: "Skip that check", means: "The fix is still checked with a local database. The pull request says the hosted one wasn't tried.", recommended: true },
    ],
    asked: "Create a hosted PostgreSQL instance (cheapest tier, $5/month) to reproduce the timeout against a remote server?",
  },
};

const APPROVAL_TEXT: Record<string, { about: string; checked: { text: string; shot?: string }[]; risk: string; sends: string; confirm: string; diff: string; message: string }> = {
  d1: {
    about: "When you export a table to a file, its last row goes missing. With this fix every row is saved.",
    checked: [
      { text: "Saw the problem happen", shot: "Before: the last row is missing" },
      { text: "Works after the fix", shot: "After: every row is there" },
      { text: "The project's own tests pass, before and after" },
      { text: "A second agent tried to break it and couldn't" },
    ],
    risk: "Files exported before the fix stay incomplete. It doesn't repair them.",
    sends: "Approve sends the fix to tabularis as a pull request from you.",
    confirm: "This opens a pull request on tabularis as you. You can close it later, but people may see it right away.",
    diff: "src/export/csv.ts\n-  for (let i = 0; i < rows.length - 1; i++) {\n+  for (let i = 0; i < rows.length; i++) {\n\ntests/export.test.ts  +18 lines",
    message: "Fix CSV export dropping the last row\n\nFixes #1388.\n\nWhen a table has no trailing newline, the export loop stopped one row early.\nIt now writes every row. Added a test that exports 1, 3 and 10,000 rows.",
  },
  d2: {
    about: "A maintainer asked for one more case: the “match my computer” theme was still forgotten. openclaw-1 fixed that too and wrote a short reply.",
    checked: [
      { text: "Saw the problem happen", shot: "Before: the theme resets" },
      { text: "Works after the fix", shot: "After: the theme is kept" },
      { text: "The project's own tests pass, before and after" },
    ],
    risk: "None found. It only changes the theme setting.",
    sends: "Approve posts the reply on pull request #815 and adds the new fix to it, as you.",
    confirm: "This posts the reply on #815 and adds the new fix to it, as you.",
    diff: 'src/ui/theme.ts\n+  if (saved === "system") return watchSystemTheme();\n\ntests/theme.test.ts  +12 lines',
    message: "Thanks! Good catch. The system theme now sticks too: it's saved like light and dark,\nand it follows the OS when that changes. Added a test for it.",
  },
  d4: {
    about: "Jobs can be sorted by any column, and the sort is kept when you come back.",
    checked: [{ text: "The reviewer tried it", shot: "Jobs sorted by agent" }, { text: "Seraph's own tests pass" }],
    risk: "The Done tab of Jobs sorts the same way now.",
    sends: "Approve merges it into Seraph.",
    confirm: "This merges pull request #64 into Seraph's main branch.",
    diff: "frontend/src/Jobs.tsx  +64 −12",
    message: "feat(frontend): sort jobs by any column",
  },
  d7: {
    about: "In a narrow terminal window, httpie's download progress bar flickers. With this fix it stays still.",
    checked: [
      { text: "Saw the problem happen", shot: "Before: the bar flickers" },
      { text: "Works after the fix", shot: "After: the bar stays still" },
      { text: "The project's own tests pass, before and after" },
      { text: "A second agent tried very narrow and very wide windows" },
    ],
    risk: "None found.",
    sends: "Approve sends the fix to httpie as a pull request from you.",
    confirm: "This opens a pull request on httpie as you. You can close it later, but people may see it right away.",
    diff: "httpie/output/ui/rich_progress.py  +9 −3",
    message: "Fix progress bar flicker in narrow terminals\n\nFixes #1625.",
  },
};

// A question's second line: when the agent goes ahead without you, or why it waits.
function questionWhen(draft: Draft) {
  if (draft.timer) {
    return `Goes ahead in ${draft.timer}`;
  }
  return `Waits for you · ${draft.why}`;
}

export function Inbox(props: { tab: "questions" | "approvals" }) {
  const { store, update } = useStore();
  const [approving, setApproving] = useState<Draft[]>([]);
  const [rejecting, setRejecting] = useState<Draft[]>([]);
  const [reason, setReason] = useState("");
  const questions = openDrafts(store, "question");
  const approvals = openDrafts(store, "approval");
  const tabs = [
    { key: "questions", label: "Questions", count: questions.length },
    { key: "approvals", label: "Approvals", count: approvals.length },
  ];

  function decide(drafts: Draft[], what: "approved" | "rejected", text: string) {
    update((store) => {
      const done = { ...store.done };
      for (const draft of drafts) {
        done[draft.id] = { what, text };
      }
      return { ...store, done };
    });
  }

  return (
    <div>
      <PageHeader title="Inbox" meta={props.tab === "questions" ? "Agents are stopped until you answer these." : "Nothing is sent until you approve."} />
      <div className="flex gap-1 border-b px-3">
        {tabs.map((tab) => (
          <a
            key={tab.key}
            href={`#/${tab.key}`}
            className={cn(
              "relative flex items-center gap-1.5 px-2 py-2 text-[12.5px] font-medium text-muted-foreground hover:text-foreground",
              props.tab === tab.key && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
            )}
          >
            {tab.label}
            {tab.count > 0 && (
              <span
                className={cn(
                  "min-w-4.5 rounded-full px-1.5 text-center text-xs leading-4.5 tabular-nums",
                  tab.key === "questions" ? "bg-warn text-background" : "bg-primary text-primary-foreground",
                )}
              >
                {tab.count}
              </span>
            )}
          </a>
        ))}
      </div>

      {props.tab === "questions" && (
        <DataList
          id="questions"
          rows={questions}
          rowId={(draft) => draft.id}
          rowHref={(draft) => href("draft", draft.id)}
          defaultSort={{ key: "waiting", dir: -1 }}
          empty="No questions. No agent is waiting on you."
          columns={[
            { key: "ask", label: "Question", main: true, sortValue: (draft) => draft.ask, cell: (draft) => draft.ask },
            {
              key: "when",
              label: "Goes ahead",
              sortValue: (draft) => (draft.timer ? 0 : 1),
              cell: (draft) => <Badge variant={draft.timer ? "secondary" : "warn"}>{questionWhen(draft)}</Badge>,
            },
            { key: "agent", label: "Agent", sortValue: (draft) => WORK_BY_ID[draft.work].agent, cell: (draft) => WORK_BY_ID[draft.work].agent },
            { key: "project", label: "Project", sortValue: (draft) => WORK_BY_ID[draft.work].ref, cell: (draft) => WORK_BY_ID[draft.work].ref },
            { key: "waiting", label: "Asked", time: true, sortValue: (draft) => draft.minutes, cell: (draft) => `${draft.age} ago` },
          ]}
          bulk={() => []}
        />
      )}

      {props.tab === "approvals" && (
        <DataList
          id="approvals"
          rows={approvals}
          rowId={(draft) => draft.id}
          rowHref={(draft) => href("draft", draft.id)}
          defaultSort={{ key: "age", dir: -1 }}
          empty="Nothing to approve."
          chips={[
            { key: "send", label: "Send", test: (draft) => draft.kind === "Fix" || draft.kind === "Reply" },
            { key: "merge", label: "Merge", test: (draft) => draft.kind === "Merge" },
          ]}
          columns={[
            { key: "ask", label: "Approval", main: true, sortValue: (draft) => draft.ask, cell: (draft) => draft.ask },
            { key: "kind", label: "Kind", sortValue: (draft) => draft.kind, cell: (draft) => <Badge>{draft.kind}</Badge> },
            { key: "project", label: "Project", sortValue: (draft) => WORK_BY_ID[draft.work].ref, cell: (draft) => WORK_BY_ID[draft.work].ref },
            { key: "agent", label: "From", sortValue: (draft) => WORK_BY_ID[draft.work].agent, cell: (draft) => WORK_BY_ID[draft.work].agent },
            { key: "age", label: "Waiting", time: true, sortValue: (draft) => draft.minutes, cell: (draft) => draft.age },
          ]}
          bulk={() => [
            { label: "Approve", primary: true, onClick: (rows) => setApproving(rows) },
            { label: "Reject", onClick: (rows) => setRejecting(rows) },
          ]}
        />
      )}

      {approving.length > 0 && (
        <Dialog
          title={`Approve ${approving.length} ${approving.length === 1 ? "item" : "items"}?`}
          confirm="Approve all"
          onClose={() => setApproving([])}
          onConfirm={() => {
            decide(approving, "approved", "");
            toast(`Approved ${approving.length}. Each was sent to GitHub as you.`);
            setApproving([]);
          }}
        >
          <p className="text-muted-foreground">Each one is sent to GitHub as you, right away.</p>
          <ul className="flex flex-col gap-1">
            {approving.map((draft) => (
              <li key={draft.id} className="rounded-md border px-3 py-1.5">
                {draft.ask}
              </li>
            ))}
          </ul>
        </Dialog>
      )}
      {rejecting.length > 0 && (
        <Dialog
          title={`Reject ${rejecting.length} ${rejecting.length === 1 ? "item" : "items"}?`}
          confirm="Reject"
          disabled={reason.trim() === ""}
          onClose={() => setRejecting([])}
          onConfirm={() => {
            decide(rejecting, "rejected", reason.trim());
            toast(`Rejected ${rejecting.length}. Each agent tries again with your note.`);
            setRejecting([]);
            setReason("");
          }}
        >
          <p className="text-muted-foreground">Each agent gets your note and tries again. Nothing is sent.</p>
          <textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why? (the agents read this)"
            className="min-h-20 resize-y rounded-md border bg-background px-2.5 py-2 outline-none focus-visible:border-ring"
          />
        </Dialog>
      )}
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{props.title}</h2>
      {props.children}
    </div>
  );
}

function Details(props: { title: string; text: string }) {
  return (
    <details className="rounded-lg border bg-card">
      <summary className="cursor-pointer px-3 py-2 text-muted-foreground hover:text-foreground">{props.title}</summary>
      <pre className="overflow-x-auto border-t px-3 py-2 text-[11.5px] whitespace-pre-wrap">{props.text}</pre>
    </details>
  );
}

export function InboxItem(props: { id: string }) {
  const { store, update } = useStore();
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [reason, setReason] = useState("");
  const [answer, setAnswer] = useState("");
  const draft = DRAFT_BY_ID[props.id];
  if (!draft) {
    return <PageHeader title="Not found" back />;
  }
  const work = WORK_BY_ID[draft.work];
  const done = store.done[draft.id];

  function finish(what: "approved" | "rejected" | "answered", text: string, message: string) {
    update((before) => ({ ...before, done: { ...before.done, [draft.id]: { what, text } } }));
    toast(message);
    window.location.hash = href("work", work.id);
  }

  const meta = (
    <span className="flex flex-wrap items-center gap-x-1.5">
      <span>From</span>
      <Go kind="agent" id={work.agent}>
        {work.agent}
      </Go>
      <span>·</span>
      <Go kind="work" id={work.id}>
        {work.ref}
      </Go>
      <span>· {draft.age} ago</span>
    </span>
  );

  if (done) {
    return (
      <div>
        <PageHeader back title={draft.ask} meta={meta} />
        <div className="flex max-w-2xl flex-col gap-3 p-4">
          <div className="rounded-lg border bg-card px-3 py-2">
            {done.what === "approved" && "You approved this."}
            {done.what === "rejected" && `You rejected this: “${done.text}”`}
            {done.what === "answered" && `You answered: ${done.text}`}
          </div>
          <Go kind="work" id={work.id}>
            See what happened on {work.ref} →
          </Go>
        </div>
      </div>
    );
  }

  if (draft.group === "question") {
    const text = QUESTION_TEXT[draft.id];
    const recommended = text.options.find((option) => option.recommended);
    return (
      <div className="flex min-h-full flex-col">
        <PageHeader back title={draft.ask} meta={meta} right={<Badge variant="warn">Agent stopped</Badge>} />
        <div className="flex max-w-2xl flex-1 flex-col gap-4 p-4">
          <p className="text-sm">{text.about}</p>
          {draft.timer && recommended && (
            <div className="rounded-lg border bg-card px-3 py-2">
              If you don't answer in <b className="font-medium">{draft.timer}</b>, {work.agent} goes ahead with “{recommended.label}”.
            </div>
          )}
          {!draft.timer && <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">This waits for you, however long it takes. {draft.why}</div>}
          <div className="flex flex-col gap-2">
            {text.options.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => finish("answered", option.label, `${work.agent} carries on: ${option.label}.`)}
                className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left hover:border-primary"
              >
                <span className="flex items-center gap-2 font-medium">
                  {option.label}
                  {option.recommended && <Badge>Recommended</Badge>}
                </span>
                <span className="text-muted-foreground">{option.means}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Or answer in your own words"
              className="min-h-16 resize-y rounded-md border bg-background px-2.5 py-2 outline-none focus-visible:border-ring"
            />
            <Button
              size="sm"
              variant="outline"
              className="self-end"
              disabled={answer.trim() === ""}
              onClick={() => finish("answered", `“${answer.trim()}”`, `${work.agent} carries on with your answer.`)}
            >
              Send answer
            </Button>
          </div>
          <Details title="Details: what the agent asked, word for word" text={text.asked} />
        </div>
        <div className="sticky bottom-0 border-t bg-background px-4 py-2.5 text-xs text-muted-foreground">Your answer goes only to {work.agent}. Nothing goes to GitHub.</div>
      </div>
    );
  }

  const text = APPROVAL_TEXT[draft.id];
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader back title={draft.ask} meta={meta} right={<Badge>{draft.kind}</Badge>} />
      <div className="flex max-w-2xl flex-1 flex-col gap-5 p-4">
        <p className="text-sm">{text.about}</p>
        <Section title="Checked">
          <div className="flex flex-col gap-2">
            {text.checked.map((item) => (
              <div key={item.text}>
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-ok" />
                  {item.text}
                </div>
                {item.shot && (
                  <div className="pl-6">
                    <ProofList proof={[{ shot: item.shot }]} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
        <Section title="What could go wrong">
          <p>{text.risk}</p>
        </Section>
        <div className="flex flex-col gap-1.5">
          <Details title="Details: the changes" text={text.diff} />
          <Details title="Details: what will be posted, word for word" text={text.message} />
        </div>
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-2.5">
        <span className="min-w-48 flex-1 text-xs text-muted-foreground">Not sent yet. {text.sends}</span>
        <Button size="sm" variant="outline" onClick={() => setDialog("reject")}>
          Reject
        </Button>
        <Button size="sm" onClick={() => setDialog("approve")}>
          Approve
        </Button>
      </div>

      {dialog === "approve" && (
        <Dialog
          title={draft.ask}
          confirm={draft.kind === "Merge" ? "Merge" : "Approve and send"}
          onClose={() => setDialog(null)}
          onConfirm={() => finish("approved", "", draft.kind === "Merge" ? "Merged." : "Sent to GitHub as you.")}
        >
          <p>{text.confirm}</p>
        </Dialog>
      )}
      {dialog === "reject" && (
        <Dialog
          title="Reject this?"
          confirm="Reject"
          disabled={reason.trim() === ""}
          onClose={() => setDialog(null)}
          onConfirm={() => finish("rejected", reason.trim(), `${work.agent} tries again with your note.`)}
        >
          <p className="text-muted-foreground">{work.agent} gets your note and tries again. Nothing is sent.</p>
          <textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why? (the agent reads this)"
            className="min-h-20 resize-y rounded-md border bg-background px-2.5 py-2 outline-none focus-visible:border-ring"
          />
        </Dialog>
      )}
    </div>
  );
}

export function NotificationList() {
  const { store, update } = useStore();
  const unread = NOTIFICATIONS.filter((each) => !store.read.includes(each.id)).length;
  return (
    <div>
      <PageHeader
        title="Notifications"
        meta={`What GitHub told you, next to the work it belongs to · ${unread} unread`}
        right={
          <Button size="sm" variant="outline" disabled={unread === 0} onClick={() => update((before) => ({ ...before, read: NOTIFICATIONS.map((each) => each.id) }))}>
            Mark all as read
          </Button>
        }
      />
      <DataList
        id="notifications"
        rows={NOTIFICATIONS}
        rowId={(each) => each.id}
        rowHref={(each) => href("work", each.work)}
        defaultSort={{ key: "age", dir: 1 }}
        empty="No notifications."
        quiet={(each) => store.read.includes(each.id)}
        columns={[
          { key: "text", label: "What happened", main: true, sortValue: (each) => each.text, cell: (each) => each.text },
          { key: "reason", label: "Reason", sortValue: (each) => each.reason, cell: (each) => <Badge variant="secondary">{each.reason}</Badge> },
          { key: "work", label: "Work", sortValue: (each) => WORK_BY_ID[each.work].ref, cell: (each) => WORK_BY_ID[each.work].ref },
          { key: "age", label: "When", time: true, sortValue: (each) => each.minutes, cell: (each) => each.age },
        ]}
        bulk={() => [
          { label: "Mark as read", onClick: (rows) => update((before) => ({ ...before, read: [...before.read, ...rows.map((each) => each.id)] })) },
        ]}
      />
    </div>
  );
}
