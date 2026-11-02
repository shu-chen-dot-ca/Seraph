/*
The Tag pop-up, for the picked repos on the Repos and Tracked pages. Tags group repos for the user, nothing more: a
repo has one at most, and each page shows each tag's repos on top under a header that folds them, No tag at the bottom.
Each page has its own tags (url: its own list).

It lists the tags in use, A to Z, then No tag, always last; a click picks one. It opens with the picked repos' tag
picked when they all have the same one. The New tag box's Create adds a tag to the list and picks it. Apply puts the
picked repos under the picked tag, or with No tag takes them out of theirs, as one undo step.

The bin next to a tag deletes it: its repos go to No tag, as one undo step. It asks first, unless no repo has it yet
(one only created here just leaves the list). Tags are only what the repos carry, so one nobody uses any more is gone.
*/

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type RepoItem } from "@/live";
import { cn } from "@/lib/utils";

export default function TagDialog(props: {
  items: RepoItem[]; // the page's whole list, each repo with its tag
  names: string[]; // the picked repos
  url: string; // "/api/repos/tag" or "/api/tracked/tag": takes {names, tag}, tag "" for No tag
  onClose: () => void;
  onTagged: (tag: string) => void; // after Apply, with the tag ("" for No tag)
  onDeleted: (tag: string) => void;
}) {
  // The picked repos' tags ("" for No tag): the one picked at first when they all have the same.
  const pickedTags: string[] = [];
  for (const item of props.items) {
    if (props.names.includes(item.full_name) && !pickedTags.includes(item.tag ?? "")) {
      pickedTags.push(item.tag ?? "");
    }
  }
  // The tag picked ("" for No tag, null for none).
  const [pickedTag, setPickedTag] = useState<string | null>(pickedTags.length === 1 ? pickedTags[0] : null);
  const [newTag, setNewTag] = useState("");
  // Tags created here that no repo has yet.
  const [madeTags, setMadeTags] = useState<string[]>([]);
  // The tag whose Delete waits for its confirm.
  const [deletingTag, setDeletingTag] = useState<string | null>(null);

  // The tags in use, and the ones created here, A to Z.
  const tagNames: string[] = [];
  for (const item of props.items) {
    if ((item.tag ?? "") !== "" && !tagNames.includes(item.tag!)) {
      tagNames.push(item.tag!);
    }
  }
  const listed = [...tagNames, ...madeTags.filter((each) => !tagNames.includes(each))].sort((a, b) => a.localeCompare(b));

  // The New tag box: the tag joins the list and is picked. Apply puts the repos under it.
  function createTag() {
    const name = newTag.trim();
    if (name === "") {
      return;
    }
    if (!madeTags.includes(name)) {
      setMadeTags([...madeTags, name]);
    }
    setPickedTag(name);
    setNewTag("");
  }

  async function apply() {
    if (pickedTag === null) {
      return;
    }
    try {
      await api(props.url, { method: "POST", body: { names: props.names, tag: pickedTag } });
      props.onTagged(pickedTag);
    } catch (err) {
      toast.error(`Could not tag: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Delete a tag: its repos go to No tag, as one undo step. One only created here just leaves the list.
  async function deleteTag(tag: string) {
    const names = props.items.filter((item) => item.tag === tag).map((item) => item.full_name);
    setMadeTags(madeTags.filter((each) => each !== tag));
    if (pickedTag === tag) {
      setPickedTag(null);
    }
    props.onDeleted(tag);
    if (names.length === 0) {
      return;
    }
    try {
      await api(props.url, { method: "POST", body: { names, tag: "" } });
    } catch (err) {
      toast.error(`Could not delete the tag: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && props.onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Tag {props.names.length} {props.names.length === 1 ? "repo" : "repos"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex max-h-64 flex-col overflow-auto">
            {[...listed, ""].map((tag) => (
              <div key={tag} className={cn("flex h-7 shrink-0 items-center rounded-sm hover:bg-accent", pickedTag === tag && "bg-selected hover:bg-selected")}>
                <button type="button" className="flex h-full min-w-0 flex-1 items-center px-2 text-left" onClick={() => setPickedTag(tag)}>
                  <span className="truncate">{tag === "" ? "No tag" : tag}</span>
                </button>
                {/* A tag in use asks first; one only created here just goes. */}
                {tag !== "" && (
                  <button
                    type="button"
                    className="mr-1 shrink-0 rounded-sm p-1 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete tag ${tag}`}
                    title="Delete tag"
                    onClick={() => (tagNames.includes(tag) ? setDeletingTag(tag) : deleteTag(tag))}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              createTag();
            }}
          >
            <Input className="h-7" placeholder="New tag" value={newTag} onChange={(event) => setNewTag(event.target.value)} />
            <Button type="submit" variant="outline" disabled={newTag.trim() === ""}>
              Create
            </Button>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button disabled={pickedTag === null || props.names.length === 0} onClick={apply}>
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deletingTag !== null} onOpenChange={(open) => !open && setDeletingTag(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tag {deletingTag}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its repos ({props.items.filter((item) => item.tag === deletingTag).length}) move to No tag; they stay in the list. Undo brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deletingTag !== null && deleteTag(deletingTag)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
