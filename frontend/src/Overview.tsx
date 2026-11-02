/*
A draft's Overview tab in the Inbox: what it is about and the proof, written for you, not for the project.

Top: the project in one line, then the agent's plain-words explanation (github_searcher/inbox.py): the
problem as someone using the project sees it, its cause, the fix and what could still go wrong (for a
comment: the problem and why post it; a question, and the app's "taken" notice, are shown as they are). A PR then has
its Checklist, every point that was asked (the issue's requirements, or the reviewers' points for a new version), with
what isn't done first, and what the agent Also tested beyond the asked example.

Below, "Before and after": the agent's evidence, grouped by topic in the order it was added. Each topic
starts with its context (what is shown and how to read it), then its before and after side by side (an
empty side says it is missing); "other" items take the full width under them. Pictures open full size on
click; there ← / → step through every picture of the draft, so flipping between a before and its after
shows exactly what changed. A command shows its exit code; short output is shown as it is, longer output
folds open, and "Full output" loads what was cut.

A report on a paper (draft_report) is shown in three parts, one per Inbox tab (part):
- overview: what the paper is, what it claims, how it came out, what the agent couldn't check, then its full report.
- results: the paper's numbers next to the agent's and the authors' code's, then the agent's runs that no problem
  points to (e.g. its version and the authors' code on the paper's data).
- problems: each problem in plain words (what, and why it matters), with the run that shows it.
*/

import { ChevronLeft, ChevronRight, Loader2, SquareTerminal } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { api, type Draft, type EvidenceItem } from "@/live";

const STAGE_LABEL: Record<string, string> = { before: "Before", after: "After", other: "" };

// A command's output up to this many lines is shown right away; longer output folds.
const SHORT_OUTPUT_LINES = 8;

export default function Overview(props: { draft: Draft; part?: string; files: number; added: number; removed: number }) {
  const draft = props.draft;
  const overview = draft.overview;
  // A report's part, its Inbox tab; other drafts have only the overview.
  const part = props.part ?? "overview";
  const results = overview.results ?? [];
  const problems = overview.problems ?? [];
  const unchecked = overview.unchecked ?? [];
  // A report's runs that no problem points to: shown under its results.
  const runs = draft.evidence.filter((item) => !problems.some((problem) => problem.evidence === item.id));
  // The full outputs loaded so far, by output file; "" while one loads.
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  // Long command outputs folded open, by evidence id.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // Which picture the full-size view shows (an index into images), or null when it is closed.
  const [viewing, setViewing] = useState<number | null>(null);

  // Topics in the order they first came, each with its context, before, after and others.
  const topics: { name: string; context: string; before: EvidenceItem | null; after: EvidenceItem | null; others: EvidenceItem[] }[] = [];
  for (const item of draft.evidence) {
    let topic = topics.find((each) => each.name.trim().toLowerCase() === item.topic.trim().toLowerCase());
    if (topic === undefined) {
      topic = { name: item.topic, context: "", before: null, after: null, others: [] };
      topics.push(topic);
    }
    // The newest context wins (a retake may say it better).
    if (item.context) {
      topic.context = item.context;
    }
    if (item.stage === "before") {
      topic.before = item;
    } else if (item.stage === "after") {
      topic.after = item;
    } else {
      topic.others.push(item);
    }
  }

  // Every picture in the order it is shown on the page: a before, then its after, then the others.
  const images: EvidenceItem[] = [];
  for (const topic of topics) {
    for (const item of [topic.before, topic.after, ...topic.others]) {
      if (item !== null && item.file !== null) {
        images.push(item);
      }
    }
  }
  const shown = viewing !== null ? images[viewing] : undefined;

  // The explanation's rows, in reading order; only the ones the draft has.
  const rows: { label: string; text: string }[] = [];
  if (overview.problem) {
    rows.push({ label: "Problem", text: overview.problem });
  }
  if (overview.cause) {
    rows.push({ label: "Cause", text: overview.cause });
  }
  if (overview.fix) {
    rows.push({ label: "Fix", text: overview.fix });
  }
  if (overview.why) {
    rows.push({ label: "Why post this", text: overview.why });
  }
  const risks = overview.risks ?? [];
  // What isn't done first: the gaps are what you need to see before approving.
  const checklist = [...(overview.checklist ?? [])].sort((a, b) => Number(a.done) - Number(b.done));
  const alsoTested = overview.also_tested ?? [];

  async function loadOutput(file: string) {
    setOutputs((current) => ({ ...current, [file]: "" }));
    try {
      const text = await api<string>(`/api/evidence/${file}`);
      setOutputs((current) => ({ ...current, [file]: text }));
    } catch (err) {
      setOutputs((current) => ({ ...current, [file]: `Could not load the output: ${err instanceof Error ? err.message : err}` }));
    }
  }

  function renderItem(item: EvidenceItem | null, stage: string) {
    if (item === null) {
      return (
        <div className="flex min-h-24 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{STAGE_LABEL[stage]}</span>
          <div className="flex flex-1 items-center justify-center border border-dashed text-xs text-muted-foreground">
            No {STAGE_LABEL[stage].toLowerCase()} for this.
          </div>
        </div>
      );
    }
    const full = item.output_file !== null ? outputs[item.output_file] : undefined;
    // The tail is the whole output when nothing was left out of it.
    const cut = item.output_size > new TextEncoder().encode(item.output_tail).length + 1;
    const short = !cut && item.output_tail.split("\n").length <= SHORT_OUTPUT_LINES;
    const showOutput = short || opened[item.id] === true;
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {STAGE_LABEL[item.stage] !== "" && <Badge variant={item.stage === "after" ? "ok" : "warn"}>{STAGE_LABEL[item.stage]}</Badge>}
          <span className="min-w-0">{item.caption}</span>
        </div>

        {item.file !== null && (
          <button
            type="button"
            className="block border bg-muted/40 hover:border-primary"
            title="Open full size (← / → to flip through)"
            onClick={() => setViewing(images.findIndex((each) => each.id === item.id))}
          >
            <img src={`/api/evidence/${item.file}`} alt={item.caption} loading="lazy" className="mx-auto block max-h-96 max-w-full object-contain" />
          </button>
        )}

        {item.kind === "command" && (
          <div className="min-w-0 border font-mono text-xs">
            <div className="flex items-center gap-2 bg-muted/40 px-2 py-1">
              <SquareTerminal className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={item.command ?? ""}>
                $ {item.command}
              </span>
              <Badge variant={item.exit_code === 0 ? "ok" : "bad"}>
                exit {item.exit_code}
              </Badge>
            </div>
            {showOutput && (
              <pre className="max-h-96 overflow-auto border-t px-2 py-1.5 leading-5 whitespace-pre-wrap break-all">
                {full !== undefined && full !== "" ? full : item.output_tail || "(no output)"}
              </pre>
            )}
            {!showOutput && (
              <button
                type="button"
                className="w-full border-t px-2 py-1 text-left text-muted-foreground hover:bg-accent"
                onClick={() => setOpened((current) => ({ ...current, [item.id]: true }))}
              >
                Show output
              </button>
            )}
            {showOutput && cut && item.output_file !== null && full === undefined && (
              <button
                type="button"
                className="w-full border-t px-2 py-1 text-left text-muted-foreground hover:bg-accent"
                onClick={() => loadOutput(item.output_file!)}
              >
                Full output ({Math.ceil(item.output_size / 1000)} KB)
              </button>
            )}
            {full === "" && (
              <div className="flex items-center gap-1.5 border-t px-2 py-1 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-3">
      {(overview.project || draft.kind === "pr") && (
        <div className="flex items-baseline gap-3 text-muted-foreground">
          <span className="min-w-0 flex-1">{overview.project}</span>
          {draft.kind === "pr" && (
            <span className="shrink-0 font-mono text-xs tabular-nums">
              {props.files} {props.files === 1 ? "file" : "files"} <span className="text-ok">+{props.added}</span>{" "}
              <span className="text-destructive">−{props.removed}</span>
            </span>
          )}
        </div>
      )}

      {(draft.kind === "question" || draft.kind === "taken") && <Markdown text={draft.body || "*No text.*"} repo={draft.repo ?? undefined} githubImagesOnly />}

      {rows.length > 0 && (
        <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <span className="font-medium">{row.label}</span>
              <span className="max-w-3xl">{row.text}</span>
            </div>
          ))}
          {risks.length > 0 && (
            <>
              <span className="font-medium">What could go wrong</span>
              <ul className="max-w-3xl list-disc space-y-1 pl-4">
                {risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </>
          )}
          {checklist.length > 0 && (
            <>
              <span className="font-medium">Checklist</span>
              <ul className="max-w-3xl space-y-1.5">
                {checklist.map((point, index) => (
                  <li key={index} className="flex items-baseline gap-2">
                    <Badge variant={point.done ? "ok" : "warn"} className="shrink-0">
                      {point.done ? "Done" : "Not done"}
                    </Badge>
                    <span className="min-w-0">
                      {point.item}
                      <span className="block text-xs text-muted-foreground">{point.how}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {alsoTested.length > 0 && (
            <>
              <span className="font-medium">Also tested</span>
              <ul className="max-w-3xl list-disc space-y-1 pl-4">
                {alsoTested.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {draft.kind === "report" && part === "overview" && (
        <>
          <div className="text-muted-foreground">{overview.paper}</div>
          <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2.5">
            <span className="font-medium">Claims</span>
            <span className="max-w-3xl">{overview.claims}</span>
            <span className="font-medium">Outcome</span>
            <span className="max-w-3xl">{overview.verdict}</span>
            {unchecked.length > 0 && (
              <>
                <span className="font-medium">Couldn't check</span>
                <ul className="max-w-3xl list-disc space-y-1 pl-4">
                  {unchecked.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="space-y-2 pt-1">
            <h3 className="text-[15px] font-semibold">Full report</h3>
            <Markdown text={draft.body || "*No text.*"} githubImagesOnly />
          </div>
        </>
      )}

      {draft.kind === "report" && part === "results" && (
        <>
          {results.length === 0 && <div className="text-muted-foreground">The report has no numbers to compare.</div>}
          {results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1 pr-3 font-medium">What</th>
                    <th className="py-1 pr-3 font-medium">Paper</th>
                    <th className="py-1 pr-3 font-medium">Ours</th>
                    <th className="py-1 pr-3 font-medium">Authors' code</th>
                    <th className="py-1 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, index) => (
                    <tr key={index} className="border-b align-top">
                      <td className="py-1.5 pr-3">{row.what}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs tabular-nums">{row.paper}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs tabular-nums">{row.ours}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs tabular-nums">{row.authors || "–"}</td>
                      <td className="py-1.5 text-muted-foreground">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {runs.length > 0 && (
            <div className="space-y-5 pt-1">
              <h3 className="text-[15px] font-semibold">Runs</h3>
              {runs.map((item) => (
                <section key={item.id} className="space-y-2">
                  <div className="border-b pb-1 font-semibold">{item.topic}</div>
                  {item.context && <p className="max-w-3xl">{item.context}</p>}
                  {renderItem(item, "other")}
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {draft.kind === "report" && part === "problems" && (
        <>
          {problems.length === 0 && <div className="text-muted-foreground">The agent found no problems.</div>}
          {problems.map((problem, index) => {
            const item = draft.evidence.find((each) => each.id === problem.evidence);
            return (
              <section key={index} className="space-y-2">
                <div className="border-b pb-1 text-[15px] font-semibold">{problem.title}</div>
                <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2.5">
                  <span className="font-medium">What</span>
                  <span className="max-w-3xl">{problem.what}</span>
                  <span className="font-medium">Why it matters</span>
                  <span className="max-w-3xl">{problem.why}</span>
                </div>
                {item !== undefined && item.context && <p className="max-w-3xl text-muted-foreground">{item.context}</p>}
                {item !== undefined && renderItem(item, "other")}
              </section>
            );
          })}
        </>
      )}

      {rows.length === 0 && draft.kind !== "question" && draft.kind !== "taken" && draft.kind !== "report" && (
        <div className="text-muted-foreground">This draft was made before overviews existed. Its text is in the last tab.</div>
      )}

      {topics.length > 0 && draft.kind !== "report" && (
        <div className="space-y-5 pt-1">
          <h3 className="text-[15px] font-semibold">Before and after</h3>
          {topics.map((topic) => (
            <section key={topic.name} className="space-y-2">
              <div className="border-b pb-1 font-semibold">{topic.name}</div>
              {topic.context !== "" && <p className="max-w-3xl">{topic.context}</p>}
              {(topic.before !== null || topic.after !== null) && (
                <div className="grid grid-cols-2 gap-3">
                  {renderItem(topic.before, "before")}
                  {renderItem(topic.after, "after")}
                </div>
              )}
              {topic.others.map((item) => (
                <div key={item.id}>{renderItem(item, "other")}</div>
              ))}
            </section>
          ))}
        </div>
      )}
      {topics.length === 0 && draft.kind === "pr" && <div className="text-muted-foreground">The agent added no before and after to this draft.</div>}

      <Dialog open={shown !== undefined} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent
          className="flex h-[95vh] w-[95vw] max-w-[95vw] flex-col gap-2 p-3 sm:max-w-[95vw]"
          onKeyDown={(event) => {
            if (viewing === null) {
              return;
            }
            if (event.key === "ArrowRight") {
              event.preventDefault();
              setViewing(Math.min(viewing + 1, images.length - 1));
            }
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setViewing(Math.max(viewing - 1, 0));
            }
          }}
        >
          {shown !== undefined && viewing !== null && (
            <>
              <div className="flex items-center gap-2 pr-8">
                <DialogTitle className="text-sm">
                  {shown.topic}
                  {STAGE_LABEL[shown.stage] !== "" && (
                    <Badge variant={shown.stage === "after" ? "ok" : "warn"} className="ml-2">
                      {STAGE_LABEL[shown.stage]}
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="min-w-0 flex-1 truncate">{shown.caption}</DialogDescription>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {viewing + 1} / {images.length}
                </span>
                <Button variant="ghost" size="sm" disabled={viewing === 0} onClick={() => setViewing(viewing - 1)}>
                  <ChevronLeft />
                </Button>
                <Button variant="ghost" size="sm" disabled={viewing === images.length - 1} onClick={() => setViewing(viewing + 1)}>
                  <ChevronRight />
                </Button>
              </div>
              {/* Fills the window, so a small crop is easy to read and a before and its after line up when flipping. */}
              <img src={`/api/evidence/${shown.file}`} alt={shown.caption} className="min-h-0 w-full flex-1 object-contain" />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
