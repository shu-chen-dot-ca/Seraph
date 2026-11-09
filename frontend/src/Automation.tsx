/*
The Dashboard's Automation page (#/dashboard/automation): Seraph finds repos, works on them and lets go of them by
itself, as you (backend/automation_api.py). The ones that merge our PRs stay, new ones come in through Explore, the ones
that don't merge are archived.

The top bar: three tabs (the first two with how many), and on the right Pause new issues, Active repositories (how many to
keep in Repos, not archived: 1 to 300; saved on Enter or when the box loses focus) and the On/Off switch. Turning it on
asks first (Enter confirms), and says how many repos it would archive at once. Pause new issues stops agents taking new
issues from the Issues board's Catalog, on or off; everything else goes on (Resume new issues undoes it). Under it one
line: how many are active, whether new issues are paused, and what Explore does now.

- Repositories: every repo in Repos with its label, from our PRs there (hover a label for its rule), the line that
  decided it, our PRs (merged, closed, open) and how many PRs the repo merges a day. In the order agents take their
  issues: by label, then the most merged a day; the archived ones last, under a line. The labels show while it is off
  too, so you can see what it would do.
- Activity (?tab=activity): what it did, newest first: added, archived, unarchived, closed a PR.
- Settings (?tab=settings, AutomationSettings.tsx): every level of automation in one place (each repo's, each issue's,
  the Issues board's, the one new repos get) with the same robot dialogs as elsewhere, and the rules behind the labels.

It all comes from the live "automation" topic (and "repos", "explore"), so it updates by itself.
*/

import { Archive } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";

import AutomationSettings from "@/AutomationSettings";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, useLive, useLoaded, type AutomationData, type AutomationLabelName } from "@/live";
import { timeAgo } from "@/lib/utils";

// Each label's color; its rule, in the backend's words, shows on hover.
const LABELS: Record<AutomationLabelName, "ok" | "fine" | "warn" | "bad" | "secondary"> = {
  Fast: "ok",
  Normal: "fine",
  New: "secondary",
  Slow: "warn",
  "No issues": "secondary",
  "Not merging": "bad",
};

export default function Automation(props: { tab: "repos" | "activity" | "settings" }) {
  const automation = useLive("automation");
  const repos = useLive("repos");
  const explore = useLive("explore");
  const loaded = useLoaded("automation");
  const [target, setTarget] = useState(String(automation.active_repos));
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The box follows the saved number when it changes elsewhere.
  useEffect(() => {
    setTarget(String(automation.active_repos));
  }, [automation.active_repos]);

  const rows = repos.items.map((repo) => ({ repo: repo, label: automation.labels[repo.full_name], archived: repos.archived.includes(repo.full_name) }));
  rows.sort((a, b) => {
    if (a.archived !== b.archived) {
      return a.archived ? 1 : -1;
    }
    const rankA = a.label?.rank ?? 99;
    const rankB = b.label?.rank ?? 99;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return (b.label?.per_day ?? 0) - (a.label?.per_day ?? 0);
  });
  const active = rows.filter((row) => !row.archived);
  const notMerging = active.filter((row) => row.label?.label === "Not merging").length;
  const log = [...automation.log].reverse();
  const run = explore.run;

  async function save(on: boolean, number: string, takeNew: boolean) {
    try {
      await api<AutomationData>("/api/automation", { method: "PUT", body: { on: on, active_repos: Number(number), take_new: takeNew } });
    } catch (err) {
      toast.error(`Could not save: ${err instanceof Error ? err.message : err}`);
      setTarget(String(automation.active_repos));
    }
  }

  function saveTarget() {
    if (target !== String(automation.active_repos)) {
      save(automation.on, target, automation.take_new);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1">
        <Tabs
          value={props.tab}
          onValueChange={(value) => {
            window.location.hash = value === "repos" ? "#/dashboard/automation" : `#/dashboard/automation?tab=${value}`;
          }}
        >
          <TabsList>
            <TabsTrigger value="repos" className="px-2.5">
              Repositories <span className="text-xs text-muted-foreground tabular-nums">{rows.length}</span>
            </TabsTrigger>
            <TabsTrigger value="activity" className="px-2.5">
              Activity <span className="text-xs text-muted-foreground tabular-nums">{log.length}</span>
            </TabsTrigger>
            <TabsTrigger value="settings" className="px-2.5">
              Settings
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!loaded}
            title="Agents take no new issues from Catalog. Jobs already started, follow-ups and everything else go on."
            onClick={() => save(automation.on, target, !automation.take_new)}
          >
            {automation.take_new ? "Pause new issues" : "Resume new issues"}
          </Button>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            Active repositories
            <Input
              className="h-7 w-16"
              inputMode="numeric"
              value={target}
              onChange={(event) => setTarget(event.target.value.replace(/\D/g, ""))}
              onBlur={saveTarget}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  saveTarget();
                }
              }}
            />
          </label>
          <label className="flex items-center gap-2 font-medium">
            <Switch
              checked={automation.on}
              disabled={!loaded}
              onCheckedChange={(checked) => {
                if (checked) {
                  setConfirmOpen(true);
                } else {
                  save(false, target, automation.take_new);
                }
              }}
            />
            {automation.on ? "On" : "Off"}
          </label>
        </div>
      </div>

      <div className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground tabular-nums">
        {active.length} of {automation.active_repos} active
        {!automation.take_new && " · New issues paused"}
        {run !== null && run.status === "running" && (
          <>
            {" · "}Explore: {run.found} of {run.count ?? "∞"} found, {run.looked_at} looked at, {run.checking.length} checking now
          </>
        )}
        {(run === null || run.status !== "running") && " · Explore: not running"}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded && <div className="px-3 py-2 text-muted-foreground">Loading…</div>}
        {loaded && props.tab === "repos" && rows.length === 0 && <div className="px-3 py-2 text-muted-foreground">No repositories yet.</div>}
        {loaded &&
          props.tab === "repos" &&
          rows.map((row, index) => (
            <Fragment key={row.repo.full_name}>
              {index === active.length && (
                <div className="flex items-center gap-2 border-b px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">
                  <Archive className="size-3.5" /> Archived
                  <span className="tabular-nums">{rows.length - active.length}</span>
                </div>
              )}
              <div className="flex gap-3 border-b px-3 py-2.5">
                <img src={`https://github.com/${row.repo.full_name.split("/")[0]}.png?size=64`} alt="" className="mt-0.5 size-8 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <a href={row.repo.html_url} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
                      {row.repo.full_name}
                    </a>
                    {row.label !== undefined && (
                      <Badge variant={LABELS[row.label.label]} title={automation.label_rules[row.label.label]}>
                        {row.label.label}
                      </Badge>
                    )}
                    {row.archived && automation.archived[row.repo.full_name] !== undefined && (
                      <span className="text-xs whitespace-nowrap text-muted-foreground" title={new Date(automation.archived[row.repo.full_name]).toLocaleString()}>
                        archived {timeAgo(automation.archived[row.repo.full_name])}
                      </span>
                    )}
                  </div>
                  {row.label !== undefined && <div className="mt-0.5 text-muted-foreground">{row.label.why}</div>}
                  {row.label !== undefined && (
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                      <span title="Our pull requests there">
                        {row.label.merged} merged · {row.label.closed} closed · {row.label.open} open
                      </span>
                      {row.label.per_day !== null && <span title="Pull requests the repo merges a day, anyone's (the last 90 days)">{row.label.per_day} merged a day</span>}
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          ))}

        {loaded && props.tab === "settings" && <AutomationSettings />}
        {loaded && props.tab === "activity" && log.length === 0 && <div className="px-3 py-2 text-muted-foreground">Nothing yet.</div>}
        {loaded &&
          props.tab === "activity" &&
          log.map((entry, index) => (
            <div key={index} className="flex gap-3 border-b px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-medium whitespace-nowrap">{entry.what}</span>
                  <a href={`https://github.com/${entry.repo}`} target="_blank" rel="noreferrer" className="truncate hover:underline">
                    {entry.repo}
                  </a>
                  <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground" title={new Date(entry.at).toLocaleString()}>
                    {timeAgo(entry.at)}
                  </span>
                </div>
                {entry.why !== "" && <div className="mt-0.5 text-muted-foreground">{entry.why}</div>}
              </div>
            </div>
          ))}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on Automation?</AlertDialogTitle>
            <AlertDialogDescription>
              Seraph will add repositories, take their issues and send pull requests as you, without asking. Repositories that don't merge ours are
              archived.
              {notMerging > 0 && ` ${notMerging === 1 ? "1 repository is" : `${notMerging} repositories are`} Not merging now and will be archived at once.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => save(true, target, automation.take_new)}>Turn on</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
