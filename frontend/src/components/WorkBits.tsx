import { Check, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { useLive, type EvidenceItem } from "@/live";
import { cn } from "@/lib/utils";
import type { TimelineEvent } from "@/model/timeline";
import { STAGE_LABEL, type Stage } from "@/model/work";
import { href } from "@/routes";

/*
The small pieces work pages share: a stage as a tag, the steps from open to done, who did something (an agent's name
links to its page), screenshots, and a timeline.
*/

export function StageBadge(props: { stage: Stage }) {
  if (props.stage === "approval") {
    return <Badge>{STAGE_LABEL[props.stage]}</Badge>;
  }
  if (props.stage === "merged") {
    return <Badge variant="ok">{STAGE_LABEL[props.stage]}</Badge>;
  }
  if (props.stage === "closed" || props.stage === "stopped") {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {STAGE_LABEL[props.stage]}
      </Badge>
    );
  }
  return <Badge variant="secondary">{STAGE_LABEL[props.stage]}</Badge>;
}

// The stages from open to done, the one it is at in the accent; one that stopped or closed shows that in red.
export function StageSteps(props: { stage: Stage; openSource: boolean }) {
  const steps: Stage[] = props.openSource ? ["open", "working", "review", "approval", "sent", "merged"] : ["open", "working", "review", "approval", "merged"];
  const ended = props.stage === "stopped" || props.stage === "closed";
  const at = ended ? -1 : steps.indexOf(props.stage);
  return (
    <div className="flex">
      {steps.map((step, index) => (
        <div
          key={step}
          className={cn(
            "relative flex-1 truncate pt-2 pr-1 text-[11.5px] text-muted-foreground before:absolute before:inset-x-0 before:top-0 before:mr-1 before:h-[3px] before:rounded-full before:bg-border",
            (index < at || (props.stage === "merged" && index === at)) && "text-foreground before:bg-idle",
            index === at && props.stage !== "merged" && "font-semibold text-primary before:bg-primary",
          )}
        >
          {STAGE_LABEL[step]}
        </div>
      ))}
      {ended && <div className="relative truncate pt-2 text-[11.5px] font-semibold text-destructive before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:rounded-full before:bg-destructive">{STAGE_LABEL[props.stage]}</div>}
    </div>
  );
}

// "you" → You, "app" → Seraph, "@login" → @login, an agent id → its name, linking to its page.
export function Who(props: { who: string }) {
  const agents = useLive("agents");
  if (props.who === "you") {
    return <span className="font-medium">You</span>;
  }
  if (props.who === "app") {
    return <span className="font-medium">Seraph</span>;
  }
  if (props.who.startsWith("@")) {
    return <span className="font-medium">{props.who}</span>;
  }
  const agent = agents.find((each) => each.id === props.who);
  return (
    <a href={href.agent(props.who)} className="font-medium text-primary hover:underline">
      {agent?.name ?? props.who}
    </a>
  );
}

export function Shots(props: { shots: EvidenceItem[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {props.shots
        .filter((shot) => shot.file !== null)
        .map((shot) => (
          <a key={shot.id} href={`/api/evidence/${shot.file}`} target="_blank" rel="noreferrer" className="block w-44 max-w-full overflow-hidden rounded-md border bg-card hover:border-input">
            <img src={`/api/evidence/${shot.file}`} alt={shot.caption} className="aspect-[16/10] w-full object-cover object-top" loading="lazy" />
            <span className="block truncate border-t px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {shot.stage === "before" ? "Before: " : shot.stage === "after" ? "After: " : ""}
              {shot.caption}
            </span>
          </a>
        ))}
    </div>
  );
}

export function CheckLine(props: { done: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Check className={cn("mt-0.5 size-4 shrink-0", props.done ? "text-ok" : "text-muted-foreground/40")} />
      <div>{props.children}</div>
    </div>
  );
}

function time(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? clock : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

export function Timeline(props: { events: TimelineEvent[] }) {
  if (props.events.length === 0) {
    return <p className="text-muted-foreground">Nothing has happened yet.</p>;
  }
  return (
    <div className="flex flex-col">
      {props.events.map((event, index) => (
        <div key={index} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-t py-2 first:border-t-0 max-md:grid-cols-1 max-md:gap-0.5">
          <time className="pt-px text-xs text-muted-foreground tabular-nums" dateTime={event.at}>
            {time(event.at)}
          </time>
          <div className="min-w-0">
            <Who who={event.who} /> <span>{event.text}</span>{" "}
            {event.draft && (
              <a href={href.inboxItem(event.draft)} className="text-primary hover:underline">
                Open
              </a>
            )}
            {event.url && (
              <a href={event.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground">
                <ExternalLink className="size-3" />
              </a>
            )}
            {event.shots && event.shots.length > 0 && <Shots shots={event.shots} />}
            {event.output && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Output</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded-md border bg-muted px-2 py-1.5 text-[11px] whitespace-pre-wrap">{event.output}</pre>
              </details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
