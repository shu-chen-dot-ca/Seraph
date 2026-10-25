/*
Explore's filters, in a pop-up: every tag a repo can get, the same as the Repos and Tracked pages, in their own colors,
in sections by kind: Fit, AI policy, Newcomers, Reviews, First reply, Activity, Other (free beginner issues, 1
maintainer, 5+ unanswered PRs). Each tag has three states, a click moves it on: once to include it (a check mark and a
ring), twice to exclude it (an x, crossed out, with a ring), a third time back to "doesn't matter" (paler). Of one kind
(say AI policy), a repo needs any one of the included tags; it never has an excluded one. Every click shows on the page
at once (nothing to apply); Clear all puts them all back. They are for the next run (github_searcher/explore.py FILTERS
checks them). The Explore bar doesn't list the picked ones, this pop-up is where to check them. While a run goes it
shows the run's own filters, locked: nothing to click, only Done.
*/

import { Check, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type Filters = Record<string, "include" | "exclude">;

// The same keys as explore.py FILTERS ("kind:value"), with the label and color of the tag (components/ui/repo-tags.tsx,
// and the Tracked page's reply speed: green within 2 days, amber over a week).
export const FILTERS: { key: string; section: string; label: string; variant: "ok" | "warn" | "bad" | "secondary"; title: string }[] = [
  { key: "fit:strong", section: "Fit", label: "Strong fit", variant: "ok", title: "Exactly what your Explore profile asks for, Claude thinks" },
  { key: "fit:good", section: "Fit", label: "Good fit", variant: "secondary", title: "Clearly in your interests, Claude thinks" },
  { key: "fit:some", section: "Fit", label: "Some fit", variant: "secondary", title: "Related, but not what you're after, Claude thinks" },
  { key: "fit:weak", section: "Fit", label: "Weak fit", variant: "secondary", title: "Hardly matches your Explore profile, Claude thinks" },
  { key: "policy:welcome", section: "AI policy", label: "AI welcome", variant: "ok", title: "Its contribution files say AI-assisted contributions are fine" },
  { key: "policy:disclose", section: "AI policy", label: "AI: disclose", variant: "secondary", title: "AI-assisted contributions are allowed under conditions, e.g. saying so" },
  { key: "policy:no_ai", section: "AI policy", label: "No AI", variant: "bad", title: "Its contribution files say AI-generated contributions are not accepted" },
  { key: "policy:unclear", section: "AI policy", label: "AI: unclear", variant: "secondary", title: "AI is mentioned, but what's allowed isn't said" },
  { key: "policy:none", section: "AI policy", label: "No AI policy", variant: "secondary", title: "Its contribution files say nothing about AI" },
  { key: "newcomers:welcomes", section: "Newcomers", label: "Welcomes newcomers", variant: "ok", title: "Most newcomers' first PRs get merged, with a first reply within 3 days" },
  { key: "newcomers:ok", section: "Newcomers", label: "Newcomers OK", variant: "secondary", title: "Newcomers' first PRs fare neither clearly well nor badly" },
  { key: "newcomers:wait", section: "Newcomers", label: "Newcomers wait", variant: "warn", title: "Newcomers' first PRs are mostly closed unmerged, or wait over a week for a reply" },
  { key: "newcomers:few", section: "Newcomers", label: "Few newcomers", variant: "secondary", title: "Too few newcomers lately to tell" },
  { key: "tone:warm", section: "Reviews", label: "Warm reviews", variant: "ok", title: "Maintainers' feedback on outside PRs feels warm" },
  { key: "tone:neutral", section: "Reviews", label: "Neutral reviews", variant: "secondary", title: "Maintainers' feedback on outside PRs feels neutral" },
  { key: "tone:strict", section: "Reviews", label: "Strict reviews", variant: "warn", title: "Maintainers' feedback on outside PRs feels strict" },
  { key: "tone:curt", section: "Reviews", label: "Curt reviews", variant: "bad", title: "Maintainers' feedback on outside PRs feels curt" },
  { key: "tone:unknown", section: "Reviews", label: "Little review feedback", variant: "secondary", title: "Too little maintainer feedback on recent outside PRs to judge" },
  { key: "reply:fast", section: "First reply", label: "Replies in 2 days", variant: "ok", title: "Outside contributors' PRs get a first reply within 2 days (the median)" },
  { key: "reply:week", section: "First reply", label: "Replies in a week", variant: "secondary", title: "Outside contributors' PRs get a first reply in 3 to 7 days (the median)" },
  { key: "reply:slow", section: "First reply", label: "Replies over a week", variant: "warn", title: "Outside contributors' PRs wait over a week for a first reply (the median)" },
  { key: "trend:up", section: "Activity", label: "Busier", variant: "secondary", title: "The last 30 days were busier than the 90-day average" },
  { key: "trend:flat", section: "Activity", label: "Steady", variant: "secondary", title: "The last 30 days were about as busy as the 90-day average" },
  { key: "trend:down", section: "Activity", label: "Quieter", variant: "secondary", title: "The last 30 days were quieter than the 90-day average" },
  { key: "issues:beginner", section: "Other", label: "Free beginner issues", variant: "ok", title: "Open beginner issues (good first issue, help wanted...) nobody seems to have taken" },
  { key: "maintainers:one", section: "Other", label: "1 maintainer", variant: "warn", title: "One person or nobody merged a PR in the last 30 days" },
  { key: "unanswered:many", section: "Other", label: "5+ unanswered PRs", variant: "warn", title: "5 or more outside contributors' PRs open over 30 days that nobody answered" },
];

const SECTIONS = ["Fit", "AI policy", "Newcomers", "Reviews", "First reply", "Activity", "Other"];

const STATE_NAME = { include: "included", exclude: "excluded", none: "doesn't matter" };

export default function ExploreFiltersDialog(props: { filters: Filters; locked: boolean; onChange: (filters: Filters) => void; onClose: () => void }) {
  // Doesn't matter → include → exclude → doesn't matter.
  function cycle(key: string) {
    const next = { ...props.filters };
    if (next[key] === undefined) {
      next[key] = "include";
    } else if (next[key] === "include") {
      next[key] = "exclude";
    } else {
      delete next[key];
    }
    props.onChange(next);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Filters</DialogTitle>
          <DialogDescription>
            {props.locked
              ? "The filters of the run going now. Stop it to change them."
              : "Click a tag once to include it, twice to exclude it, again for doesn't matter. Of one kind, a repo needs any one of the included tags."}
          </DialogDescription>
        </DialogHeader>

        {SECTIONS.map((section) => (
          <div key={section} className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{section}</div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.filter((each) => each.section === section).map((each) => {
                let state: "include" | "exclude" | "none" = "none";
                if (each.key in props.filters) {
                  state = props.filters[each.key];
                }
                return (
                  <button
                    key={each.key}
                    type="button"
                    className="rounded-full"
                    title={each.title}
                    aria-label={`${each.label}: ${STATE_NAME[state]}`}
                    disabled={props.locked}
                    onClick={() => cycle(each.key)}
                  >
                    <Badge
                      variant={each.variant}
                      className={cn(
                        "h-6 px-2.5 text-[13px]",
                        !props.locked && "cursor-pointer",
                        state === "none" ? "opacity-55" : "ring-1 ring-current",
                        state === "none" && !props.locked && "hover:opacity-100",
                        state === "exclude" && "line-through",
                      )}
                    >
                      {state === "include" && <Check />}
                      {state === "exclude" && <X />}
                      {each.label}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <DialogFooter>
          {!props.locked && (
            <Button variant="ghost" disabled={Object.keys(props.filters).length === 0} onClick={() => props.onChange({})}>
              Clear all
            </Button>
          )}
          <Button onClick={props.onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
