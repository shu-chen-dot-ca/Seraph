import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

/*
The one pop-up every flow uses: a title, what it is about, and its buttons. Enter confirms (not inside a text box,
where Enter is a new line), Escape or a click beside it cancels. Without `confirm` it only has Close, for pop-ups
where you pick from a list. It covers the mock app only (MockApp's root holds it in), so it shows inside Phone too.
*/

export default function Dialog(props: {
  title: string;
  children: ReactNode;
  confirm?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}) {
  const { confirm, disabled, onConfirm, onClose } = props;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
      if (event.key === "Enter" && confirm && onConfirm && !disabled && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        onConfirm();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, disabled, onConfirm, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-md flex-col rounded-xl border bg-popover shadow-overlay" onClick={(event) => event.stopPropagation()}>
        <h2 className="px-4 pt-4 text-sm font-semibold">{props.title}</h2>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto px-4 pt-2 pb-1">{props.children}</div>
        <div className="flex justify-end gap-2 px-4 pt-3 pb-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            {confirm ? "Cancel" : "Close"}
          </Button>
          {confirm && onConfirm && (
            <Button size="sm" variant={props.danger ? "destructive" : "default"} disabled={disabled} onClick={onConfirm}>
              {confirm}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
