import { ArchiveIcon, ChevronLeftIcon, CodeIcon, FileDirectoryFillIcon, FileIcon, GitBranchIcon, GitCommitIcon, LawIcon, LinkExternalIcon, LinkIcon, RepoForkedIcon, StarIcon } from "@primer/octicons-react";
import { useEffect, useState, type MouseEvent, type RefObject } from "react";

import type { Repo } from "./Explore";

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

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

// One repo opened in the results area: its details, files, README and commits.
export default function RepoPreview(props: { name: string; scrollBox: RefObject<HTMLDivElement | null>; onClose: () => void; onError: (message: string) => void }) {
  const [preview, setPreview] = useState<Preview>({ name: props.name, repo: null, path: "", contents: null, trail: [], branch: "", branches: [], view: "code", commits: null });

  // Opened: load the repo's root folder on its default branch.
  useEffect(() => {
    loadContents(props.name, null, "", [], "", []);
    // Only once: a new repo gets a new RepoPreview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadContents(name: string, repo: Repo | null, path: string, trail: string[], branch: string, branches: string[]) {
    setPreview({ name: name, repo: repo, path: path, contents: null, trail: trail, branch: branch, branches: branches, view: "code", commits: null });
    props.scrollBox.current?.scrollTo(0, 0);
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
      props.onClose();
      props.onError(`Could not open ${name}/${path}: ${err instanceof Error ? err.message : err}`);
    }
  }

  function openPath(path: string) {
    loadContents(preview.name, preview.repo, path, [...preview.trail, preview.path], preview.branch, preview.branches);
  }

  function switchBranch(branch: string) {
    loadContents(preview.name, preview.repo, "", [], branch, preview.branches);
  }

  async function showCommits() {
    const name = preview.name;
    setPreview({ ...preview, view: "commits", commits: null });
    try {
      const response = await fetch(`/api/repo/${name}/commits?${new URLSearchParams({ ref: preview.branch, path: preview.path })}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.detail);
      }
      setPreview((current) => (current.name === name && current.view === "commits" ? { ...current, commits: body.commits } : current));
    } catch (err) {
      setPreview((current) => ({ ...current, view: "code" }));
      props.onError(`Could not load commits of ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  function goBack() {
    if (preview.trail.length === 0) {
      props.onClose();
      return;
    }
    loadContents(preview.name, preview.repo, preview.trail[preview.trail.length - 1], preview.trail.slice(0, -1), preview.branch, preview.branches);
  }

  function onReadmeClick(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) {
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

  return (
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
  );
}
