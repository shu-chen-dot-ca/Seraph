import { AlertIcon, ArchiveIcon, ChevronLeftIcon, ChevronRightIcon, CheckIcon, FileDirectoryFillIcon, FileIcon, CodeIcon, GitBranchIcon, GitCommitIcon, LinkExternalIcon, PaperAirplaneIcon, SquareFillIcon, PlusCircleIcon, PlusIcon, SyncIcon, TrashIcon, XIcon, HistoryIcon, IssueOpenedIcon, LawIcon, LinkIcon, RepoForkedIcon, SearchIcon, StarIcon } from "@primer/octicons-react";
import { StrictMode, useEffect, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";

import "github-markdown-css/github-markdown.css";
import "./styles.css";

interface Repo {
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

// One VM session from GET /api/vm/sessions: its record plus the VM's live state.
interface VmSession {
  id: string;
  name: string;
  repo: string;
  vm: string;
  cpus: number;
  memory_gb: number;
  disk_gb: number;
  internet: boolean;
  env: Record<string, string>;
  autostart: boolean;
  status: string; // creating, starting, running, stopping, stopped, failed, missing
  created_at: string;
  on: boolean;
  cpu_percent: number | null;
  memory_used_gb: number | null;
}

// What the create dialog may offer, from GET /api/vm/options (set in .env).
interface VmOptions {
  cpus: number[];
  cpus_default: number;
  memory_gb: number[];
  memory_gb_default: number;
  disk_gb: number[];
  disk_gb_default: number;
  count_max: number;
}

interface Entry {
  id: string;
  prefix: string;
  value: string;
}

interface DirEntry {
  name: string;
  path: string;
  type: string;
  size: number;
  html_url: string;
}

interface Contents {
  type: "dir" | "file";
  path: string;
  entries?: DirEntry[];
  readme_html?: string | null;
  name?: string;
  size?: number;
  download_url?: string | null;
  html_url?: string;
  text?: string | null;
  html?: string | null;
}

interface Commit {
  sha: string;
  message: string;
  author: string;
  avatar_url: string | null;
  date: string;
  html_url: string;
}

interface Preview {
  name: string;
  repo: Repo | null;
  path: string;
  contents: Contents | null;
  trail: string[];
  branch: string;
  branches: string[];
  view: "code" | "commits";
  commits: Commit[] | null;
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

function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [searchedQ, setSearchedQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [view, setView] = useState<"search" | "session">("session");
  const [leftTab, setLeftTab] = useState<"explore" | "vm">("explore");
  const [leftView, setLeftView] = useState<"chat" | "query">("chat");
  const [vmView, setVmView] = useState<"sessions" | "settings">("sessions");
  const [createOpen, setCreateOpen] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState("");
  const [newVmName, setNewVmName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [vmSessions, setVmSessions] = useState<VmSession[]>([]);
  const [vmSessionsLoaded, setVmSessionsLoaded] = useState(false);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  // The session whose desktop the right panel shows, and the noVNC page for it.
  const [selectedVmId, setSelectedVmId] = useState<string | null>(null);
  // Where the desktop (noVNC) and the terminals (ttyd) of the selected VM are.
  const [viewerUrls, setViewerUrls] = useState<{ desktop: string; terminal: string } | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [vmPanel, setVmPanel] = useState<"desktop" | "terminal" | "settings">("desktop");
  // Bumped by the Reconnect button: new iframe keys make the desktop and terminals load again.
  const [viewerReload, setViewerReload] = useState(0);
  // Terminal tabs of the selected VM: tmux session names "1", "2", ...
  const [terminals, setTerminals] = useState<string[]>([]);
  const [activeTerminal, setActiveTerminal] = useState<string | null>(null);
  // Agent tab: the chat with the selected session's agent.
  const [vmChatMessages, setVmChatMessages] = useState<{ role: string; text: string }[]>([]);
  const [vmChatInput, setVmChatInput] = useState("");
  const [vmChatBusy, setVmChatBusy] = useState(false);
  const vmChatBox = useRef<HTMLTextAreaElement>(null);
  // The selected session right now, for answers that arrive after the user picked another one.
  const selectedVmIdRef = useRef<string | null>(null);
  selectedVmIdRef.current = selectedVmId;

  // A new session picked: show its chat (and whether its agent is still answering).
  useEffect(() => {
    setVmChatMessages([]);
    setVmChatBusy(false);
    if (selectedVmId === null) {
      return;
    }
    fetch(`/api/vm/sessions/${selectedVmId}/agent`)
      .then((response) => response.json())
      .then((body) => {
        if (selectedVmIdRef.current === selectedVmId && body.history) {
          setVmChatMessages(body.history);
          setVmChatBusy(body.busy);
        }
      })
      .catch(() => undefined);
  }, [selectedVmId]);

  async function sendVmChat() {
    const message = vmChatInput.trim();
    const sessionId = selectedVmId;
    if (!message || vmChatBusy || sessionId === null) {
      return;
    }
    setVmChatMessages((old) => [...old, { role: "user", text: message }]);
    setVmChatInput("");
    if (vmChatBox.current) {
      vmChatBox.current.style.height = "";
    }

    setVmChatBusy(true);
    // While the agent works, show what it did so far.
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/vm/sessions/${sessionId}/agent`);
        const body = await response.json();
        if (selectedVmIdRef.current === sessionId && body.history) {
          setVmChatMessages(body.history);
        }
      } catch {
        return;
      }
    }, 500);

    try {
      const response = await fetch(`/api/vm/sessions/${sessionId}/agent/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      if (selectedVmIdRef.current === sessionId) {
        setVmChatMessages(body.history);
      }
    } catch (err) {
      if (selectedVmIdRef.current === sessionId) {
        setVmChatMessages((old) => [...old, { role: "error", text: `Chat failed: ${err instanceof Error ? err.message : err}` }]);
      }
    }
    window.clearInterval(timer);
    if (selectedVmIdRef.current === sessionId) {
      setVmChatBusy(false);
    }
  }

  function stopVmChat() {
    fetch(`/api/vm/sessions/${selectedVmId}/agent/interrupt`, { method: "POST" });
  }

  // Settings tab: drafts that are only sent when saved, and the last error.
  const [envRows, setEnvRows] = useState<[string, string][]>([]);
  const [settingsCpus, setSettingsCpus] = useState(0);
  const [settingsMemoryGb, setSettingsMemoryGb] = useState(0);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // A new session picked: fill the drafts from it, and get the CPU and memory choices.
  useEffect(() => {
    setSettingsError(null);
    const session = vmSessions.find((item) => item.id === selectedVmId);
    if (!session) {
      return;
    }
    setEnvRows(Object.entries(session.env ?? {}));
    setSettingsCpus(session.cpus);
    setSettingsMemoryGb(session.memory_gb);
    if (vmOptions === null) {
      fetch("/api/vm/options")
        .then((response) => response.json())
        .then((options) => setVmOptions(options))
        .catch(() => setSettingsError("Could not reach the backend."));
    }
    // Only when the selection changes; the list refreshing every second must not reset the drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVmId]);

  // One settings change: start, stop, internet, autostart, resources or env.
  async function vmSettingsCall(action: string, method: string, body?: object) {
    setSettingsError(null);
    try {
      const response = await fetch(`/api/vm/sessions/${selectedVmId}/${action}`, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const answer = await response.json();
      if (!response.ok) {
        setSettingsError(answer.detail ?? "That did not work.");
        return;
      }
      if (answer.id) {
        setVmSessions((current) => current.map((item) => (item.id === answer.id ? { ...item, ...answer } : item)));
      }
    } catch {
      setSettingsError("Could not reach the backend.");
    }
  }

  function saveEnv() {
    const env: Record<string, string> = {};
    for (const [key, value] of envRows) {
      if (key.trim() !== "") {
        env[key.trim()] = value;
      }
    }
    vmSettingsCall("env", "PUT", { env: env });
  }
  const selectedVm = vmSessions.find((session) => session.id === selectedVmId) ?? null;
  const selectedVmReady = selectedVm !== null && selectedVm.on && selectedVm.status === "running";
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});

  async function deleteVmSession(session: VmSession) {
    if (!window.confirm(`Delete ${session.name}? Its VM and everything in it are removed.`)) {
      return;
    }
    setDeletingIds((current) => [...current, session.id]);
    setDeleteErrors((current) => ({ ...current, [session.id]: "" }));
    try {
      const response = await fetch(`/api/vm/sessions/${session.id}`, { method: "DELETE" });
      if (response.ok) {
        setVmSessions((current) => current.filter((item) => item.id !== session.id));
        if (selectedVmId === session.id) {
          setSelectedVmId(null);
        }
      } else {
        const body = await response.json();
        setDeleteErrors((current) => ({ ...current, [session.id]: body.detail ?? "Could not delete the session." }));
      }
    } catch {
      setDeleteErrors((current) => ({ ...current, [session.id]: "Could not reach the backend." }));
    } finally {
      setDeletingIds((current) => current.filter((id) => id !== session.id));
    }
  }
  const [vmOptions, setVmOptions] = useState<VmOptions | null>(null);
  const [newCpus, setNewCpus] = useState(0);
  const [newMemoryGb, setNewMemoryGb] = useState(0);
  const [newDiskGb, setNewDiskGb] = useState(0);
  const [newCount, setNewCount] = useState(1);

  // Open the dialog with the defaults from .env.
  async function openCreate() {
    setCreateOpen(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/vm/options");
      const options: VmOptions = await response.json();
      setVmOptions(options);
      setNewCpus(options.cpus_default);
      setNewMemoryGb(options.memory_gb_default);
      setNewDiskGb(options.disk_gb_default);
      setNewCount(1);
    } catch {
      setCreateError("Could not reach the backend.");
    }
  }

  function closeCreate() {
    setCreateOpen(false);
    setNewRepoUrl("");
    setNewVmName("");
    setCreateError(null);
  }

  // The backend starts creating and answers right away; the list below shows the progress.
  async function createVmSession() {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/vm/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: newRepoUrl, name: newVmName, cpus: newCpus, memory_gb: newMemoryGb, disk_gb: newDiskGb, count: newCount }),
      });
      const body = await response.json();
      if (!response.ok) {
        setCreateError(body.detail ?? "Could not create the session.");
        return;
      }
      const created: VmSession[] = body.map((session: VmSession) => ({ ...session, on: false, cpu_percent: null, memory_used_gb: null }));
      setVmSessions((current) => [...current, ...created]);
      closeCreate();
    } catch {
      setCreateError("Could not reach the backend.");
    } finally {
      setCreateBusy(false);
    }
  }

  // Once the selected VM is on and set up, ask where its desktop and terminals are,
  // and which terminals are still running (they survive page reloads). Drop it all when it goes off.
  useEffect(() => {
    setTerminals([]);
    setActiveTerminal(null);
    if (selectedVmId === null || !selectedVmReady) {
      setViewerUrls(null);
      setViewerError(null);
      return;
    }
    let stopped = false;
    async function loadViewer() {
      try {
        const response = await fetch(`/api/vm/sessions/${selectedVmId}/viewer`);
        const body = await response.json();
        if (stopped) {
          return;
        }
        if (!response.ok) {
          setViewerError(body.detail ?? "Could not open the VM.");
          return;
        }
        setViewerUrls(body);
        setViewerError(null);

        const terminalsResponse = await fetch(`/api/vm/sessions/${selectedVmId}/terminals`);
        let names: string[] = terminalsResponse.ok ? await terminalsResponse.json() : [];
        if (stopped) {
          return;
        }
        if (names.length === 0) {
          names = ["1"];
        }
        setTerminals(names);
        setActiveTerminal(names[0]);
      } catch {
        if (!stopped) {
          setViewerError("Could not reach the backend.");
        }
      }
    }
    loadViewer();
    return () => {
      stopped = true;
    };
  }, [selectedVmId, selectedVmReady]);

  function addTerminal() {
    let next = 1;
    for (const name of terminals) {
      next = Math.max(next, Number(name) + 1);
    }
    setTerminals([...terminals, String(next)]);
    setActiveTerminal(String(next));
  }

  // Closing a tab stops the terminal: its shell and whatever runs in it end.
  function closeTerminal(name: string) {
    const left = terminals.filter((item) => item !== name);
    setTerminals(left);
    if (activeTerminal === name) {
      setActiveTerminal(left.length > 0 ? left[left.length - 1] : null);
    }
    fetch(`/api/vm/sessions/${selectedVmId}/terminals/${name}`, { method: "DELETE" });
  }

  // While the VM Sessions tab is open, ask for the latest list about every second.
  // The next request starts only after the last one finished, so requests never pile up,
  // and a failed request keeps the list we have instead of emptying it.
  useEffect(() => {
    if (leftTab !== "vm") {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loadVmSessions() {
      try {
        const response = await fetch("/api/vm/sessions");
        if (response.ok && !stopped) {
          setVmSessions(await response.json());
          setVmSessionsLoaded(true);
        }
      } catch {
        // The backend is restarting; the next round tries again.
      }
      if (!stopped) {
        timer = setTimeout(loadVmSessions, 1000);
      }
    }
    loadVmSessions();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [leftTab]);
  const chatShown = leftTab === "explore" && leftView === "chat";
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  // The VM agent's chat, in the right panel while a session is picked.
  const [agentOpen, setAgentOpen] = useState(true);
  const resultsScroll = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  async function loadContents(name: string, repo: Repo | null, path: string, trail: string[], branch: string, branches: string[]) {
    setPreview({ name: name, repo: repo, path: path, contents: null, trail: trail, branch: branch, branches: branches, view: "code", commits: null });
    resultsScroll.current?.scrollTo(0, 0);
    try {
      if (repo === null) {
        const response = await fetch(`/api/repo/${name}`);
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.detail);
        }
        repo = body.repo as Repo;
        branch = repo.default_branch;
        const branchesResponse = await fetch(`/api/repo/${name}/branches`);
        const branchesBody = await branchesResponse.json();
        branches = branchesResponse.ok ? branchesBody.branches : [];
        // Only the first 100 branches come back, so make sure the default one is there.
        if (!branches.includes(branch)) {
          branches = [branch, ...branches];
        }
      }
      const response = await fetch(`/api/repo/${name}/contents?${new URLSearchParams({ path: path, ref: branch })}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setPreview({ name: name, repo: repo, path: path, contents: body, trail: trail, branch: branch, branches: branches, view: "code", commits: null });
    } catch (err) {
      setPreview(null);
      setError(`Could not open ${name}/${path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  function openPreview(name: string) {
    setRightOpen(true);
    loadContents(name, null, "", [], "", []);
  }

  function openPath(path: string) {
    if (preview) {
      loadContents(preview.name, preview.repo, path, [...preview.trail, preview.path], preview.branch, preview.branches);
    }
  }

  function switchBranch(branch: string) {
    if (preview) {
      loadContents(preview.name, preview.repo, "", [], branch, preview.branches);
    }
  }

  async function showCommits() {
    if (!preview) {
      return;
    }
    const name = preview.name;
    setPreview({ ...preview, view: "commits", commits: null });
    try {
      const response = await fetch(`/api/repo/${name}/commits?${new URLSearchParams({ ref: preview.branch, path: preview.path })}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setPreview((current) => (current && current.name === name && current.view === "commits" ? { ...current, commits: body.commits } : current));
    } catch (err) {
      setPreview((current) => (current ? { ...current, view: "code" } : current));
      setError(`Could not load commits of ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  function goBack() {
    if (!preview || preview.trail.length === 0) {
      setPreview(null);
      return;
    }
    loadContents(preview.name, preview.repo, preview.trail[preview.trail.length - 1], preview.trail.slice(0, -1), preview.branch, preview.branches);
  }

  function onReadmeClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link || !preview) {
      return;
    }
    event.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      // GitHub prefixes heading ids with "user-content-".
      const name = decodeURIComponent(href.slice(1));
      const target = document.getElementById("user-content-" + name) ?? document.getElementById(name);
      // The id sits on the hidden permalink, so scroll to its heading instead.
      (target?.closest(".markdown-heading") ?? target)?.scrollIntoView();
      return;
    }
    const inRepo = link.href.match(new RegExp(`^https://github\\.com/${preview.name}/(?:blob|tree)/[^/]+/(.*)$`));
    if (inRepo) {
      openPath(decodeURIComponent(inRepo[1]));
      return;
    }
    window.open(link.href, "_blank", "noreferrer");
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

  // Ctrl+B folds the left panel, Ctrl+Alt+B the right one, Esc stops the agent.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.altKey && event.code === "KeyB") {
        event.preventDefault();
        if (leftTab === "explore" && preview !== null) {
          setRightOpen(!rightOpen);
        }
        if (leftTab === "vm" && selectedVm !== null) {
          setAgentOpen(!agentOpen);
        }
        return;
      }
      if (event.ctrlKey && !event.altKey && event.code === "KeyB") {
        event.preventDefault();
        setLeftOpen(!leftOpen);
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
  if (!leftOpen) {
    layoutClass += " layout-folded";
  }
  if (leftTab === "explore" && preview !== null && rightOpen) {
    layoutClass += " layout-right";
  }
  if (leftTab === "explore" && preview !== null && !rightOpen) {
    layoutClass += " layout-right-folded";
  }
  if (leftTab === "vm" && selectedVm !== null && agentOpen) {
    layoutClass += " layout-right layout-agent";
  }
  if (leftTab === "vm" && selectedVm !== null && !agentOpen) {
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
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="app-logo" href="/">
            <SearchIcon size={24} />
            <span className="app-name">Searcher</span>
          </a>
        </div>
      </header>

      <div className="container">
        <div className={layoutClass}>
          <div className={leftOpen ? "left-panel" : "left-panel left-panel-folded"}>
            <button
              className="fold-tab"
              type="button"
              aria-label={leftOpen ? "Hide chat and query" : "Show chat and query"}
              title={leftOpen ? "Hide chat and query" : "Show chat and query"}
              onClick={() => setLeftOpen(!leftOpen)}
            >
              {leftOpen ? <ChevronLeftIcon size={12} /> : <ChevronRightIcon size={12} />}
            </button>
            {/* Explore: chat and query. VM Sessions: the session cards. */}
            <div className="view-toggle left-tabs">
              <button className={leftTab === "explore" ? "view-toggle-on" : ""} type="button" aria-pressed={leftTab === "explore"} onClick={() => setLeftTab("explore")}>
                Explore
              </button>
              <button className={leftTab === "vm" ? "view-toggle-on" : ""} type="button" aria-pressed={leftTab === "vm"} onClick={() => setLeftTab("vm")}>
                VM Sessions
              </button>
            </div>
            <div className="left-panel-header">
              {leftTab === "explore" && (
                <div className="view-toggle">
                  <button className={leftView === "chat" ? "view-toggle-on" : ""} type="button" aria-pressed={leftView === "chat"} onClick={() => setLeftView("chat")}>
                    Chat
                  </button>
                  <button className={leftView === "query" ? "view-toggle-on" : ""} type="button" aria-pressed={leftView === "query"} onClick={() => setLeftView("query")}>
                    Query
                  </button>
                </div>
              )}
              {leftTab === "vm" && (
                <div className="view-toggle">
                  <button className={vmView === "sessions" ? "view-toggle-on" : ""} type="button" aria-pressed={vmView === "sessions"} onClick={() => setVmView("sessions")}>
                    Sessions
                  </button>
                  <button className={vmView === "settings" ? "view-toggle-on" : ""} type="button" aria-pressed={vmView === "settings"} onClick={() => setVmView("settings")}>
                    Settings
                  </button>
                </div>
              )}
              {leftTab === "vm" && (
                <button className="btn btn-primary new-session" type="button" onClick={openCreate}>
                  <PlusCircleIcon size={16} /> Create new session
                </button>
              )}
              {chatShown && (
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

            {leftTab === "vm" && vmView === "sessions" && (
              <div className="vm-session-list">
                {!vmSessionsLoaded && <p className="side-empty muted">Loading sessions…</p>}
                {vmSessionsLoaded && vmSessions.length === 0 && <p className="side-empty muted">No VM sessions yet.</p>}
                {vmSessions.map((session) => (
                  <article
                    className={session.id === selectedVmId ? "vm-card vm-card-selected" : "vm-card"}
                    key={session.id}
                    onClick={() => setSelectedVmId(session.id)}
                  >
                    <div className="vm-card-title-row">
                      <strong className="vm-card-name">{session.name}</strong>
                      <span className={session.on ? "vm-state vm-state-on" : "vm-state"}>
                        <span className="vm-state-dot" />
                        {session.on ? "On" : "Off"}
                      </span>
                    </div>
                    {session.name !== session.vm && <div className="vm-card-sub">{session.vm}</div>}
                    {session.repo && <div className="vm-card-sub">{session.repo}</div>}
                    <div className="vm-card-meta">
                      <span>
                        CPU {session.on && session.cpu_percent !== null ? `${Math.round(session.cpu_percent)}%` : "–"} of {session.cpus} cores
                      </span>
                      <span>
                        Memory {session.on && session.memory_used_gb !== null ? session.memory_used_gb.toFixed(1) : "–"} / {session.memory_gb} GB
                      </span>
                      <span>Disk {session.disk_gb} GB</span>
                    </div>
                    {session.status !== "running" && session.status !== "stopped" && (
                      <div className={session.status === "failed" || session.status === "missing" ? "vm-card-status vm-card-status-bad" : "vm-card-status"}>
                        {session.status === "creating" && "Creating…"}
                        {session.status === "starting" && "Starting…"}
                        {session.status === "stopping" && "Stopping…"}
                        {session.status === "failed" && "Setup failed"}
                        {session.status === "missing" && "VM is missing"}
                      </div>
                    )}
                    {deleteErrors[session.id] && <div className="vm-card-status vm-card-status-bad">{deleteErrors[session.id]}</div>}
                    <div className="vm-card-actions">
                      <button className="btn btn-danger btn-sm" type="button" disabled={deletingIds.includes(session.id)} onClick={(event) => {
                          event.stopPropagation();
                          deleteVmSession(session);
                        }}
                      >
                        <TrashIcon size={14} /> {deletingIds.includes(session.id) ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {leftTab === "vm" && vmView === "settings" && <p className="side-empty muted">No settings yet.</p>}

            {chatShown && (
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

            {leftTab === "explore" && leftView === "query" && (
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
            {leftTab === "explore" && error && (
              <div className="flash-error">
                <AlertIcon size={16} /> {error}
              </div>
            )}

            <div className="results-header">
              <div className="results-header-row">
                {leftTab === "vm" && (
                  <div className="view-toggle">
                    <button className={vmPanel === "desktop" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "desktop"} onClick={() => setVmPanel("desktop")}>
                      Desktop
                    </button>
                    <button className={vmPanel === "terminal" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "terminal"} onClick={() => setVmPanel("terminal")}>
                      Terminal
                    </button>
                    <button className={vmPanel === "settings" ? "view-toggle-on" : ""} type="button" aria-pressed={vmPanel === "settings"} onClick={() => setVmPanel("settings")}>
                      Settings
                    </button>
                  </div>
                )}
                {leftTab === "vm" && selectedVmReady && (vmPanel === "desktop" || vmPanel === "terminal") && (
                  <button className="btn btn-sm" type="button" title="Connect the desktop and terminals again" onClick={() => setViewerReload(viewerReload + 1)}>
                    <SyncIcon size={14} /> Reconnect
                  </button>
                )}
                {leftTab === "explore" && (
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
                )}
                {leftTab === "explore" && (
                <div className="results-actions">
                  {view === "search" && result !== null && lastPage > 1 && pager}
                  <div className="view-toggle">
                    <button className={view === "session" ? "view-toggle-on" : ""} type="button" aria-pressed={view === "session"} onClick={() => { setView("session"); setPreview(null); }}>
                      Agent Result
                    </button>
                    <button className={view === "search" ? "view-toggle-on" : ""} type="button" aria-pressed={view === "search"} onClick={() => { setView("search"); setPreview(null); }}>
                      Search result
                    </button>
                  </div>
                </div>
                )}
              </div>
            </div>

            {leftTab === "vm" && (
              <div className="vm-viewer">
                {selectedVm === null && <p className="vm-viewer-empty muted">Pick a session on the left to open it.</p>}
                {selectedVm !== null && !selectedVmReady && (vmPanel === "desktop" || vmPanel === "terminal") && (
                  <p className="vm-viewer-empty muted">
                    {selectedVm.status === "creating" && "The VM is being set up. It opens here when it is ready."}
                    {selectedVm.status === "starting" && "The VM is starting."}
                    {selectedVm.status === "stopping" && "The VM is shutting down."}
                    {selectedVm.status === "failed" && "Setup failed, so there is nothing to open."}
                    {selectedVm.status === "missing" && "The VM is missing."}
                    {(selectedVm.status === "running" || selectedVm.status === "stopped") && "The VM is off. Start it in Settings."}
                  </p>
                )}
                {selectedVmReady && viewerError && (vmPanel === "desktop" || vmPanel === "terminal") && <p className="vm-viewer-empty vm-card-status-bad">{viewerError}</p>}
                {selectedVm !== null && vmPanel === "settings" && (
                  <div className="vm-pane vm-settings">
                    {settingsError && <p className="vm-card-status vm-card-status-bad">{settingsError}</p>}

                    <section className="vm-settings-section">
                      <h3 className="vm-settings-title">Power</h3>
                      <div className="vm-settings-row">
                        <span className={selectedVm.on ? "vm-state vm-state-on" : "vm-state"}>
                          <span className="vm-state-dot" />
                          {selectedVm.status === "starting" ? "Starting…" : selectedVm.status === "stopping" ? "Stopping…" : selectedVm.on ? "On" : "Off"}
                        </span>
                        {selectedVm.on ? (
                          <button className="btn btn-sm" type="button" disabled={selectedVm.status !== "running" && selectedVm.status !== "failed"} onClick={() => vmSettingsCall("stop", "POST")}>
                            Stop
                          </button>
                        ) : (
                          <button className="btn btn-sm" type="button" disabled={selectedVm.status !== "stopped" && selectedVm.status !== "running"} onClick={() => vmSettingsCall("start", "POST")}>
                            Start
                          </button>
                        )}
                      </div>
                      <p className="vm-settings-note muted">Stopping keeps the disk; starting brings everything back except what was only in memory.</p>
                    </section>

                    <section className="vm-settings-section">
                      <h3 className="vm-settings-title">Network</h3>
                      <label className="vm-settings-check">
                        <input type="checkbox" checked={selectedVm.internet} onChange={(event) => vmSettingsCall("internet", "PUT", { enabled: event.target.checked })} />
                        Internet
                      </label>
                      <p className="vm-settings-note muted">Off blocks everything the VM starts itself. The desktop and terminal keep working. This computer and your local network are never reachable from the VM.</p>
                    </section>

                    <section className="vm-settings-section">
                      <h3 className="vm-settings-title">Environment variables</h3>
                      {envRows.map((row, index) => (
                        <div className="vm-settings-env-row" key={index}>
                          <input
                            className="form-control"
                            value={row[0]}
                            placeholder="NAME"
                            spellCheck={false}
                            onChange={(event) => setEnvRows(envRows.map((item, i) => (i === index ? [event.target.value, item[1]] : item)))}
                          />
                          <input
                            className="form-control"
                            value={row[1]}
                            placeholder="value"
                            spellCheck={false}
                            onChange={(event) => setEnvRows(envRows.map((item, i) => (i === index ? [item[0], event.target.value] : item)))}
                          />
                          <button className="terminal-tab-close" type="button" aria-label="Remove variable" onClick={() => setEnvRows(envRows.filter((_, i) => i !== index))}>
                            <XIcon size={14} />
                          </button>
                        </div>
                      ))}
                      <div className="vm-settings-row">
                        <button className="btn btn-sm" type="button" onClick={() => setEnvRows([...envRows, ["", ""]])}>
                          <PlusIcon size={14} /> Add variable
                        </button>
                        <button className="btn btn-sm btn-primary" type="button" onClick={saveEnv}>
                          Save variables
                        </button>
                      </div>
                      <p className="vm-settings-note muted">For every shell in the VM. Terminals opened after saving see them; close and reopen ones that are already open.</p>
                    </section>

                    <section className="vm-settings-section">
                      <h3 className="vm-settings-title">Resources</h3>
                      {vmOptions && (
                        <div className="vm-settings-row">
                          <select className="form-select vm-settings-select" value={settingsCpus} disabled={selectedVm.on} onChange={(event) => setSettingsCpus(Number(event.target.value))}>
                            {vmOptions.cpus.map((cpus) => (
                              <option key={cpus} value={cpus}>
                                {cpus} cores
                              </option>
                            ))}
                          </select>
                          <select className="form-select vm-settings-select" value={settingsMemoryGb} disabled={selectedVm.on} onChange={(event) => setSettingsMemoryGb(Number(event.target.value))}>
                            {vmOptions.memory_gb.map((gb) => (
                              <option key={gb} value={gb}>
                                {gb} GB memory
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn-sm"
                            type="button"
                            disabled={selectedVm.on || (settingsCpus === selectedVm.cpus && settingsMemoryGb === selectedVm.memory_gb)}
                            onClick={() => vmSettingsCall("resources", "PUT", { cpus: settingsCpus, memory_gb: settingsMemoryGb })}
                          >
                            Apply
                          </button>
                        </div>
                      )}
                      <p className="vm-settings-note muted">{selectedVm.on ? "Stop the VM to change CPU and memory." : "Applies the next time the VM starts."} Disk: {selectedVm.disk_gb} GB (fixed).</p>
                    </section>

                    <section className="vm-settings-section">
                      <h3 className="vm-settings-title">Startup</h3>
                      <label className="vm-settings-check">
                        <input type="checkbox" checked={selectedVm.autostart} onChange={(event) => vmSettingsCall("autostart", "PUT", { enabled: event.target.checked })} />
                        Start this VM when the computer starts
                      </label>
                    </section>

                    <section className="vm-settings-section">
                      <h3 className="vm-settings-title">About</h3>
                      <dl className="vm-settings-about">
                        <dt>VM</dt>
                        <dd>{selectedVm.vm}</dd>
                        <dt>Repo</dt>
                        <dd>{selectedVm.repo || "none"}</dd>
                        <dt>Created</dt>
                        <dd>{new Date(selectedVm.created_at).toLocaleString()}</dd>
                      </dl>
                    </section>
                  </div>
                )}
                {/* Both panels stay loaded while hidden, so switching never reconnects. */}
                {selectedVmReady && viewerUrls && !viewerError && (
                  <div className={vmPanel === "desktop" ? "vm-pane" : "vm-pane vm-pane-hidden"}>
                    <iframe className="vm-viewer-frame" key={`${viewerUrls.desktop}-${viewerReload}`} src={viewerUrls.desktop} title={`Desktop of ${selectedVm.name}`} />
                  </div>
                )}
                {selectedVmReady && viewerUrls && !viewerError && (
                  <div className={vmPanel === "terminal" ? "vm-pane" : "vm-pane vm-pane-hidden"}>
                    <div className="terminal-tabs" role="tablist">
                      {terminals.map((name) => (
                        <div key={name} className={name === activeTerminal ? "terminal-tab terminal-tab-on" : "terminal-tab"}>
                          <button className="terminal-tab-name" type="button" role="tab" aria-selected={name === activeTerminal} onClick={() => setActiveTerminal(name)}>
                            Terminal {name}
                          </button>
                          <button className="terminal-tab-close" type="button" aria-label={`Close terminal ${name}`} title="Close (stops what runs in it)" onClick={() => closeTerminal(name)}>
                            <XIcon size={12} />
                          </button>
                        </div>
                      ))}
                      <button className="terminal-tab-add" type="button" aria-label="New terminal" title="New terminal" onClick={addTerminal}>
                        <PlusIcon size={14} />
                      </button>
                    </div>
                    {terminals.length === 0 && <p className="vm-viewer-empty muted">No terminals open. Press + to open one.</p>}
                    {terminals.map((name) => (
                      <iframe
                        key={`${viewerUrls.terminal}-${name}-${viewerReload}`}
                        className={name === activeTerminal ? "vm-viewer-frame" : "vm-viewer-frame vm-pane-hidden"}
                        src={`${viewerUrls.terminal}?arg=${name}`}
                        title={`Terminal ${name} of ${selectedVm.name}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {leftTab === "explore" && (
            <div className="results-scroll" ref={resultsScroll}>
              {leftTab === "explore" && preview !== null && (
                <div className="preview">
                  <div className="preview-actions">
                    <button className="btn" type="button" onClick={goBack}>
                      <ChevronLeftIcon size={16} /> Back
                    </button>
                    <a className="btn" href={preview.contents?.html_url ?? `https://github.com/${preview.name}`} target="_blank" rel="noreferrer">
                      Open on GitHub <LinkExternalIcon size={16} />
                    </a>
                  </div>

                  {preview.repo !== null && (
                    <>
                      <div className="repo-title-row">
                        <img className="avatar" src={preview.repo.owner.avatar_url} alt="" width={20} height={20} />
                        <span className="repo-title">
                          {preview.repo.full_name.split("/")[0]}/<strong>{preview.repo.full_name.split("/")[1]}</strong>
                        </span>
                        {preview.repo.archived && (
                          <span className="label label-attention">
                            <ArchiveIcon size={12} /> Archived
                          </span>
                        )}
                      </div>
                      {preview.repo.description && <p className="repo-description">{preview.repo.description}</p>}
                      <div className="repo-meta">
                        {preview.repo.language && <span className="meta-item">{preview.repo.language}</span>}
                        <span className="meta-item">
                          <StarIcon size={16} /> {preview.repo.stargazers_count.toLocaleString()}
                        </span>
                        <span className="meta-item">
                          <RepoForkedIcon size={16} /> {preview.repo.forks_count.toLocaleString()}
                        </span>
                        {preview.repo.license && (
                          <span className="meta-item">
                            <LawIcon size={16} /> {preview.repo.license.spdx_id}
                          </span>
                        )}
                        <span className="meta-item">Updated {DATE.format(new Date(preview.repo.pushed_at))}</span>
                        {preview.repo.homepage && (
                          <a className="meta-item meta-link" href={preview.repo.homepage} target="_blank" rel="noreferrer">
                            <LinkIcon size={16} /> Website
                          </a>
                        )}
                      </div>
                    </>
                  )}

                  <div className="code-toolbar">
                    <label className="branch-select">
                      <GitBranchIcon size={16} />
                      <select value={preview.branch} disabled={preview.branches.length === 0} onChange={(event) => switchBranch(event.target.value)}>
                        {preview.branches.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))}
                      </select>
                    </label>
                    {preview.view === "code" && (
                      <button className="btn" type="button" disabled={preview.contents === null} onClick={showCommits}>
                        <GitCommitIcon size={16} /> Commits
                      </button>
                    )}
                    {preview.view === "commits" && (
                      <button className="btn" type="button" onClick={() => setPreview({ ...preview, view: "code" })}>
                        <CodeIcon size={16} /> Code
                      </button>
                    )}
                  </div>

                  <div className="breadcrumb">
                    <button className="btn-link" type="button" onClick={() => openPath("")}>
                      {preview.name.split("/")[1]}
                    </button>
                    {preview.path
                      .split("/")
                      .filter(Boolean)
                      .map((part, i, parts) => (
                        <span key={i}>
                          {" / "}
                          <button className="btn-link" type="button" onClick={() => openPath(parts.slice(0, i + 1).join("/"))}>
                            {part}
                          </button>
                        </span>
                      ))}
                  </div>

                  {preview.view === "commits" && preview.commits === null && (
                    <p className="status-line">
                      <span className="spinner" /> Loading commits…
                    </p>
                  )}

                  {preview.view === "commits" && preview.commits !== null && (
                    <div className="commit-list">
                      {preview.commits.length === 0 && <p className="commit-empty muted">No commits.</p>}
                      {preview.commits.map((commit) => (
                        <a key={commit.sha} className="commit-row" href={commit.html_url} target="_blank" rel="noreferrer">
                          <div className="commit-main">
                            <div className="commit-message">{commit.message.split("\n")[0]}</div>
                            <div className="commit-meta muted">
                              {commit.avatar_url && <img className="avatar" src={commit.avatar_url} alt="" width={16} height={16} />}
                              <strong>{commit.author}</strong> committed on {DATE.format(new Date(commit.date))}
                            </div>
                          </div>
                          <code className="commit-sha">{commit.sha.slice(0, 7)}</code>
                        </a>
                      ))}
                    </div>
                  )}

                  {preview.view === "code" && preview.contents === null && (
                    <p className="status-line">
                      <span className="spinner" /> Loading…
                    </p>
                  )}

                  {preview.view === "code" && preview.contents?.type === "dir" && (
                    <div className="file-list">
                      {preview.contents.entries?.map((entry) => (
                        <button
                          key={entry.path}
                          className="file-row"
                          type="button"
                          onClick={() => (entry.type === "dir" || entry.type === "file" ? openPath(entry.path) : window.open(entry.html_url, "_blank", "noreferrer"))}
                        >
                          {entry.type === "dir" ? <FileDirectoryFillIcon size={16} className="file-icon-dir" /> : <FileIcon size={16} className="file-icon" />}
                          {entry.name}
                        </button>
                      ))}
                    </div>
                  )}

                  {preview.view === "code" && preview.contents?.type === "dir" && preview.contents.readme_html && (
                    <div className="readme" dangerouslySetInnerHTML={{ __html: preview.contents.readme_html }} onClick={onReadmeClick} />
                  )}

                  {preview.view === "code" && preview.contents?.type === "file" && (
                    <div className="file-view">
                      <div className="file-view-header">
                        <strong>{preview.contents.name}</strong>
                        <span className="muted">{COUNT.format(preview.contents.size ?? 0)}B</span>
                        {preview.contents.download_url && (
                          <a className="meta-link" href={preview.contents.download_url} target="_blank" rel="noreferrer">
                            Raw
                          </a>
                        )}
                      </div>
                      {preview.contents.html && <div className="readme" dangerouslySetInnerHTML={{ __html: preview.contents.html }} onClick={onReadmeClick} />}
                      {!preview.contents.html && preview.contents.text !== null && preview.contents.text !== undefined && (
                        <pre className="file-code">
                          <code>{preview.contents.text}</code>
                        </pre>
                      )}
                      {preview.contents.text === null && /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(preview.contents.name ?? "") && preview.contents.download_url && (
                        <img className="file-image" src={preview.contents.download_url} alt={preview.contents.name} />
                      )}
                      {preview.contents.text === null && !/\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(preview.contents.name ?? "") && (
                        <p className="muted">This file is binary or too large to show here. Use Raw or Open on GitHub.</p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {leftTab === "explore" && preview === null && (
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
            )}
          </main>

          {leftTab === "vm" && selectedVm !== null && (
            <aside className={agentOpen ? "right-panel agent-panel" : "right-panel agent-panel right-panel-folded"}>
              <button
                className="fold-tab"
                type="button"
                aria-label={agentOpen ? "Hide agent" : "Show agent"}
                title={agentOpen ? "Hide agent" : "Show agent"}
                onClick={() => setAgentOpen(!agentOpen)}
              >
                {agentOpen ? <ChevronRightIcon size={12} /> : <ChevronLeftIcon size={12} />}
              </button>
              <div className="left-panel-header">
                <strong>Agent</strong>
              </div>
              <div className="chat">
                <div className="chat-messages">
                  {vmChatMessages.length === 0 && <p className="chat-empty">Talk to the agent of {selectedVm.name}.</p>}
                  {vmChatMessages.map((message, i) => (
                    <div key={i} className={`chat-message chat-message-${message.role}`}>
                      {message.role === "assistant" || message.role === "activity" ? <Markdown>{message.text}</Markdown> : message.text}
                    </div>
                  ))}
                  {vmChatBusy && (
                    <p className="status-line">
                      <span className="spinner" /> Thinking…
                    </p>
                  )}
                </div>
                <form
                  className="chat-input"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendVmChat();
                  }}
                >
                  <textarea
                    ref={vmChatBox}
                    className="form-control"
                    rows={1}
                    value={vmChatInput}
                    placeholder="Message the agent…"
                    onChange={(event) => {
                      setVmChatInput(event.target.value);
                      event.target.style.height = "";
                      event.target.style.height = `${event.target.scrollHeight + 2}px`;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        sendVmChat();
                      }
                      if (event.key === "Escape" && vmChatBusy) {
                        stopVmChat();
                      }
                    }}
                  />
                  <div className="chat-input-row vm-chat-input-row">
                    {vmChatBusy ? (
                      <button className="btn" type="button" aria-label="Stop" onClick={stopVmChat}>
                        <SquareFillIcon size={16} />
                      </button>
                    ) : (
                      <button className="btn btn-primary" type="submit" aria-label="Send" disabled={!vmChatInput.trim()}>
                        <PaperAirplaneIcon size={16} />
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </aside>
          )}

          {leftTab === "explore" && preview !== null && (
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
                  <article className={repo.full_name === preview.name ? "side-card side-card-active" : "side-card"} key={repo.id}>
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

      {createOpen && (
        <div className="modal-backdrop" onClick={closeCreate}>
          <form
            className="modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              createVmSession();
            }}
          >
            <h2 className="modal-title">Create new session</h2>
            <label className="modal-field">
              GitHub repo <span className="muted">(optional)</span>
              <input className="form-control" value={newRepoUrl} placeholder="https://github.com/owner/name" spellCheck={false} autoFocus onChange={(event) => setNewRepoUrl(event.target.value)} />
            </label>
            <label className="modal-field">
              VM name <span className="muted">(optional)</span>
              <input className="form-control" value={newVmName} placeholder="my-vm" spellCheck={false} onChange={(event) => setNewVmName(event.target.value)} />
            </label>
            {vmOptions && (
              <div className="modal-grid">
                <label className="modal-field">
                  CPU
                  <select className="form-select" value={newCpus} onChange={(event) => setNewCpus(Number(event.target.value))}>
                    {vmOptions.cpus.map((cpus) => (
                      <option key={cpus} value={cpus}>
                        {cpus} cores
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  Memory
                  <select className="form-select" value={newMemoryGb} onChange={(event) => setNewMemoryGb(Number(event.target.value))}>
                    {vmOptions.memory_gb.map((gb) => (
                      <option key={gb} value={gb}>
                        {gb} GB
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  Disk
                  <select className="form-select" value={newDiskGb} onChange={(event) => setNewDiskGb(Number(event.target.value))}>
                    {vmOptions.disk_gb.map((gb) => (
                      <option key={gb} value={gb}>
                        {gb} GB
                      </option>
                    ))}
                  </select>
                </label>
                <label className="modal-field">
                  How many
                  <input
                    className="form-control"
                    type="number"
                    min={1}
                    max={vmOptions.count_max}
                    value={newCount}
                    onChange={(event) => setNewCount(Math.max(1, Math.min(vmOptions.count_max, Number(event.target.value) || 1)))}
                  />
                </label>
              </div>
            )}
            {vmOptions && newCount > 1 && (
              <p className="modal-note muted">
                Makes {newCount} sessions with these settings ({newCount * newMemoryGb} GB memory in total){newVmName ? `, named ${newVmName}-1 to ${newVmName}-${newCount}` : ""}.
              </p>
            )}
            {createError && <p className="modal-error">{createError}</p>}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={closeCreate}>
                Cancel
              </button>
              <button className="btn btn-primary" type="submit" disabled={createBusy || !vmOptions}>
                {createBusy ? "Creating…" : newCount > 1 ? `Create ${newCount}` : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
