import { Check, X } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Picking many rows of a list at once, the way mail apps and file managers do it, so lists need no check-box column:
//
//   click            opens the row, as before
//   Ctrl/Cmd-click   picks or unpicks one row                    (the page's own row click)
//   Shift-click      picks every row from the last one picked    (the page's own row click)
//   drag             a rectangle picks every row it touches; with Ctrl or Shift held they add to what was picked
//   Ctrl+A           picks every row shown
//   Escape           unpicks all, and so does a click on the list's empty space
//
// Picked rows are tinted, and a bar floats at the bottom of the page: how many, Select all, the page's bulk actions
// (if it passes them; a page may keep them in its own top bar instead) and an x to clear. A page may also have a Select button (select mode, like a chat app's): then every row shows a
// SelectBox and a plain click picks the row. The page keeps the selection (a list of ids), its row clicks and its
// select mode; this adds the rest:
//
//   <div className="relative ...">                                              the page
//     <div ref={listRef} className="... overflow-auto">                         the list that scrolls
//       <div data-select-id={id} onClick={...}>...</div>                        each row that can be picked
//     </div>
//     <RowSelection listRef={listRef} ids={rowIds} selected={chosen} onSelect={setSelected}>
//       <Button ...>Remove</Button>                                             the bulk actions
//     </RowSelection>
//   </div>
//
// The rectangle starts on a row (not on its buttons or links; a row that is itself a link is fine) or on the list's empty space, and only once the mouse
// moved a few pixels, so a plain click stays a click. After a drag, the click it would make is swallowed, so no row
// opens. Dragged against the list's top or bottom edge, the list scrolls by itself so the rectangle reaches rows off
// screen; rows a virtualized list stops drawing keep what they had.

// The box a row shows in select mode, checked when the row is picked. Only a picture: the row's own click picks it.
export function SelectBox(props: { checked: boolean }) {
  return (
    <span
      role="checkbox"
      aria-checked={props.checked}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-background",
        props.checked && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {props.checked && <Check className="size-3.5" />}
    </span>
  )
}

// How far the mouse moves before a press becomes a drag, and the band at the list's top and bottom that scrolls it.
const DRAG_PX = 5
const EDGE_PX = 28

type Box = { left: number; top: number; width: number; height: number }

export function RowSelection(props: {
  listRef: React.RefObject<HTMLElement | null>
  ids: string[]
  selected: string[]
  onSelect: (ids: string[]) => void
  children?: React.ReactNode
}) {
  const [box, setBox] = useState<Box | null>(null)
  const { listRef, ids, selected, onSelect } = props

  // Re-registered every render, so a press or a key starts from the rows and the selection as they are now.
  useEffect(() => {
    const list = listRef.current
    if (list === null) {
      return
    }

    function onMouseDown(event: MouseEvent) {
      if (event.button !== 0 || list === null) {
        return
      }
      const target = event.target as HTMLElement
      const row = target.closest<HTMLElement>("[data-select-id]")
      const onEmpty = target === list
      if (row === null && !onEmpty) {
        return
      }
      // Buttons, links and fields in a row keep their own press. The row itself may be a link (the Inbox's).
      const control = target.closest("button, a, input, textarea, select, label, [contenteditable]")
      if (control !== null && control !== row) {
        return
      }
      let listBox = list.getBoundingClientRect()
      // A press on the list's scrollbar scrolls it.
      if (onEmpty && (event.clientX - listBox.left - list.clientLeft >= list.clientWidth || event.clientY - listBox.top - list.clientTop >= list.clientHeight)) {
        return
      }
      // No text gets selected while dragging, or by a shift-click.
      event.preventDefault()

      const base = event.ctrlKey || event.metaKey || event.shiftKey ? selected : []
      const startX = event.clientX - listBox.left + list.scrollLeft
      const startY = event.clientY - listBox.top + list.scrollTop
      let mouseX = event.clientX
      let mouseY = event.clientY
      let dragging = false
      let lastIds = selected.join("\n")
      // Every row the rectangle touched or left, by id. Rows no longer drawn keep their last answer.
      const touched: Record<string, boolean> = {}

      // Which rows the rectangle touches now, and where it is on screen. Worked out in the list's scrolled
      // content, so the corner where the drag began stays put while the list scrolls.
      function update() {
        if (list === null) {
          return
        }
        listBox = list.getBoundingClientRect()
        const x = mouseX - listBox.left + list.scrollLeft
        const y = mouseY - listBox.top + list.scrollTop
        const left = Math.min(startX, x)
        const right = Math.max(startX, x)
        const top = Math.min(startY, y)
        const bottom = Math.max(startY, y)
        for (const each of list.querySelectorAll<HTMLElement>("[data-select-id]")) {
          const rowBox = each.getBoundingClientRect()
          const rowLeft = rowBox.left - listBox.left + list.scrollLeft
          const rowTop = rowBox.top - listBox.top + list.scrollTop
          touched[each.dataset.selectId ?? ""] = rowTop < bottom && rowTop + rowBox.height > top && rowLeft < right && rowLeft + rowBox.width > left
        }
        const picked = [...base]
        for (const [id, on] of Object.entries(touched)) {
          if (on && id !== "" && !picked.includes(id)) {
            picked.push(id)
          }
        }
        // The page redraws only when the selection really changed.
        if (picked.join("\n") !== lastIds) {
          lastIds = picked.join("\n")
          onSelect(picked)
        }
        // On screen, cut to what the list shows.
        const screenLeft = Math.max(listBox.left + left - list.scrollLeft, listBox.left)
        const screenRight = Math.min(listBox.left + right - list.scrollLeft, listBox.left + list.clientWidth)
        const screenTop = Math.max(listBox.top + top - list.scrollTop, listBox.top)
        const screenBottom = Math.min(listBox.top + bottom - list.scrollTop, listBox.top + list.clientHeight)
        setBox({ left: screenLeft, top: screenTop, width: Math.max(0, screenRight - screenLeft), height: Math.max(0, screenBottom - screenTop) })
      }

      function onMouseMove(moveEvent: MouseEvent) {
        mouseX = moveEvent.clientX
        mouseY = moveEvent.clientY
        if (!dragging && Math.abs(mouseX - event.clientX) < DRAG_PX && Math.abs(mouseY - event.clientY) < DRAG_PX) {
          return
        }
        dragging = true
        update()
      }

      // Scrolls the list while the mouse is at (or past) the edge the rectangle grows towards, faster the further out.
      const timer = setInterval(() => {
        if (!dragging || list === null) {
          return
        }
        listBox = list.getBoundingClientRect()
        const y = mouseY - listBox.top + list.scrollTop
        if (mouseY < listBox.top + EDGE_PX && y < startY) {
          list.scrollTop -= Math.min(40, Math.ceil((listBox.top + EDGE_PX - mouseY) / 3))
        } else if (mouseY > listBox.bottom - EDGE_PX && y > startY) {
          list.scrollTop += Math.min(40, Math.ceil((mouseY - listBox.bottom + EDGE_PX) / 3))
        }
        // Also catches the mouse wheel turning while dragging.
        update()
      }, 16)

      function onMouseUp() {
        clearInterval(timer)
        window.removeEventListener("mousemove", onMouseMove)
        window.removeEventListener("mouseup", onMouseUp)
        setBox(null)
        if (dragging) {
          // The click this release makes would open the row under the mouse.
          function swallow(clickEvent: MouseEvent) {
            clickEvent.stopPropagation()
            clickEvent.preventDefault()
          }
          window.addEventListener("click", swallow, true)
          setTimeout(() => window.removeEventListener("click", swallow, true), 0)
        } else if (onEmpty && base.length === 0) {
          onSelect([])
        }
      }

      window.addEventListener("mousemove", onMouseMove)
      window.addEventListener("mouseup", onMouseUp)
    }

    // Escape and Ctrl+A, unless a dialog or a menu is open, or (for Ctrl+A) the cursor is in a text field.
    function onKeyDown(event: KeyboardEvent) {
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]") !== null) {
        return
      }
      if (event.key === "Escape" && selected.length > 0) {
        onSelect([])
        return
      }
      const typing = (event.target as HTMLElement).closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a" && !typing && ids.length > 0) {
        event.preventDefault()
        onSelect([...new Set([...selected, ...ids])])
      }
    }

    list.addEventListener("mousedown", onMouseDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      list.removeEventListener("mousedown", onMouseDown)
      window.removeEventListener("keydown", onKeyDown)
    }
  })

  return (
    <>
      {box !== null && <div className="pointer-events-none fixed z-50 rounded-[2px] border border-primary bg-primary/10" style={box} />}
      {selected.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center">
          <div className="pointer-events-auto flex h-9 items-center gap-1 rounded-lg border bg-popover pr-1 pl-3 text-popover-foreground shadow-lg">
            <span className="font-medium tabular-nums">{selected.length} selected</span>
            {ids.some((id) => !selected.includes(id)) && (
              <Button size="xs" variant="ghost" className="text-muted-foreground" title="Ctrl+A" onClick={() => onSelect([...new Set([...selected, ...ids])])}>
                Select all {ids.length}
              </Button>
            )}
            {props.children !== undefined && (
              <>
                <span className="mx-1 h-4 w-px bg-border" />
                {props.children}
              </>
            )}
            <span className="mx-1 h-4 w-px bg-border" />
            <Button size="icon-xs" variant="ghost" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={() => onSelect([])}>
              <X />
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
