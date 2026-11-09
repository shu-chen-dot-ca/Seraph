/*
Automation for one repo, titled with the repo's name, opened by the robot button on its card on the Dashboard's
Repository page (RepositoryCards.tsx), and by a click on an issue card's logo on the Issues board (IssueBoard.tsx). The
Repository page's top bar robot opens it for all the picked repos at once, titled "3 repositories": it starts from the
first one's settings and Save gives them all the same ones. Its
Questions, Comments and Pull requests are the default for each of the repo's issues on the board; an issue's own robot
changes them for that issue (IssueAutomationDialog.tsx). Add issues, Queue issues, Take issues and Open issues are the
repo's only.
Kept by the backend (backend/repo_automation_api.py, GET and PUT /api/repos/automation). Settings from before, kept in
this browser, are what it opens on for a repo the backend has none for; Save moves them to the backend.

Left, Level of automation, what agents do there without asking you, as you (the backend acts on it:
backend/repo_automation_api.py): Add issues (the repo's open issues on GitHub whose level is picked below go into the
Issues board's Open, each once: one you take off isn't added again; the board reads each again as it comes in, and its
own Automation decides on it), Queue issues (right after they are tagged, the repo's issues on Open that pass the
filter, the issue levels and the instructions go to the Issues board's Catalog, and the rest leave the board; so do
claimed ones, from Catalog too), Take issues (agents take the repo's
issues from Catalog, from the top, as many at once as the board's Max agents), Questions (their questions to you are answered for them with their
recommendation, unless one must wait for you), Comments (posted on GitHub), Pull requests (sent once their review
passed, with new titles and descriptions; agents may also update your open pull requests' branches there) and Open
issues (agents open new issues there, claimed for you, where the project's rules allow it; each goes to the top of
Catalog, before every other card). Under it two columns: Until one is merged (on the left) and Once one is merged (on the right, once you are a
contributor there). Each has the issue levels (Easy, Medium, Hard): which issues may be taken, Easy only on the left
and all three on the right at first; and Open PRs at once: how many of your pull requests may be open there at the same
time, 1 on the left and 5 on the right at first. Agents take no more of its Catalog cards while its open pull requests and its issues
being worked on reach it, and a new pull request over it waits in Review until one is merged or closed (you can still
send it by hand: Approve in the Inbox, or Publish on the Pull requests page). How many agents work at
once is the Issues board's (BoardAutomationDialog.tsx), not a repo's.
Right, Instructions: optional, added on top of the default instructions, e.g. which issues to take or skip even when
their level is picked. The default instructions always skip issues that are political or politically sensitive,
against another country's laws, unethical or NSFW.
Save checks the numbers (whole numbers, 1 to 50) and keeps it all; Cancel, Esc or the X drop the changes.
*/

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectBox } from "@/components/ui/row-selection";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/live";

export type Automation = {
  add_issues?: boolean; // missing on settings from before it
  queue_issues?: boolean; // missing on settings from before it: Take issues said then
  take_issues: boolean;
  questions: boolean;
  comments: boolean;
  pull_requests: boolean;
  open_issues?: boolean; // missing on settings from before it
  max_prs_first?: number; // open PRs at once until one is merged there; missing on settings from before it (1)
  max_prs?: number; // and after (5)
  levels_first?: string[]; // which issues may be taken until one of yours there is merged; missing before it (Easy)
  levels: string[]; // and once one is: "easy", "medium", "hard"
  instructions: string;
};

const DEFAULTS: Automation = {
  add_issues: false,
  queue_issues: false,
  take_issues: false,
  questions: false,
  comments: false,
  pull_requests: false,
  open_issues: false,
  max_prs_first: 1,
  max_prs: 5,
  levels_first: ["easy"],
  levels: ["easy", "medium", "hard"],
  instructions: "",
};

const LEVELS: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export default function AutomationDialog(props: { repos: string[]; onClose: () => void }) {
  const title = props.repos.length === 1 ? props.repos[0] : `${props.repos.length} repositories`;
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addIssues, setAddIssues] = useState(false);
  const [queueIssues, setQueueIssues] = useState(false);
  const [takeIssues, setTakeIssues] = useState(DEFAULTS.take_issues);
  const [questions, setQuestions] = useState(DEFAULTS.questions);
  const [comments, setComments] = useState(DEFAULTS.comments);
  const [pullRequests, setPullRequests] = useState(DEFAULTS.pull_requests);
  const [openIssues, setOpenIssues] = useState(false);
  // As typed (digits only); Save checks them.
  const [maxFirst, setMaxFirst] = useState("1");
  const [maxAfter, setMaxAfter] = useState("5");
  const [levelsFirst, setLevelsFirst] = useState(["easy"]);
  const [levels, setLevels] = useState(DEFAULTS.levels);
  const [instructions, setInstructions] = useState(DEFAULTS.instructions);
  const [error, setError] = useState("");

  // The first repo's settings: the backend's, else ones from before in this browser, else the defaults. Read again only
  // when the repos change by name: a parent re-rendering hands in a new list of the same repos, which mustn't undo edits.
  const reposKey = props.repos.join(" ");
  useEffect(() => {
    api<{ repos: Record<string, Automation> }>("/api/repos/automation")
      .then((data) => {
        let start = data.repos[props.repos[0]];
        if (start === undefined) {
          try {
            start = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(`automation:${props.repos[0]}`) ?? "{}") };
          } catch {
            start = DEFAULTS;
          }
        }
        setAddIssues(start.add_issues === true);
        setQueueIssues(start.queue_issues ?? start.take_issues);
        setTakeIssues(start.take_issues);
        setQuestions(start.questions);
        setComments(start.comments);
        setPullRequests(start.pull_requests);
        setOpenIssues(start.open_issues === true);
        setMaxFirst(String(start.max_prs_first ?? 1));
        setMaxAfter(String(start.max_prs ?? 5));
        setLevelsFirst(start.levels_first ?? ["easy"]);
        setLevels(start.levels);
        setInstructions(start.instructions);
        setLoaded(true);
      })
      .catch((err) => setError(`Could not read them: ${err instanceof Error ? err.message : err}`));
  }, [reposKey]);

  function toggleFirst(level: string) {
    if (levelsFirst.includes(level)) {
      setLevelsFirst(levelsFirst.filter((each) => each !== level));
    } else {
      setLevelsFirst([...levelsFirst, level]);
    }
  }

  function toggleLevel(level: string) {
    if (levels.includes(level)) {
      setLevels(levels.filter((each) => each !== level));
    } else {
      setLevels([...levels, level]);
    }
  }

  async function save() {
    for (const value of [maxFirst, maxAfter]) {
      if (value === "" || Number(value) < 1 || Number(value) > 50) {
        setError("Open PRs at once is 1 to 50.");
        return;
      }
    }
    const next: Automation = {
      add_issues: addIssues,
      queue_issues: queueIssues,
      take_issues: takeIssues,
      questions: questions,
      comments: comments,
      pull_requests: pullRequests,
      open_issues: openIssues,
      max_prs_first: Number(maxFirst),
      max_prs: Number(maxAfter),
      levels_first: levelsFirst,
      levels: levels,
      instructions: instructions.trim(),
    };
    setBusy(true);
    setError("");
    try {
      await api("/api/repos/automation", { method: "PUT", body: { repos: props.repos, ...next } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    // The backend has them now: the ones from before in this browser are done.
    try {
      for (const repo of props.repos) {
        localStorage.removeItem(`automation:${repo}`);
      }
    } catch {
      // Storage blocked: nothing was kept.
    }
    toast.success(`Saved ${title}`);
    props.onClose();
  }

  const heading = "px-2 pb-1 text-xs font-medium text-muted-foreground";
  const option = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent";

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div>
              <div className={heading}>Level of automation</div>
              <button type="button" className={option} onClick={() => setAddIssues(!addIssues)}>
                <SelectBox checked={addIssues} />
                Add issues
              </button>
              <button type="button" className={option} onClick={() => setQueueIssues(!queueIssues)}>
                <SelectBox checked={queueIssues} />
                Queue issues
              </button>
              <button type="button" className={option} onClick={() => setTakeIssues(!takeIssues)}>
                <SelectBox checked={takeIssues} />
                Take issues
              </button>
              <button type="button" className={option} onClick={() => setQuestions(!questions)}>
                <SelectBox checked={questions} />
                Questions
              </button>
              <button type="button" className={option} onClick={() => setComments(!comments)}>
                <SelectBox checked={comments} />
                Comments
              </button>
              <button type="button" className={option} onClick={() => setPullRequests(!pullRequests)}>
                <SelectBox checked={pullRequests} />
                Pull requests
              </button>
              <button type="button" className={option} onClick={() => setOpenIssues(!openIssues)}>
                <SelectBox checked={openIssues} />
                Open issues
              </button>
            </div>

            {/* Left until one of your pull requests there is merged, right once you are a contributor there. */}
            <div className="grid grid-cols-2 gap-x-2">
              <div>
                <div className={heading}>Until one is merged</div>
                {Object.keys(LEVELS).map((level) => (
                  <button key={level} type="button" className={option} onClick={() => toggleFirst(level)}>
                    <SelectBox checked={levelsFirst.includes(level)} />
                    {LEVELS[level]}
                  </button>
                ))}
                <label className="flex items-center justify-between gap-2 px-2 py-1">
                  Open PRs at once
                  <Input className="h-7 w-14" inputMode="numeric" value={maxFirst} onChange={(event) => setMaxFirst(event.target.value.replace(/\D/g, ""))} />
                </label>
              </div>
              <div>
                <div className={heading}>Once one is merged</div>
                {Object.keys(LEVELS).map((level) => (
                  <button key={level} type="button" className={option} onClick={() => toggleLevel(level)}>
                    <SelectBox checked={levels.includes(level)} />
                    {LEVELS[level]}
                  </button>
                ))}
                <label className="flex items-center justify-between gap-2 px-2 py-1">
                  Open PRs at once
                  <Input className="h-7 w-14" inputMode="numeric" value={maxAfter} onChange={(event) => setMaxAfter(event.target.value.replace(/\D/g, ""))} />
                </label>
              </div>
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Instructions</span>
            <Textarea
              className="min-h-40 flex-1"
              placeholder="e.g. which issues to take or skip"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
        </div>

        {error !== "" && <p className="text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!loaded || busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
