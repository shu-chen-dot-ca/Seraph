/*
Explore's filters, in a pop-up: the tags of the Repos and Tracked pages, in their own colors, picked like labels. A
click turns one on or off, any number at once. "Only repos with" keeps a run to repos with a green tag; "Hide repos
with" keeps out repos with an amber or red one. A picked tag has a check mark and a ring; the others are paler. Every
click shows on the page at once (nothing to apply); Clear all takes them all off. They are for the next run
(github_searcher/explore.py FILTERS checks them).
*/

import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// The same keys as explore.py FILTERS, with the label and color of the tag each is about (components/ui/repo-tags.tsx,
// and the Tracked page's reply speed: green within 2 days, amber over a week).
export const FILTERS: { key: string; group: "only" | "hide"; label: string; variant: "ok" | "warn" | "bad"; title: string }[] = [
  { key: "ai_welcome", group: "only", label: "AI welcome", variant: "ok", title: "Its contribution files say AI-assisted contributions are fine" },
  { key: "newcomers_welcome", group: "only", label: "Welcomes newcomers", variant: "ok", title: "Most newcomers' first PRs get merged, with a first reply within 3 days" },
  { key: "warm_reviews", group: "only", label: "Warm reviews", variant: "ok", title: "Maintainers' feedback on outside PRs feels warm" },
  { key: "fast_replies", group: "only", label: "Replies in 2 days", variant: "ok", title: "Outside contributors' PRs get a first reply within 2 days (the median)" },
  { key: "beginner_issues", group: "only", label: "Free beginner issues", variant: "ok", title: "Open beginner issues (good first issue, help wanted...) nobody seems to have taken" },
  { key: "strong_fit", group: "only", label: "Strong fit", variant: "ok", title: "Exactly what your Explore profile asks for, Claude thinks" },
  { key: "hide_no_ai", group: "hide", label: "No AI", variant: "bad", title: "Its contribution files say AI-generated contributions are not accepted" },
  { key: "hide_newcomers_wait", group: "hide", label: "Newcomers wait", variant: "warn", title: "Newcomers' first PRs are mostly closed unmerged, or wait over a week for a reply" },
  { key: "hide_strict", group: "hide", label: "Strict reviews", variant: "warn", title: "Maintainers' feedback on outside PRs feels strict" },
  { key: "hide_curt", group: "hide", label: "Curt reviews", variant: "bad", title: "Maintainers' feedback on outside PRs feels curt" },
  { key: "hide_slow_replies", group: "hide", label: "Replies over a week", variant: "warn", title: "Outside contributors' PRs wait over a week for a first reply (the median)" },
  { key: "hide_one_maintainer", group: "hide", label: "1 maintainer", variant: "warn", title: "One person or nobody merged a PR in the last 30 days" },
  { key: "hide_unanswered", group: "hide", label: "5+ unanswered PRs", variant: "warn", title: "5 or more outside contributors' PRs open over 30 days that nobody answered" },
];

const SECTIONS: { group: "only" | "hide"; heading: string }[] = [
  { group: "only", heading: "Only repos with" },
  { group: "hide", heading: "Hide repos with" },
];

export default function ExploreFiltersDialog(props: { filters: string[]; onChange: (filters: string[]) => void; onClose: () => void }) {
  function toggle(key: string) {
    props.onChange(props.filters.includes(key) ? props.filters.filter((each) => each !== key) : [...props.filters, key]);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Filters</DialogTitle>
          <DialogDescription>Pick as many tags as you like. The next run only keeps repos that match all of them.</DialogDescription>
        </DialogHeader>

        {SECTIONS.map((section) => (
          <div key={section.group} className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{section.heading}</div>
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.filter((each) => each.group === section.group).map((each) => {
                const on = props.filters.includes(each.key);
                return (
                  <button key={each.key} type="button" className="rounded-full" title={each.title} aria-pressed={on} onClick={() => toggle(each.key)}>
                    <Badge variant={each.variant} className={cn("h-6 cursor-pointer px-2.5 text-[13px]", on ? "ring-1 ring-current" : "opacity-55 hover:opacity-100")}>
                      {on && <Check />}
                      {each.label}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <DialogFooter>
          <Button variant="ghost" disabled={props.filters.length === 0} onClick={() => props.onChange([])}>
            Clear all
          </Button>
          <Button onClick={props.onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
