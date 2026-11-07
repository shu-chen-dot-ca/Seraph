/*
Add repository, on the Workflow tab (WorkflowNav.tsx, and the empty Workflow page): a GitHub link to one of your own
repositories (one you can push to), where its pull requests and issues are (In Seraph: kept in the app, nothing an agent
writes goes to GitHub; On GitHub: there, as you) and who approves and merges (You, or the Review agent). Add makes a VM
for it and its agents (backend/workflow_api.py), then opens its page. Enter in the link adds it.
*/

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type WorkflowRepo } from "@/live";

export default function AddRepositoryDialog(props: { open: boolean; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [prsOn, setPrsOn] = useState("seraph");
  const [decides, setDecides] = useState("you");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      const record = await api<WorkflowRepo>("/api/workflow", { method: "POST", body: { url: url, prs_on: prsOn, decides: decides } });
      toast.success(`Added ${record.repo}: its VM is being made, then its agents start.`);
      setUrl("");
      props.onClose();
      window.location.hash = `#/workflow?repo=${encodeURIComponent(record.repo)}`;
    } catch (err) {
      toast.error(`Could not add it: ${err instanceof Error ? err.message : err}`);
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>One of your own repositories. A new VM is made for it, with a chat agent, two workers and a review agent.</DialogDescription>
        </DialogHeader>
        <Input
          placeholder="https://github.com/owner/name"
          value={url}
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && url.trim() !== "" && !busy) {
              add();
            }
          }}
        />
        <div className="space-y-1.5">
          <div className="font-medium">Pull requests and issues</div>
          <Tabs value={prsOn} onValueChange={setPrsOn}>
            <TabsList>
              <TabsTrigger value="seraph" className="px-2.5">
                In Seraph
              </TabsTrigger>
              <TabsTrigger value="github" className="px-2.5">
                On GitHub
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {prsOn === "seraph"
              ? "Kept here: nothing the agents write goes to GitHub. Merging puts the change on the default branch as one commit, as you."
              : "On GitHub, as you: pull requests open there, and the review is a comment on each."}
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="font-medium">Approve and merge</div>
          <Tabs value={decides} onValueChange={setDecides}>
            <TabsList>
              <TabsTrigger value="you" className="px-2.5">
                You
              </TabsTrigger>
              <TabsTrigger value="agent" className="px-2.5">
                Review agent
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {decides === "you"
              ? "You merge or reject each pull request, with the review agent's advice in front of you."
              : "The review agent merges or rejects each pull request by its own review. You can change this any time."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={url.trim() === "" || busy} onClick={add}>
            {busy && <Loader2 className="animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
