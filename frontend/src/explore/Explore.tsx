import { AlertIcon, ArchiveIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, HistoryIcon, IssueOpenedIcon, LawIcon, LinkIcon, PaperAirplaneIcon, PlusCircleIcon, RepoForkedIcon, SearchIcon, SquareFillIcon, StarIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";

import RepoPreview from "./RepoPreview";
import "./explore.css";

export interface Repo {
  id: number;
  full_name: string;
  html_url: string;
  owner: { avatar_url: string };
  description: string | null;
  homepage: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  topics: string[];
  license: { spdx_id: string } | null;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  default_branch: string;
}

interface Entry {
  id: string;
  prefix: string;
  value: string;
}

interface SearchResult {
  total_count: number;
  items: Repo[];
}

const LANGUAGE_COLORS: Record<string, string> = {
  C: "#555555",
  "C#": "#178600",
  "C++": "#f34b7d",
  Clojure: "#db5855",
  CSS: "#663399",
  Dart: "#00B4AB",
  Dockerfile: "#384d54",
  Elixir: "#6e4a7e",
  Go: "#00ADD8",
  Haskell: "#5e5086",
  HTML: "#e34c26",
  Java: "#b07219",
  JavaScript: "#f1e05a",
  "Jupyter Notebook": "#DA5B0B",
  Kotlin: "#A97BFF",
  Lua: "#000080",
  Nix: "#7e7eff",
  OCaml: "#ef7a08",
  PHP: "#4F5D95",
  Python: "#3572A5",
  Ruby: "#701516",
  Rust: "#dea584",
  Scala: "#c22d40",
  Shell: "#89e051",
  Swift: "#F05138",
  TypeScript: "#3178c6",
  Vue: "#41b883",
  Zig: "#ec915c",
};

const QUALIFIERS = [
  {
    group: "Keywords",
    items: [
      { prefix: "", placeholder: "sandbox", hint: 'Words, "a phrase", a OR b, anything' },
      { prefix: "NOT ", placeholder: "word", hint: "Leave out a word" },
      { prefix: "in:", placeholder: "name,description,readme,topics", hint: "Where words match" },
    ],
  },
  {
    group: "Counts",
    items: [
      { prefix: "stars:", placeholder: ">100", hint: ">n, <=n, a..b, n..*" },
      { prefix: "forks:", placeholder: "10..500", hint: "Forks" },
      { prefix: "followers:", placeholder: ">=50", hint: "Followers" },
      { prefix: "size:", placeholder: "<10000", hint: "Size in KB" },
      { prefix: "topics:", placeholder: ">=3", hint: "Number of topics" },
      { prefix: "good-first-issues:", placeholder: ">2", hint: "Good first issues" },
      { prefix: "help-wanted-issues:", placeholder: ">0", hint: "Help wanted issues" },
    ],
  },
  {
    group: "Dates",
    items: [
      { prefix: "created:", placeholder: ">2025-01-01", hint: "Date, a..b or a time" },
      { prefix: "pushed:", placeholder: ">2026-09-01", hint: "Last push" },
    ],
  },
  {
    group: "Tags",
    items: [
      { prefix: "language:", placeholder: "go", hint: "Main language" },
      { prefix: "topic:", placeholder: "cli", hint: "Topic tag" },
      { prefix: "license:", placeholder: "mit", hint: "License" },
    ],
  },
  {
    group: "Owner",
    items: [
      { prefix: "user:", placeholder: "torvalds", hint: "User's repos" },
      { prefix: "org:", placeholder: "microsoft", hint: "Organization's repos" },
      { prefix: "repo:", placeholder: "cli/cli", hint: "One repo" },
    ],
  },
  {
    group: "Type",
    items: [
      { prefix: "archived:", placeholder: "false", hint: "true or false" },
      { prefix: "fork:", placeholder: "true", hint: "true or only" },
      { prefix: "mirror:", placeholder: "false", hint: "true or false" },
      { prefix: "template:", placeholder: "true", hint: "true or false" },
      { prefix: "is:", placeholder: "public", hint: "public, private, internal, sponsorable" },
      { prefix: "has:", placeholder: "funding-file", hint: "Has FUNDING.yml" },
    ],
  },
  {
    group: "Exclude and sort",
    items: [
      { prefix: "-topic:", placeholder: "tutorial", hint: "Leave out a topic" },
      { prefix: "-language:", placeholder: "javascript", hint: "Leave out a language" },
      { prefix: "-license:", placeholder: "gpl-3.0", hint: "Leave out a license" },
      { prefix: "-user:", placeholder: "someone", hint: "Leave out a user" },
      { prefix: "-org:", placeholder: "someorg", hint: "Leave out an org" },
      { prefix: "-repo:", placeholder: "owner/name", hint: "Leave out a repo" },
      { prefix: "sort:", placeholder: "stars", hint: "stars, forks, updated, add -asc" },
    ],
  },
];

const MODES = [
  { name: "Auto", description: "Agent decides what to do." },
  { name: "Plan", description: "Agent only chats and won't change the query." },
  { name: "Search", description: "Agent searches on your next prompt." },
  { name: "Manual", description: "Agent only changes the query and won't search." },
];

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

// The views the user had open, so a refresh opens them again.
let saved: Record<string, string | null> = {};
try {
  saved = JSON.parse(localStorage.getItem("explore") || "{}");
} catch {
  saved = {};
}

// Explore tab: chat or query on the left, repos in the middle, and a repo preview with the repo list on the right.
export default function Explore(props: { active: boolean; leftOpen: boolean; tabs: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [searchedQ, setSearchedQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [view, setView] = useState<"search" | "session">(saved.view === "search" ? "search" : "session");
  const [leftView, setLeftView] = useState<"chat" | "query">(saved.leftView === "query" ? "query" : "chat");
  const [rightOpen, setRightOpen] = useState(true);
  const resultsScroll = useRef<HTMLDivElement>(null);
  // The repo open in the preview. Every opening counts up, so opening the same repo again loads it fresh.
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [previewOpens, setPreviewOpens] = useState(0);

  // Remember the views for the next refresh. Storage can be blocked (private window): then they just aren't kept.
  useEffect(() => {
    try {
      localStorage.setItem("explore", JSON.stringify({ view, leftView }));
    } catch {
      return;
    }
  }, [view, leftView]);

  function openPreview(name: string) {
    setRightOpen(true);
    setPreviewName(name);
    setPreviewOpens(previewOpens + 1);
  }

  const [sessionRepos, setSessionRepos] = useState<Repo[]>([]);
  const [status, setStatus] = useState<"idle" | "searching">("idle");
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{ role: string; text: string }[]>([]);
  const [chatBusy, setChatBusy] = useState(false);

  useEffect(() => {
    fetch("/api/chat/history")
      .then((response) => response.json())
      .then((body) => {
        setChatMessages(body.messages);
        setSessionRepos(body.repos);
      })
      .catch(() => {});
  }, []);

  function newSession() {
    setChatMessages([]);
    setSessionRepos([]);
    fetch("/api/chat/new", { method: "POST" });
  }

  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<{ session_id: string; name: string }[]>([]);

  async function openHistory() {
    setHistoryOpen(true);
    const response = await fetch("/api/chat/sessions");
    setSessions(await response.json());
  }

  async function openSession(sessionId: string) {
    setHistoryOpen(false);
    const response = await fetch("/api/chat/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const body = await response.json();
    setChatMessages(body.messages);
    setSessionRepos(body.repos);
  }
  const chatBox = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState("Auto");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  async function sendChat() {
    const message = chatInput.trim();
    if (!message || chatBusy) {
      return;
    }
    setChatMessages((old) => [...old, { role: "user", text: message }]);
    setChatInput("");
    if (chatBox.current) {
      chatBox.current.style.height = "";
    }

    setChatBusy(true);
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/filters");
        const body = await response.json();
        setEntries(body.entries);
        setSessionRepos(body.repos);
        setChatMessages(body.history);
      } catch {
        return;
      }
    }, 500);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message, mode: mode, entries: entries }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setEntries(body.entries);
      setSessionRepos(body.repos);
      if (body.result) {
        setResult(body.result);
        setSearchedQ(body.query);
        setPage(1);
        setPageInput("1");
        setError(null);
      }
      setChatMessages(body.history);
    } catch (err) {
      setChatMessages((old) => [...old, { role: "error", text: `Chat failed: ${err instanceof Error ? err.message : err}` }]);
    }
    window.clearInterval(timer);
    setChatBusy(false);
  }

  function stopChat() {
    fetch("/api/chat/interrupt", { method: "POST" });
  }

  // Ctrl+Alt+B folds the right panel, Esc stops the agent. Ctrl+B is in main.tsx.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!props.active) {
        return;
      }
      if (event.ctrlKey && event.altKey && event.code === "KeyB") {
        event.preventDefault();
        if (previewName !== null) {
          setRightOpen(!rightOpen);
        }
        return;
      }
      if (event.key === "Escape" && chatBusy) {
        event.preventDefault();
        stopChat();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function search(query: string, newPage: number) {
    setStatus("searching");
    setError(null);

    const params = new URLSearchParams({ q: query, page: String(newPage) });
    const sortMatch = query.match(/(?:^|\s)sort:(\S+)/);
    if (sortMatch) {
      params.set("sort", sortMatch[1].replace(/-asc$/, ""));
      params.set("order", sortMatch[1].endsWith("-asc") ? "asc" : "desc");
    }

    try {
      const response = await fetch(`/api/search?${params}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setResult(body);
      setSearchedQ(query);
      setPage(newPage);
      setPageInput(String(newPage));
      resultsScroll.current?.scrollTo(0, 0);
    } catch (err) {
      setPageInput(String(page));
      setError(`Search failed: ${err instanceof Error ? err.message : err}`);
    }
    setStatus("idle");
  }

  const tokens = entries.filter((entry) => entry.value.trim()).map((entry) => entry.prefix + entry.value.trim());
  const q = tokens.join(" ");

  function addEntry(prefix: string) {
    setEntries([...entries, { id: crypto.randomUUID(), prefix: prefix, value: "" }]);
  }

  function changeEntry(id: string, value: string) {
    setEntries(entries.map((entry) => (entry.id === id ? { ...entry, value: value } : entry)));
  }

  function removeEntry(id: string) {
    setEntries(entries.filter((entry) => entry.id !== id));
  }

  const lastPage = result ? Math.max(1, Math.min(Math.ceil(result.total_count / 100), 10)) : 1;

  const searchRepos = result ? result.items.slice(0, 30) : [];
  const shownRepos = view === "search" ? searchRepos : sessionRepos;

  function goToPage() {
    const newPage = Math.min(Math.max(Number.parseInt(pageInput) || 1, 1), lastPage);
    if (newPage === page) {
      setPageInput(String(page));
      return;
    }
    search(searchedQ, newPage);
  }

  let layoutClass = "layout";
  if (!props.leftOpen) {
    layoutClass += " layout-folded";
  }
  if (previewName !== null && rightOpen) {
    layoutClass += " layout-right";
  }
  if (previewName !== null && !rightOpen) {
    layoutClass += " layout-right-folded";
  }

  const pager = (
    <div className="pager">
      <button className="btn" type="button" aria-label="Previous page" disabled={status !== "idle" || page <= 1} onClick={() => search(searchedQ, page - 1)}>
        <ChevronLeftIcon size={16} />
      </button>
      <label className="btn page-label">
        Page
        <input
          className="page-input"
          type="number"
          min={1}
          max={lastPage}
          value={pageInput}
          disabled={status !== "idle"}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={goToPage}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        of {lastPage}
      </label>
      <button className="btn" type="button" aria-label="Next page" disabled={status !== "idle" || page >= lastPage} onClick={() => search(searchedQ, page + 1)}>
        <ChevronRightIcon size={16} />
      </button>
    </div>
  );

  return (
    <div className="container" hidden={!props.active}>
      <div className={layoutClass}>
        <div className={props.leftOpen ? "left-panel" : "left-panel left-panel-folded"}>
          {props.tabs}
          <div className="left-panel-header">
            <div className="view-toggle">
              <button className={leftView === "chat" ? "view-toggle-on" : ""} type="button" aria-pressed={leftView === "chat"} onClick={() => setLeftView("chat")}>
                Chat
              </button>
              <button className={leftView === "query" ? "view-toggle-on" : ""} type="button" aria-pressed={leftView === "query"} onClick={() => setLeftView("query")}>
                Query
              </button>
            </div>
            {leftView === "chat" && (
              <>
                <button className="mode-button new-session" type="button" disabled={chatBusy} onClick={newSession}>
                  New Session
                </button>
                <button className="mode-button history-button" type="button" aria-label="Chat history" aria-expanded={historyOpen} disabled={chatBusy} onClick={openHistory}>
                  <HistoryIcon size={16} />
                </button>
              </>
            )}
          </div>
          {historyOpen && <div className="mode-backdrop" onClick={() => setHistoryOpen(false)} />}
          {historyOpen && (
            <div className="history-menu" role="menu">
              <div className="mode-menu-title">History</div>
              {sessions.length === 0 && <p className="history-empty">No past chats yet.</p>}
              {sessions.map((session) => (
                <button key={session.session_id} className="mode-option" type="button" role="menuitem" onClick={() => openSession(session.session_id)}>
                  <span className="history-name">{session.name}</span>
                </button>
              ))}
            </div>
          )}

          {leftView === "chat" && (
            <aside className="chat">
              <div className="chat-messages">
                {chatMessages.length === 0 && <p className="chat-empty">Describe the repos you want.</p>}
                {chatMessages.map((message, i) => (
                  <div key={i} className={`chat-message chat-message-${message.role}`}>
                    {message.role === "assistant" || message.role === "activity" ? <Markdown>{message.text}</Markdown> : message.text}
                  </div>
                ))}
                {chatBusy && (
                  <p className="status-line">
                    <span className="spinner" /> Thinking…
                  </p>
                )}
              </div>
              <form
                className="chat-input"
                onSubmit={(event) => {
                  event.preventDefault();
                  sendChat();
                }}
              >
                <textarea
                  ref={chatBox}
                  className="form-control"
                  rows={1}
                  value={chatInput}
                  placeholder="Ask for repos…"
                  onChange={(event) => {
                    setChatInput(event.target.value);
                    event.target.style.height = "";
                    event.target.style.height = `${event.target.scrollHeight + 2}px`;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      sendChat();
                    }
                  }}
                />
                <div className="chat-input-row">
                  <button className="mode-button" type="button" aria-expanded={modeMenuOpen} onClick={() => setModeMenuOpen(!modeMenuOpen)}>
                    {mode}
                  </button>
                  {chatBusy ? (
                    <button className="btn" type="button" aria-label="Stop" onClick={stopChat}>
                      <SquareFillIcon size={16} />
                    </button>
                  ) : (
                    <button className="btn btn-primary" type="submit" aria-label="Send" disabled={!chatInput.trim()}>
                      <PaperAirplaneIcon size={16} />
                    </button>
                  )}
                </div>

                {modeMenuOpen && <div className="mode-backdrop" onClick={() => setModeMenuOpen(false)} />}
                {modeMenuOpen && (
                  <div className="mode-menu" role="menu">
                    <div className="mode-menu-title">Modes</div>
                    {MODES.map((option) => (
                      <button
                        key={option.name}
                        className={option.name === mode ? "mode-option mode-option-active" : "mode-option"}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option.name === mode}
                        onClick={() => {
                          setMode(option.name);
                          setModeMenuOpen(false);
                        }}
                      >
                        <span>
                          <span className="mode-option-name">{option.name}</span>
                          <span className="mode-option-description">{option.description}</span>
                        </span>
                        {option.name === mode && <CheckIcon size={16} />}
                      </button>
                    ))}
                  </div>
                )}
              </form>
            </aside>
          )}

          {leftView === "query" && (
            <aside className="sidebar">
              <form
                className="filter-panel"
                onSubmit={(event) => {
                  event.preventDefault();
                  search(q, 1);
                }}
              >
                <h2 className="filter-panel-title">Query</h2>
                <p className="filter-panel-note">Built from the fields below. Press Search to run it.</p>
                <textarea
                  className="form-control query-input"
                  rows={5}
                  value={q}
                  readOnly
                  spellCheck={false}
                  placeholder="Add fields below to build the query"
                />
                <div className="panel-actions">
                  <button className="btn btn-primary btn-block" type="submit" disabled={status !== "idle" || !q}>
                    <SearchIcon size={16} />
                    Search
                  </button>
                </div>
              </form>

              <div className="filter-panel">
                <h2 className="filter-panel-title">Supported filters</h2>
                <p className="filter-panel-note">Press + to add a value; it goes into q. Press × to remove it.</p>
                {QUALIFIERS.map((section) => (
                  <div key={section.group} className="qualifier-group">
                    <div className="qualifier-group-title">{section.group}</div>
                    {section.items.map((item) => (
                      <div key={item.prefix}>
                        <div className="qualifier">
                          <button className="btn-icon" type="button" aria-label={`Add ${item.hint}`} onClick={() => addEntry(item.prefix)}>
                            <PlusCircleIcon size={16} />
                          </button>
                          <code>{item.prefix + item.placeholder}</code>
                          <span className="qualifier-hint">{item.hint}</span>
                        </div>
                        {entries
                          .filter((entry) => entry.prefix === item.prefix)
                          .map((entry) => (
                            <div key={entry.id} className="entry">
                              <button className="btn-icon" type="button" aria-label="Remove" onClick={() => removeEntry(entry.id)}>
                                <XIcon size={16} />
                              </button>
                              <code>{entry.prefix}</code>
                              <input
                                className="form-control entry-input"
                                value={entry.value}
                                placeholder={item.placeholder}
                                spellCheck={false}
                                autoFocus={!chatBusy}
                                onChange={(event) => changeEntry(entry.id, event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && q) {
                                    search(q, 1);
                                  }
                                }}
                              />
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </aside>
          )}
        </div>

        <main className="results">
          {error && (
            <div className="flash-error">
              <AlertIcon size={16} /> {error}
            </div>
          )}

          <div className="results-header">
            <div className="results-header-row">
              <div className="results-counts">
                {view === "search" && result !== null && (
                  <>
                    <strong>{result.total_count.toLocaleString()} repositories</strong>
                    <span className="dot-separator">·</span>
                    page {page} of {lastPage}
                  </>
                )}
                {view === "session" && <strong>{sessionRepos.length} repos picked by the agent</strong>}
              </div>
              <div className="results-actions">
                {view === "search" && result !== null && lastPage > 1 && pager}
                <div className="view-toggle">
                  <button className={view === "session" ? "view-toggle-on" : ""} type="button" aria-pressed={view === "session"} onClick={() => { setView("session"); setPreviewName(null); }}>
                    Agent Result
                  </button>
                  <button className={view === "search" ? "view-toggle-on" : ""} type="button" aria-pressed={view === "search"} onClick={() => { setView("search"); setPreviewName(null); }}>
                    Search result
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="results-scroll" ref={resultsScroll}>
            {previewName !== null && (
              <RepoPreview key={`${previewName}-${previewOpens}`} name={previewName} scrollBox={resultsScroll} onClose={() => setPreviewName(null)} onError={(message) => setError(message)} />
            )}

            {previewName === null && (
              <>
                {view === "search" && status === "searching" && (
                  <p className="status-line">
                    <span className="spinner" /> Searching…
                  </p>
                )}

                {view === "search" && result === null && status === "idle" && (
                  <div className="blankslate">
                    <SearchIcon size={24} />
                    <h3>Search repositories</h3>
                    <p>Add fields on the left and press Search.</p>
                  </div>
                )}

                {view === "search" && result !== null && result.items.length === 0 && (
                  <div className="blankslate">
                    <h3>No repos to show</h3>
                    <p>Nothing matched this query. Try fewer fields.</p>
                  </div>
                )}

                {view === "session" && sessionRepos.length === 0 && (
                  <div className="blankslate">
                    <h3>No repos yet</h3>
                    <p>Repos the agent picks for you show up here.</p>
                  </div>
                )}

                {shownRepos.length > 0 && (
                  <div className="repo-list">
                    {shownRepos.map((repo) => (
                      <article className="repo-card" key={repo.id}>
                        <div className="repo-title-row">
                          <img className="avatar" src={repo.owner.avatar_url} alt="" width={20} height={20} />
                          <a
                            className="repo-title"
                            href={repo.html_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => {
                              if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                                event.preventDefault();
                                openPreview(repo.full_name);
                              }
                            }}
                          >
                            {repo.full_name.split("/")[0]}/<strong>{repo.full_name.split("/")[1]}</strong>
                          </a>
                          {repo.archived && (
                            <span className="label label-attention">
                              <ArchiveIcon size={12} /> Archived
                            </span>
                          )}
                          {repo.fork && <span className="label">Fork</span>}
                        </div>

                        {repo.description && <p className="repo-description">{repo.description}</p>}

                        {repo.topics.length > 0 && (
                          <div className="topics">
                            {repo.topics.map((topic) => (
                              <span key={topic} className="topic">
                                {topic}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="repo-meta">
                          {repo.language && (
                            <span className="meta-item">
                              <span className="language-dot" style={{ backgroundColor: LANGUAGE_COLORS[repo.language] ?? "#8b949e" }} />
                              {repo.language}
                            </span>
                          )}
                          <span className="meta-item" title={`${repo.stargazers_count.toLocaleString()} stars`}>
                            <StarIcon size={16} /> {COUNT.format(repo.stargazers_count)}
                          </span>
                          <span className="meta-item" title={`${repo.forks_count.toLocaleString()} forks`}>
                            <RepoForkedIcon size={16} /> {COUNT.format(repo.forks_count)}
                          </span>
                          <span className="meta-item" title={`${repo.open_issues_count.toLocaleString()} open issues and PRs`}>
                            <IssueOpenedIcon size={16} /> {COUNT.format(repo.open_issues_count)}
                          </span>
                          {repo.license && (
                            <span className="meta-item">
                              <LawIcon size={16} /> {repo.license.spdx_id}
                            </span>
                          )}
                          <span className="meta-item">Updated {DATE.format(new Date(repo.pushed_at))}</span>
                          {repo.homepage && (
                            <a className="meta-item meta-link" href={repo.homepage} target="_blank" rel="noreferrer">
                              <LinkIcon size={16} /> Website
                            </a>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {view === "search" && result !== null && lastPage > 1 && <div className="load-more">{pager}</div>}
              </>
            )}
          </div>
        </main>

        {previewName !== null && (
          <aside className={rightOpen ? "right-panel" : "right-panel right-panel-folded"}>
            <button
              className="fold-tab"
              type="button"
              aria-label={rightOpen ? "Hide repo list" : "Show repo list"}
              title={rightOpen ? "Hide repo list" : "Show repo list"}
              onClick={() => setRightOpen(!rightOpen)}
            >
              {rightOpen ? <ChevronRightIcon size={12} /> : <ChevronLeftIcon size={12} />}
            </button>
            <div className="left-panel-header">
              <div className="view-toggle">
                <button className={view === "session" ? "view-toggle-on" : ""} type="button" aria-pressed={view === "session"} onClick={() => setView("session")}>
                  Agent Result
                </button>
                <button className={view === "search" ? "view-toggle-on" : ""} type="button" aria-pressed={view === "search"} onClick={() => setView("search")}>
                  Search result
                </button>
              </div>
            </div>
            <div className="side-list">
              {shownRepos.length === 0 && <p className="side-empty muted">{view === "session" ? "No repos picked yet." : "No search results."}</p>}
              {shownRepos.map((repo) => (
                <article className={repo.full_name === previewName ? "side-card side-card-active" : "side-card"} key={repo.id}>
                  <div className="repo-title-row">
                    <img className="avatar" src={repo.owner.avatar_url} alt="" width={20} height={20} />
                    <a
                      className="repo-title"
                      href={repo.html_url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                          event.preventDefault();
                          openPreview(repo.full_name);
                        }
                      }}
                    >
                      {repo.full_name.split("/")[0]}/<strong>{repo.full_name.split("/")[1]}</strong>
                    </a>
                  </div>
                  <div className="repo-meta">
                    {repo.language && (
                      <span className="meta-item">
                        <span className="language-dot" style={{ backgroundColor: LANGUAGE_COLORS[repo.language] ?? "#8b949e" }} />
                        {repo.language}
                      </span>
                    )}
                    <span className="meta-item" title={`${repo.stargazers_count.toLocaleString()} stars`}>
                      <StarIcon size={16} /> {COUNT.format(repo.stargazers_count)}
                    </span>
                    <span className="meta-item" title={`${repo.forks_count.toLocaleString()} forks`}>
                      <RepoForkedIcon size={16} /> {COUNT.format(repo.forks_count)}
                    </span>
                    <span className="meta-item" title={`${repo.open_issues_count.toLocaleString()} open issues and PRs`}>
                      <IssueOpenedIcon size={16} /> {COUNT.format(repo.open_issues_count)}
                    </span>
                    {repo.license && (
                      <span className="meta-item">
                        <LawIcon size={16} /> {repo.license.spdx_id}
                      </span>
                    )}
                    <span className="meta-item">Updated {DATE.format(new Date(repo.pushed_at))}</span>
                    {repo.homepage && (
                      <a className="meta-item meta-link" href={repo.homepage} target="_blank" rel="noreferrer">
                        <LinkIcon size={16} /> Website
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
