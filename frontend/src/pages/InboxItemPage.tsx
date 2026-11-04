import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ConfirmDialog";
import DiffView from "@/components/DiffView";
import PageHeader from "@/components/PageHeader";
import { CheckLine, Shots, Who } from "@/components/WorkBits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNow } from "@/components/ui/job-progress";
import { Markdown } from "@/components/ui/markdown";
import { Textarea } from "@/components/ui/textarea";
import { api, useLive, type Draft, type Job } from "@/live";
import { cn } from "@/lib/utils";
import { useGithubAccount, useSending } from "@/model/account";
import { askOf, kindOf } from "@/model/inbox";
import { isQuestion } from "@/model/work";
import { questionWhen } from "@/pages/InboxPage";
import { href } from "@/routes";

/*
One question or approval from the Inbox, on its own page.

A question shows what the agent asks, when it goes ahead without you (its timer) or why it waits, and one button per
answer, the agent's recommended one marked. Picking one answers it ("I pick: X"); you can also answer in your own
words. Old "taken" items have Keep working and Stop.

An approval starts with what the agent needs, as a plain question ("Send this fix to tabularis?"), then what it is
about in plain words, what was checked (the issue's points, before and after screenshots, the project's own tests,
the reviewer's verdict) and what could go wrong. The diff, the exact words that will be posted and the commits are
folded under Details. A comment or a new title and description shows its text unfolded, since that text is what you
approve. An action (request a review, ready for review, close, ...) is said in its question; the comment posted with it,
if any, shows below. A PR whose claim (the comment the project's rules ask for first) is still in the Inbox links to it,
and its Approve waits until the claim is decided. Approve asks first and sends it to GitHub as you (it needs your GitHub sign-in, in Settings). Reject asks
for a note: the agent tries again with it, or drops it.

Once answered or rejected, you land on the issue's page, where the timeline shows what happened. After Approve you
stay here: sending takes a while, and the page shows it is sending (also after you close the dialog or come back
later), then that it was sent, with a link to the issue's page.
*/

// "owner/name#12" → that issue's page, else the Inbox.
function workHref(id: string | null): string {
  const match = (id ?? "").match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  return match === null ? href.inbox() : href.work(match[1], Number(match[2]));
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{props.title}</h2>
      {props.children}
    </section>
  );
}

function Details(props: { title: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border bg-card">
      <summary className="cursor-pointer px-3 py-2 text-muted-foreground hover:text-foreground">{props.title}</summary>
      <div className="border-t p-3">{props.children}</div>
    </details>
  );
}

// A draft's text with its pictures: "![..](evidence:ev_x)" becomes the evidence file's address.
function withPictures(draft: Draft): string {
  return draft.body.replace(/\(evidence:([\w-]+)\)/g, (whole, id: string) => {
    const evidence = draft.evidence.find((each) => each.id === id);
    return evidence?.file ? `(/api/evidence/${evidence.file})` : whole;
  });
}

function Question(props: { draft: Draft }) {
  const draft = props.draft;
  const now = useNow();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const target = workHref(draft.target);

  async function send(path: string, text: string, message: string) {
    setBusy(true);
    try {
      await api(`/api/inbox/${draft.id}/${path}`, { method: "POST", body: { text: text } });
      toast.success(message);
      window.location.hash = target;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4 p-4">
      {draft.body.trim() !== "" && draft.body.trim() !== draft.title.trim() && <Markdown text={withPictures(draft)} githubImagesOnly issueRefs />}
      {draft.answer_by && draft.recommended && (
        <div className="rounded-lg border bg-card px-3 py-2">
          {questionWhen(draft, now)}: if you don't answer, <Who who={draft.agent} /> goes ahead with “{draft.recommended}”.
        </div>
      )}
      {!draft.answer_by && draft.kind === "question" && <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">{questionWhen(draft, now)}. It doesn't go ahead without you.</div>}
      {draft.kind === "taken" && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => send("approve", "", "The agent keeps working.")}>
            Keep working
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => send("reject", "", "The agent stops.")}>
            Stop the agent
          </Button>
        </div>
      )}
      {draft.options.length > 0 && (
        <div className="flex flex-col gap-2">
          {draft.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => send("reply", `I pick: ${option}`, `Answered: ${option}.`)}
              className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-left font-medium hover:border-primary disabled:opacity-50"
            >
              {option}
              {option === draft.recommended && <Badge>Recommended</Badge>}
            </button>
          ))}
        </div>
      )}
      {draft.kind === "question" && (
        <div className="flex flex-col gap-1.5">
          <Textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={draft.options.length > 0 ? "Or answer in your own words" : "Your answer"} />
          <Button size="sm" variant="outline" className="self-end" disabled={busy || answer.trim() === ""} onClick={() => send("reply", answer.trim(), "Answered.")}>
            Send answer
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Your answer goes only to the agent. Nothing goes to GitHub.</p>
    </div>
  );
}

function Approval(props: { draft: Draft; job: Job | null }) {
  const draft = props.draft;
  const overview = draft.overview;
  const account = useGithubAccount();
  const sending = useSending();
  const agents = useLive("agents");
  const drafts = useLive("inbox");
  // The claim the project's rules ask for goes out before the PR (its job's one comment): decide it first.
  const claim = draft.kind === "pr" && draft.update_of === null ? drafts.find((other) => other.job === draft.job && other.kind === "comment" && other.status === "pending") : undefined;
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  // Sending takes a while (the fork, the branch, the pull request). It shows here even after its dialog is closed,
  // and when you come back to this page: the backend says which draft it is sending.
  const [started, setStarted] = useState(false);
  const [note, setNote] = useState("");
  const [drop, setDrop] = useState(false);
  const target = workHref(draft.update_of ?? draft.target);
  const signedIn = account !== null && account.connected;
  const isSending = started || sending.draft === draft.id;
  const reviewer = agents.find((agent) => agent.id === draft.review?.agent)?.name ?? draft.review?.agent ?? "";
  const shots = draft.evidence.filter((evidence) => evidence.file !== null);
  const tests = props.job?.tests ?? { before: null, after: null };
  const repoName = (draft.repo ?? draft.target ?? "").split("#")[0];

  let sends = `Approve sends it to ${repoName} as you.`;
  if (draft.kind === "pr" && draft.update_of === null) {
    sends = `Approve opens a pull request on ${repoName} as you.`;
  }
  if (draft.kind === "comment") {
    sends = "Approve posts the comment as you.";
  }
  if (draft.kind === "action") {
    sends = draft.body !== "" ? "Approve does it on GitHub as you, and posts the comment." : "Approve does it on GitHub as you.";
  }
  if (draft.update_of !== null) {
    sends = `Approve adds the new version to ${draft.update_of} as you.`;
  }

  // You stay on this page: once sent, it says so, with a link to the issue's page.
  async function approve() {
    setStarted(true);
    try {
      await api(`/api/inbox/${draft.id}/approve`, { method: "POST", body: { send: true } });
      toast.success("Sent to GitHub as you.");
    } catch (err) {
      setStarted(false);
      toast.error(`Could not send it: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }

  async function reject() {
    if (drop) {
      await api(`/api/inbox/${draft.id}/reject`, { method: "POST", body: { text: note.trim() } });
      toast.success("Rejected. Nothing was sent.");
    } else {
      await api(`/api/inbox/${draft.id}/reply`, { method: "POST", body: { text: note.trim() } });
      toast.success("The agent tries again with your note.");
    }
    window.location.hash = target;
  }

  const about = [overview.problem, overview.fix ?? overview.why].filter((part) => part !== undefined && part !== "");

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex max-w-2xl flex-1 flex-col gap-5 p-4">
        {overview.project && <p className="text-muted-foreground">{overview.project}</p>}
        {about.map((part) => (
          <p key={part} className="text-sm">
            {part}
          </p>
        ))}
        {about.length === 0 && draft.kind === "pr" && <Markdown text={withPictures(draft)} githubImagesOnly issueRefs />}

        {draft.kind === "pr" && (
          <Section title="Checked">
            <div className="flex flex-col gap-1.5">
              {(overview.checklist ?? []).map((point) => (
                <CheckLine key={point.item} done={point.done}>
                  {point.item}
                  {point.how !== "" && <span className="text-muted-foreground"> · {point.how}</span>}
                </CheckLine>
              ))}
              {tests.before !== null && <CheckLine done={tests.before.passed}>The project's own tests {tests.before.passed ? "pass" : "fail"} on the code before the change</CheckLine>}
              {tests.after !== null && <CheckLine done={tests.after.passed}>The project's own tests {tests.after.passed ? "pass" : "fail"} with the change</CheckLine>}
              {(overview.also_tested ?? []).map((test) => (
                <CheckLine key={test} done>
                  Also tried: {test}
                </CheckLine>
              ))}
              {draft.review?.state === "passed" && (
                <CheckLine done>
                  A second agent ({reviewer}) tried to break it{draft.review.notes !== "" ? `: ${draft.review.notes}` : ""}
                </CheckLine>
              )}
              {shots.length > 0 && <Shots shots={shots} />}
            </div>
          </Section>
        )}
        {draft.kind === "pr" && (
          <Section title="What could go wrong">
            {(overview.risks ?? []).length === 0 && <p className="text-muted-foreground">Nothing found.</p>}
            <ul className="list-disc space-y-1 pl-5">
              {(overview.risks ?? []).map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
          </Section>
        )}
        {draft.kind === "comment" && (
          <Section title="What will be posted">
            <div className="rounded-lg border bg-card p-3">
              <Markdown text={withPictures(draft)} githubImagesOnly issueRefs />
            </div>
          </Section>
        )}
        {draft.kind === "edit" && (
          <Section title="New title and description">
            <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <div className="font-medium">{draft.title}</div>
              <Markdown text={draft.body} githubImagesOnly issueRefs />
              {draft.previous !== null && <p className="border-t pt-2 text-xs text-muted-foreground">It was: {draft.previous.title}</p>}
            </div>
          </Section>
        )}
        {draft.kind === "action" && draft.body !== "" && (
          <Section title="Comment posted with it">
            <div className="rounded-lg border bg-card p-3">
              <Markdown text={draft.body} githubImagesOnly issueRefs />
            </div>
          </Section>
        )}
        {draft.kind === "pr" && (
          <div className="flex flex-col gap-1.5">
            <Details title="Details: the changes">
              <DiffView diff={draft.diff} />
            </Details>
            <Details title="Details: what will be posted, word for word">
              <div className="mb-2 font-medium">{draft.title}</div>
              <Markdown text={withPictures(draft)} githubImagesOnly issueRefs />
            </Details>
            {draft.commits.length > 0 && (
              <Details title={`Details: ${draft.commits.length} ${draft.commits.length === 1 ? "commit" : "commits"}`}>
                <ul className="flex flex-col gap-1 font-mono text-xs">
                  {draft.commits.map((commit) => (
                    <li key={commit.sha} className={cn(!commit.own && "text-destructive")}>
                      {commit.sha.slice(0, 7)} {commit.message.split("\n")[0]}
                      {!commit.own && " (not the agent's: can't be sent)"}
                    </li>
                  ))}
                </ul>
              </Details>
            )}
          </div>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-2.5">
        <span className="min-w-48 flex-1 text-xs text-muted-foreground">
          {isSending && (
            <span className="flex items-center gap-1.5 text-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Sending to GitHub{sending.draft === draft.id && sending.step !== "" ? `: ${sending.step}` : "…"}
            </span>
          )}
          {!isSending && signedIn && claim !== undefined && (
            <>
              Approve or reject the claim first:{" "}
              <a href={href.inboxItem(claim.id)} className="text-primary hover:underline">
                {claim.title}
              </a>
            </>
          )}
          {!isSending && signedIn && claim === undefined && `Not sent yet. ${sends}`}
          {account !== null && !signedIn && (
            <>
              Sign in to GitHub to send it:{" "}
              <a href={href.settings()} className="text-primary hover:underline">
                Settings
              </a>
            </>
          )}
        </span>
        <Button size="sm" variant="outline" disabled={isSending} onClick={() => setDialog("reject")}>
          Reject
        </Button>
        <Button size="sm" disabled={!signedIn || isSending || claim !== undefined} onClick={() => setDialog("approve")}>
          {isSending && <Loader2 className="animate-spin" />}
          {isSending ? "Sending" : "Approve"}
        </Button>
      </div>

      {dialog === "approve" && (
        <ConfirmDialog title={askOf(draft)} confirm="Approve and send" onClose={() => setDialog(null)} onConfirm={approve}>
          <p>{sends} People may see it right away.</p>
          <p className="text-muted-foreground">Sending can take a minute. You can close this; it keeps going, and this page shows it.</p>
        </ConfirmDialog>
      )}
      {dialog === "reject" && (
        <ConfirmDialog
          title="Reject this?"
          confirm={drop ? "Reject" : "Ask for another try"}
          danger={drop}
          disabled={!drop && note.trim() === ""}
          onClose={() => setDialog(null)}
          onConfirm={reject}
        >
          <Textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why? The agent reads this." />
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2">
              <input type="radio" name="reject" checked={!drop} onChange={() => setDrop(false)} className="accent-[var(--primary)]" />
              Try again with my note
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="reject" checked={drop} onChange={() => setDrop(true)} className="accent-[var(--primary)]" />
              Drop it: nothing is sent and the agent stops on it
            </label>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function InboxItemPage(props: { id: string }) {
  const drafts = useLive("inbox");
  const jobs = useLive("jobs");
  const draft = drafts.find((each) => each.id === props.id);
  if (draft === undefined) {
    return <PageHeader back title="Not in the Inbox" meta="It may have been decided, or it waits for its review." />;
  }
  const job = jobs.find((each) => each.id === draft.job) ?? null;
  const target = draft.update_of ?? draft.target;
  const meta = (
    <span className="flex flex-wrap items-center gap-x-1.5">
      From <Who who={draft.agent} />
      {target !== null && (
        <>
          <span>·</span>
          <a href={workHref(target)} className="text-primary hover:underline">
            {target}
          </a>
        </>
      )}
    </span>
  );
  const question = isQuestion(draft);
  const badge = question ? <Badge variant="warn">Question</Badge> : <Badge>{kindOf(draft)}</Badge>;

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader back title={question ? draft.title : askOf(draft)} meta={meta} right={badge} />
      {draft.status !== "pending" && (
        <div className="m-4 mb-0 max-w-2xl rounded-lg border bg-card px-3 py-2">
          {draft.status === "approved" && (draft.sent !== null ? "You approved it, and it was sent." : "You approved it.")}
          {draft.status === "rejected" && `You rejected it${draft.reply !== "" ? `: “${draft.reply}”` : "."}`}
          {draft.status === "replied" && `${draft.answered_by === "timer" ? "No answer in time; the agent went ahead with" : "You answered:"} ${draft.reply.replace(/^I pick:\s*/, "")}`}{" "}
          <a href={workHref(target)} className="text-primary hover:underline">
            See what happened
          </a>
        </div>
      )}
      {draft.status === "pending" && question && <Question draft={draft} />}
      {draft.status === "pending" && !question && <Approval draft={draft} job={job} />}
    </div>
  );
}
