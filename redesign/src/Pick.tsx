import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/*
Your answer on one part of a proposal: one of its options (Keep / Change / Drop, A / B / C …) and a note. Saved to
redesign/picks.json through vite (vite.config.ts) as soon as you click an option or leave the note, so the next
round starts from it. With no options it is only a note.
*/

export default function Pick(props: { id: string; options?: string[] }) {
  const options = props.options ?? [];
  const [choice, setChoice] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(options.length === 0);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch("/api/picks")
      .then((response) => response.json())
      .then((all) => {
        const pick = all[props.id];
        if (pick) {
          setChoice(pick.choice ?? "");
          setNote(pick.note ?? "");
          if (pick.note) {
            setNoteOpen(true);
          }
        }
      })
      .catch(() => setSaved("Can't read saved picks"));
  }, [props.id]);

  function save(nextChoice: string, nextNote: string) {
    fetch("/api/picks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: props.id, choice: nextChoice, note: nextNote }),
    })
      .then((response) => setSaved(response.ok ? "Saved" : "Not saved"))
      .catch(() => setSaved("Not saved"));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {options.length > 0 && (
        <div className="inline-flex overflow-hidden rounded-md border border-input">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                const next = choice === option ? "" : option;
                setChoice(next);
                save(next, note);
              }}
              className={cn(
                "border-l border-input px-3 py-1 text-[13px] font-medium text-muted-foreground first:border-l-0 hover:bg-accent hover:text-foreground",
                choice === option && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {!noteOpen && (
        <button type="button" className="text-[13px] text-muted-foreground underline decoration-input underline-offset-4 hover:text-foreground" onClick={() => setNoteOpen(true)}>
          Add note
        </button>
      )}
      {saved && <span className="text-xs text-muted-foreground">{saved}</span>}
      {noteOpen && (
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => save(choice, note)}
          placeholder={options.length > 0 ? "What would you change?" : "Write here…"}
          className="min-h-16 basis-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-[13px] outline-none focus-visible:border-ring"
        />
      )}
    </div>
  );
}
