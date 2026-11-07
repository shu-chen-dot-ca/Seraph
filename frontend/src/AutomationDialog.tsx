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
own Automation decides on it), Queue issues (the repo's issues that fit go to the Issues board's Catalog: their tags
are refreshed and they pass the filter, the issue levels and the instructions), Take issues (agents take the repo's
issues from Catalog, from the top, as many at once as the board's Max agents), Questions (their questions to you are answered for them with their
recommendation, unless one must wait for you), Comments (posted on GitHub), Pull requests (sent once their review
passed, with new titles and descriptions; agents may also update your open pull requests' branches there) and Open
issues (agents open new issues there, assigned to you, where the project's rules allow it; each goes to the end of
Catalog). Under it Issue level (Easy, Medium, Hard; Easy only at first): which issues may be taken. How many agents work at
once is the Issues board's (BoardAutomationDialog.tsx), not a repo's.
Right, Instructions: optional, added on top of the default instructions, e.g. which issues to take or skip even when
their level is picked. The default instructions always skip issues that are political or politically sensitive,
against another country's laws, unethical or NSFW.
Save checks the number (a whole number, at least 1) and keeps it all; Cancel, Esc or the X drop the changes.
*/

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  levels: string[]; // "easy", "medium", "hard"
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
  levels: ["easy"],
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
        setLevels(start.levels);
        setInstructions(start.instructions);
        setLoaded(true);
      })
      .catch((err) => setError(`Could not read them: ${err instanceof Error ? err.message : err}`));
  }, [reposKey]);

  function toggleLevel(level: string) {
    if (levels.includes(level)) {
      setLevels(levels.filter((each) => each !== level));
    } else {
      setLevels([...levels, level]);
    }
  }

  async function save() {
    const next: Automation = {
      add_issues: addIssues,
      queue_issues: queueIssues,
      take_issues: takeIssues,
      questions: questions,
      comments: comments,
      pull_requests: pullRequests,
      open_issues: openIssues,
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

            <div>
              <div className={heading}>Issue level</div>
              <div className="flex gap-1">
                {Object.keys(LEVELS).map((level) => (
                  <button
                    key={level}
                    type="button"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                    onClick={() => toggleLevel(level)}
                  >
                    <SelectBox checked={levels.includes(level)} />
                    {LEVELS[level]}
                  </button>
                ))}
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
