import { memo } from "react"
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"

// Where images may load from in text an agent wrote (drafts, its chat replies). An image from any other
// host would let an agent send data out (in the image's URL) even from a VM with its internet off,
// just by the user opening the text. Those show as a plain link instead. The exceptions are this app's own
// pictures, which never leave this machine: evidence (/api/evidence/..., the Inbox puts a PR's pictures there) and
// an agent's artifacts (/api/agents/<id>/artifacts/file?path=..., where its chat shows ![...](artifact:path)).
const GITHUB_IMAGE_HOSTS = [
  "github.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "avatars.githubusercontent.com",
]

// Issue and PR references, linked to GitHub like GitHub does in issues and comments: "owner/name#12"
// anywhere, and a bare "#12" when the text belongs to a repo. /issues/12 is sent on to /pull/12 for a PR.
// Not inside words or paths ("abc#1", "a/b/c#1"), code or existing links.
const ISSUE_REF = /([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+)?#(\d+)\b/g

// Text split into plain parts and linked references.
function issueRefParts(text: string, repo?: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = []
  let last = 0
  for (const match of text.matchAll(ISSUE_REF)) {
    const start = match.index ?? 0
    const before = start > 0 ? text[start - 1] : ""
    const owner = match[1]
    if (/[\w/&]/.test(before) || (owner === undefined && !repo)) {
      continue
    }
    parts.push({ text: text.slice(last, start) })
    parts.push({ text: match[0], url: `https://github.com/${owner ?? repo}/issues/${match[2]}` })
    last = start + match[0].length
  }
  parts.push({ text: text.slice(last) })
  return parts.filter((part) => part.text !== "")
}

// The markdown side: a remark plugin that turns references in text nodes into link nodes.
type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] }
const NOT_LINKED = ["link", "linkReference", "inlineCode", "code", "html", "definition"]

function linkRefs(node: MdNode, repo?: string) {
  if (node.children === undefined) {
    return
  }
  const children: MdNode[] = []
  for (const child of node.children) {
    if (NOT_LINKED.includes(child.type)) {
      children.push(child)
      continue
    }
    if (child.type !== "text") {
      linkRefs(child, repo)
      children.push(child)
      continue
    }
    for (const part of issueRefParts(child.value ?? "", repo)) {
      const text: MdNode = { type: "text", value: part.text }
      children.push(part.url === undefined ? text : { type: "link", url: part.url, children: [text] })
    }
  }
  node.children = children
}

function remarkIssueRefs(options: { repo?: string }) {
  return (tree: MdNode) => linkRefs(tree, options.repo)
}

// The plain text side, for one-line text like a tool call's summary. Links don't toggle what they sit in.
function IssueRefText(props: { text: string; repo?: string }) {
  return (
    <>
      {issueRefParts(props.text, props.repo).map((part, index) =>
        part.url === undefined ? (
          part.text
        ) : (
          <a
            key={index}
            href={part.url}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            {part.text}
          </a>
        )
      )}
    </>
  )
}

// Made once, here: renderers made inside the component would be new component types on every render,
// and React would rebuild every link and image each time.
const COMPONENTS: Components = {
  a: ({ node: _node, ...rest }) => {
    // An in-page anchor ("#install") would change the URL hash, which is the app's page. It does nothing here.
    if (rest.href?.startsWith("#")) {
      return <a {...rest} onClick={(event) => event.preventDefault()} />
    }
    return <a {...rest} target="_blank" rel="noreferrer" />
  },
  img: ({ node: _node, ...rest }) => {
    // Tailwind's base styles give every image height: auto, which beats a README's
    // width="…" / height="…" (a 150px banner would fill the page). Inline styles win.
    const width = /^\d+$/.test(String(rest.width ?? "")) ? `${rest.width}px` : undefined
    const height = /^\d+$/.test(String(rest.height ?? "")) ? `${rest.height}px` : undefined
    return <img {...rest} style={{ width, height }} />
  },
}

const GITHUB_IMAGES_ONLY: Components = {
  a: COMPONENTS.a,
  img: ({ node: _node, ...rest }) => {
    const src = String(rest.src ?? "")
    let host = ""
    let evidence = false
    try {
      const url = new URL(src, window.location.href)
      host = url.hostname
      evidence =
        url.origin === window.location.origin && (url.pathname.startsWith("/api/evidence/") || /^\/api\/agents\/[^/]+\/artifacts\/file$/.test(url.pathname))
    } catch {
      host = ""
    }
    if (!GITHUB_IMAGE_HOSTS.includes(host) && !evidence) {
      return (
        <a href={src} target="_blank" rel="noreferrer">
          {rest.alt || "image"} ({host || "unknown host"})
        </a>
      )
    }
    const width = /^\d+$/.test(String(rest.width ?? "")) ? `${rest.width}px` : undefined
    const height = /^\d+$/.test(String(rest.height ?? "")) ? `${rest.height}px` : undefined
    return <img {...rest} style={{ width, height }} />
  },
  // <picture><source srcset="…"> loads its URL without the check above; the <img> inside is the fallback.
  source: () => null,
}

// GitHub flavored markdown (tables, task lists, strikethrough) at the UI's 13px. Links open in a new tab.
// For a file inside a repo, pass repo ("owner/name"), gitRef (branch or sha) and base (the file's folder):
// relative links then point at github.com and relative images at raw.githubusercontent.com, like on GitHub.
// HTML inside the markdown (README banners, <details>) is shown too, cleaned the way GitHub cleans it:
// a README is someone else's text, and a script in it must never run on this page.
// githubImagesOnly: for text an agent wrote (see GITHUB_IMAGE_HOSTS).
// issueRefs: link issue and PR references (see ISSUE_REF): for issue bodies, comments, drafts and agent replies.
// Memoized: parsing is the slow part, and it only runs again when one of these props changes.
const Markdown = memo(function Markdown(props: {
  text: string
  repo?: string
  gitRef?: string
  base?: string
  className?: string
  githubImagesOnly?: boolean
  issueRefs?: boolean
}) {
  return (
    <div className={cn("prose prose-sm dark:prose-invert markdown", props.className)}>
      <ReactMarkdown
        remarkPlugins={props.issueRefs ? [remarkGfm, [remarkIssueRefs, { repo: props.repo }]] : [remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        urlTransform={(url, key) => {
          // Absolute URLs (with a scheme or //host), in-page anchors, and markdown outside a repo stay as they are.
          if (!props.repo || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) {
            return defaultUrlTransform(url)
          }
          // Resolve "./x", "../x" and "/x" against the file's folder, using a dummy host.
          const folder = props.base ? props.base + "/" : ""
          const target = new URL(url, "https://repo.invalid/" + folder)
          const path = target.pathname.slice(1) + target.search + target.hash
          const ref = props.gitRef || "HEAD"
          if (key === "src") {
            return `https://raw.githubusercontent.com/${props.repo}/${ref}/${path}`
          }
          return `https://github.com/${props.repo}/blob/${ref}/${path}`
        }}
        components={props.githubImagesOnly ? GITHUB_IMAGES_ONLY : COMPONENTS}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  )
})

export { IssueRefText, Markdown }
