/*
Automation for one repo, titled with the repo's name, opened by the robot button on its card on the Dashboard's
Repository page (RepositoryCards.tsx), and by a click on an issue card's logo on the Issues board (IssueBoard.tsx). The
Repository page's top bar robot opens it for all the picked repos at once, titled "3 repositories": it starts from the
first one's settings and Save gives them all the same ones. Its
Questions, Comments and Pull requests are the default for each of the repo's issues on the board; an issue's own robot
changes them for that issue (IssueAutomationDialog.tsx). Take issues is the repo's only.
Kept by the backend (backend/repo_automation_api.py, GET and PUT /api/repos/automation). Settings from before, kept in
this browser, are what it opens on for a repo the backend has none for; Save moves them to the backend.

Left, Level of automation, what agents do there without asking you: Take issues (an agent picks which of the repo's
issues go to the Issues board's Catalog, by the issue levels and the instructions: the one part that acts so far), Questions (their questions to you are answered for them), Comments (posted on GitHub) and Pull requests
(sent). Under it Issue level (Easy, Medium, Hard; Easy only at first): which issues may be taken. How many agents work at
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
  take_issues: boolean;
  questions: boolean;
  comments: boolean;
  pull_requests: boolean;
  levels: string[]; // "easy", "medium", "hard"
  instructions: string;
};

const DEFAULTS: Automation = {
  take_issues: false,
  questions: false,
  comments: false,
  pull_requests: false,
  levels: ["easy"],
  instructions: "",
};

const LEVELS: Record<string, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export default function AutomationDialog(props: { repos: string[]; onClose: () => void }) {
  const title = props.repos.length === 1 ? props.repos[0] : `${props.repos.length} repositories`;
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [takeIssues, setTakeIssues] = useState(DEFAULTS.take_issues);
  const [questions, setQuestions] = useState(DEFAULTS.questions);
  const [comments, setComments] = useState(DEFAULTS.comments);
  const [pullRequests, setPullRequests] = useState(DEFAULTS.pull_requests);
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
        setTakeIssues(start.take_issues);
        setQuestions(start.questions);
        setComments(start.comments);
        setPullRequests(start.pull_requests);
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
      take_issues: takeIssues,
      questions: questions,
      comments: comments,
      pull_requests: pullRequests,
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
