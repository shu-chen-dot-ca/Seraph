import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PageHeader from "@/PageHeader";
import { toast } from "@/links";
import { cn } from "@/lib/utils";

/*
Settings, from your picture at the top right. "When agents ask you" is where your round 2 note lives: what always
waits for you, what goes ahead after a timer, and what agents decide on their own. The switches only change this
page here.
*/

const WAIT_FOR = [
  { key: "money", label: "Anything that costs money" },
  { key: "sensitive", label: "Politics and other sensitive subjects" },
  { key: "github", label: "What gets sent to GitHub, and how" },
  { key: "delete", label: "Deleting things that can't come back" },
];

function Toggle(props: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onChange(!props.on)}
      className={cn("relative h-5 w-9 shrink-0 rounded-full bg-input transition-colors", props.on && "bg-primary")}
    >
      <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-background transition-transform", props.on && "translate-x-4")} />
    </button>
  );
}

function Section(props: { title: string; line: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <h2 className="font-semibold">{props.title}</h2>
        <p className="text-muted-foreground">{props.line}</p>
      </div>
      {props.children}
    </section>
  );
}

export default function SettingsPage() {
  const [waits, setWaits] = useState<string[]>(WAIT_FOR.map((each) => each.key));
  const [timer, setTimer] = useState("10");

  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex max-w-2xl flex-col gap-4 p-4">
        <Section title="When agents ask you" line="Agents only ask when it matters. Everything else they decide themselves and write why on the timeline.">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 font-medium">
              <Badge variant="warn">Waits for you</Badge> However long it takes
            </div>
            {WAIT_FOR.map((each) => (
              <label key={each.key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                {each.label}
                <Toggle
                  label={each.label}
                  on={waits.includes(each.key)}
                  onChange={(on) => setWaits(on ? [...waits, each.key] : waits.filter((key) => key !== each.key))}
                />
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 font-medium">
              <Badge variant="secondary">Goes ahead</Badge> If you don't answer in
              <select value={timer} onChange={(event) => setTimer(event.target.value)} className="h-7 rounded-md border bg-background px-1.5 font-normal">
                <option value="5">5 minutes</option>
                <option value="10">10 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
              </select>
            </div>
            <div className="rounded-md border px-3 py-2 text-muted-foreground">
              Long runs, like a full test run or a build, and using a machine another agent waits for. The agent goes ahead with the choice it recommends.
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 font-medium">
              <Badge variant="outline">Doesn't ask</Badge>
            </div>
            <div className="rounded-md border px-3 py-2 text-muted-foreground">Small choices, like how to test or what to name things. The agent decides and writes why on the timeline.</div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="font-medium">When someone else takes an issue an agent is on</div>
            <div className="rounded-md border px-3 py-2 text-muted-foreground">
              The agent checks who it is. A maintainer or someone who often contributes: it stops. A new or bot-like account: it keeps going. Either way it writes
              what it found on the timeline, and you aren't asked.
            </div>
          </div>
        </Section>

        <Section title="GitHub account" line="Approve sends things as this account. Agents never post on their own.">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">S</span>
              Signed in to GitHub
            </span>
            <Button size="sm" variant="outline" onClick={() => toast("Sign out: asks first. Approvals can't be sent until you sign in again.")}>
              Sign out
            </Button>
          </div>
        </Section>

        <Section title="Phone" line="Reach Seraph from your phone, signed in with a passkey.">
          <div className="flex items-center justify-between gap-3">
            <span>iPhone · last used today</span>
            <Button size="sm" variant="outline" onClick={() => toast("Add a device: scan a code with the new phone.")}>
              Add a device
            </Button>
          </div>
        </Section>
      </div>
    </div>
  );
}
