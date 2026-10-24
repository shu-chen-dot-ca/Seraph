import { useEffect, useState } from "react"

// Every title="..." in the app shows as a themed tooltip after a short wait, instead of the browser's own one, which
// waits about a second, ignores the theme (light even in dark mode) and is tiny. Mounted once, in App, so the 100+
// titles across the pages stay plain title attributes.
//
// How: while the pointer is on an element with a title, the title moves to data-title (so the browser shows nothing)
// and moves back when the pointer leaves. The tooltip sits under the pointer, like the browser's, and above it near
// the bottom of the window. An iframe keeps its title: it only names the iframe for screen readers.

const DELAY_MS = 250

type Tip = { text: string; x: number; y: number; above: boolean; right: boolean }

export default function TitleTooltips() {
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let target: Element | null = null
    let timer = 0
    let pointerX = 0
    let pointerY = 0

    function hide() {
      window.clearTimeout(timer)
      if (target !== null) {
        // If React set a new title meanwhile, keep that one.
        if (!target.hasAttribute("title")) {
          target.setAttribute("title", target.getAttribute("data-title") ?? "")
        }
        target.removeAttribute("data-title")
        target = null
      }
      setTip(null)
    }

    function onMove(event: MouseEvent) {
      pointerX = event.clientX
      pointerY = event.clientY
      // data-title too: that is the element whose title is moved out right now.
      const element = event.target instanceof Element ? event.target.closest("[title], [data-title]") : null
      if (element === target) {
        return
      }
      hide()
      const text = element?.getAttribute("title") ?? ""
      if (element === null || element.tagName === "IFRAME" || text.trim() === "") {
        return
      }
      target = element
      element.setAttribute("data-title", text)
      element.removeAttribute("title")
      timer = window.setTimeout(() => {
        const above = pointerY > window.innerHeight - 120
        const right = pointerX > window.innerWidth - 320
        setTip({ text: text, x: pointerX, y: pointerY, above: above, right: right })
      }, DELAY_MS)
    }

    function onLeave(event: MouseEvent) {
      if (event.relatedTarget === null) {
        hide()
      }
    }

    document.addEventListener("mouseover", onMove)
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseout", onLeave)
    document.addEventListener("mousedown", hide)
    document.addEventListener("keydown", hide)
    document.addEventListener("wheel", hide, { passive: true })
    return () => {
      hide()
      document.removeEventListener("mouseover", onMove)
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseout", onLeave)
      document.removeEventListener("mousedown", hide)
      document.removeEventListener("keydown", hide)
      document.removeEventListener("wheel", hide)
    }
  }, [])

  if (tip === null) {
    return null
  }
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[100] max-w-sm animate-in rounded-md bg-foreground px-2.5 py-1.5 text-xs whitespace-pre-line text-background fade-in-0"
      style={{
        left: tip.right ? undefined : tip.x - 8,
        right: tip.right ? window.innerWidth - tip.x - 8 : undefined,
        top: tip.above ? undefined : tip.y + 20,
        bottom: tip.above ? window.innerHeight - tip.y + 12 : undefined,
      }}
    >
      {tip.text}
    </div>
  )
}
