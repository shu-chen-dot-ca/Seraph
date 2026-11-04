import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Dialog from "@/Dialog";
import PageHeader from "@/PageHeader";
import { DRAFT_BY_ID, STAGE_LABEL, STEPS, WORK_BY_ID, type Event, type Proof, type Work } from "@/data";
import { Go, href, toast } from "@/links";
import { cn } from "@/lib/utils";
import { useStore, workNow } from "@/store";

/*
One work item: a piece of work's whole story on one page, from the issue to merged, under its project. At the top,
what it waits on you for, if anything; then its steps; then one timeline of what happened, who did it and when,
with the proof where it happened (decisions the agent made on its own are on it too, with why); and on the right
everything it is linked to. Message opens the agent's chat; Stop asks first, then keeps what was done.
*/

export function StageBadge(props: { work: Work }) {
  const stage = props.work.stage;
  if (stage === "approval") {
    return <Badge>{STAGE_LABEL[stage]}</Badge>;
  }
  if (stage === "merged") {
    return <Badge variant="ok">{STAGE_LABEL[stage]}</Badge>;
  }
  if (stage === "cancelled") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {STAGE_LABEL[stage]}
      </Badge>
    );
  }
  return <Badge variant="secondary">{STAGE_LABEL[stage]}</Badge>;
}

export function ProofList(props: { proof: Proof[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {props.proof.map((proof, index) => {
        if (proof.shot) {
          return (
            <div
              key={index}
              className="flex aspect-[16/10] w-40 max-w-full items-end overflow-hidden rounded-md border bg-[image:repeating-linear-gradient(135deg,var(--muted)_0_8px,var(--card)_8px_16px)]"
            >
              <span className="w-full border-t bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground">{proof.shot}</span>
            </div>
          );
        }
        if (proof.run) {
          return (
            <pre key={index} className="rounded-md border bg-muted px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap">
              {proof.run.join("\n")}
            </pre>
          );
        }
        return (
          <div key={index} className="rounded-md border bg-card px-2.5 py-1.5 text-xs">
            {(proof.check ?? []).map((item) => (
              <div key={item}>
                <span className="font-semibold text-ok">✓</span> {item}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Who(props: { name: string }) {
  if (props.name === "you") {
    return <span className="font-medium">You</span>;
  }
  if (props.name === "app") {
    return <span className="font-medium">Seraph</span>;
  }
  if (props.name.startsWith("gh:")) {
    return (
      <span>
        <span className="font-medium">{props.name.slice(3)}</span> <span className="text-muted-foreground">on GitHub</span>
      </span>
    );
  }
  return (
    <span className="font-medium">
      <Go kind="agent" id={props.name}>
        {props.name}
      </Go>
    </span>
  );
}

export function Timeline(props: { events: Event[] }) {
  return (
    <div className="flex flex-col">
      {props.events.map((event, index) => (
        <div key={index} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3 border-t py-2 first:border-t-0 @max-2xl:grid-cols-1 @max-2xl:gap-0.5">
          <time className="pt-px text-xs text-muted-foreground tabular-nums">{event.time}</time>
          <div>
            <Who name={event.who} /> <span className={cn(event.live && "text-primary")}>{event.text}</span>{" "}
            {event.link && (
              <Go kind={event.link.kind} id={event.link.id}>
                {event.link.text}
              </Go>
            )}
            {event.proof && <ProofList proof={event.proof} />}
          </div>
        </div>
      ))}
    </div>
  );
}

// The steps from start to end, the one it is on in the accent. A cancelled one stops in red where it stopped.
export function Steps(props: { steps: string[]; at: number; stopped?: boolean }) {
  return (
    <div className="flex">
      {props.steps.map((step, index) => (
        <div
          key={step}
          className={cn(
            "relative flex-1 truncate pt-2 pr-1 text-[11.5px] text-muted-foreground before:absolute before:inset-x-0 before:top-0 before:mr-1 before:h-[3px] before:rounded-full before:bg-border",
            index < props.at && "text-foreground before:bg-idle",
            index === props.at && "font-semibold text-primary before:bg-primary",
            index === props.at && props.stopped && "text-destructive before:bg-destructive",
          )}
        >
          {index === props.at && props.stopped ? "Cancelled" : step}
        </div>
      ))}
    </div>
  );
}

function Related(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col bg-card px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}

export function WorkItem(props: { id: string }) {
  const { store, update } = useStore();
  const [stopping, setStopping] = useState(false);
  if (!WORK_BY_ID[props.id]) {
    return <PageHeader title="Not found" back />;
  }
  const work = workNow(WORK_BY_ID[props.id], store);
  const draft = work.draft ? DRAFT_BY_ID[work.draft] : null;
  let at = { working: 1, review: 2, approval: 3, sent: 4, merged: 5, cancelled: 1 }[work.stage];
  if (work.type === "My project" && work.stage === "merged") {
    at = 4;
  }
  if (work.stage === "merged") {
    at = at + 1;
  }
  const canStop = work.stage === "working" || work.stage === "review" || work.stage === "approval";
  const actions = (
    <div className="flex items-center gap-1.5">
      <StageBadge work={work} />
      <Button size="sm" variant="outline" asChild>
        <a href={href("agent", work.agent)}>Message</a>
      </Button>
      {canStop && (
        <Button size="sm" variant="outline" onClick={() => setStopping(true)}>
          Stop
        </Button>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader back title={work.title} meta={`${work.ref} · ${work.type}`} right={actions} />
      <div className="flex flex-col gap-4 p-4">
        {draft?.group === "question" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
            <span>
              {work.agent} asked you: <b className="font-medium">{draft.ask}</b> {draft.timer ? `It goes ahead in ${draft.timer} if you don't answer.` : "It waits for you."}
            </span>
            <Go kind="draft" id={draft.id}>
              Answer
            </Go>
          </div>
        )}
        {draft?.group === "approval" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-selected px-3 py-2">
            <span>
              Waiting for your approval: <b className="font-medium">{draft.ask}</b> Nothing has been sent.
            </span>
            <Go kind="draft" id={draft.id}>
              Open
            </Go>
          </div>
        )}
        {work.sent && <div className="rounded-lg border bg-card px-3 py-2">{work.sent}</div>}
        <Steps steps={STEPS[work.type]} at={at} stopped={work.stage === "cancelled"} />
        <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-5 @max-2xl:grid-cols-1">
          <Timeline events={work.timeline} />
          <aside className="flex flex-col gap-px overflow-hidden rounded-lg border bg-border @max-2xl:-order-1">
            <Related label="Agent">
              <Go kind="agent" id={work.agent}>
                {work.agent}
              </Go>
            </Related>
            {work.reviewer && (
              <Related label="Reviewer">
                <Go kind="agent" id={work.reviewer}>
                  {work.reviewer}
                </Go>
              </Related>
            )}
            <Related label="Machine">
              <Go kind="vm" id={work.vm}>
                {work.vm} · desktop {work.desk}
              </Go>
            </Related>
            <Related label="On GitHub">
              <span className="text-muted-foreground">Issue {work.ref.split(" ")[1]} ↗</span>
              {work.pr && <span className="text-muted-foreground">Pull request #{work.pr} ↗</span>}
            </Related>
            <Related label="Project">
              <Go kind="project" id={work.short}>
                {work.repo}
              </Go>
            </Related>
          </aside>
        </div>
      </div>
      {stopping && (
        <Dialog
          title={`Stop ${work.ref}?`}
          confirm="Stop"
          danger
          onClose={() => setStopping(false)}
          onConfirm={() => {
            update((before) => ({ ...before, stopped: [...before.stopped, work.id] }));
            toast(`${work.agent} stopped. What it did so far is kept here.`);
            setStopping(false);
          }}
        >
          <p>{work.agent} stops working on it. What it did so far stays on this page, and nothing is sent.</p>
        </Dialog>
      )}
    </div>
  );
}
