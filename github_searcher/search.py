import os
import posixpath
import re
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

load_dotenv()

# Preview data (repo info, files, READMEs, branches, commits) by request, so opening
# a repo again is instant. The chat agent clears it when a chat session starts.
CACHE = {}


def search_repositories(q: str, sort: str | None = None, order: str = "desc", per_page: int = 100, page: int = 1) -> dict:
    params = {"q": q, "order": order, "per_page": per_page, "page": page}
    if sort:
        params["sort"] = sort

    response = httpx.get(
        "https://api.github.com/search/repositories",
        params=params,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def get_repository(owner: str, repo: str) -> dict:
    key = ("repository", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = httpx.get(
        f"https://api.github.com/repos/{owner}/{repo}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]



def get_contents(owner: str, repo: str, path: str, ref: str = "") -> dict | list:
    key = ("contents", owner, repo, path, ref)
    if key in CACHE:
        return CACHE[key]

    response = httpx.get(
        f"https://api.github.com/repos/{owner}/{repo}/contents/{quote(path)}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        params={"ref": ref} if ref else None,
        timeout=30,
    )
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]


def get_contents_html(owner: str, repo: str, path: str, ref: str = "") -> str:
    key = ("contents_html", owner, repo, path, ref)
    if key in CACHE:
        return CACHE[key]

    response = httpx.get(
        f"https://api.github.com/repos/{owner}/{repo}/contents/{quote(path)}",
        headers={
            "Accept": "application/vnd.github.html+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        params={"ref": ref} if ref else None,
        timeout=30,
    )
    response.raise_for_status()
    html = response.text

    # GitHub leaves relative paths as written in the markdown, so point them at the real repo files.
    folder = posixpath.dirname(path)
    branch = ref or "HEAD"
    for attribute, url in set(re.findall(r' (src|srcset|href)="([^"]*)"', html)):
        if url.startswith(("http:", "https:", "#", "mailto:", "data:", "//")):
            continue
        if url.startswith("/"):
            new_url = "https://github.com" + url
        elif attribute == "href":
            new_url = f"https://github.com/{owner}/{repo}/blob/{branch}/" + posixpath.normpath(posixpath.join(folder, url))
        else:
            new_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/" + posixpath.normpath(posixpath.join(folder, url))
        html = html.replace(f' {attribute}="{url}"', f' {attribute}="{new_url}"')
    CACHE[key] = html
    return CACHE[key]


def get_readme(owner: str, repo: str) -> str:
    key = ("readme", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = httpx.get(
        f"https://api.github.com/repos/{owner}/{repo}/readme",
        headers={
            "Accept": "application/vnd.github.raw+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )
    response.raise_for_status()
    CACHE[key] = response.text
    return CACHE[key]


def get_branches(owner: str, repo: str) -> list:
    key = ("branches", owner, repo)
    if key in CACHE:
        return CACHE[key]

    response = httpx.get(
        f"https://api.github.com/repos/{owner}/{repo}/branches",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        params={"per_page": 100},
        timeout=30,
    )
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]


def get_commits(owner: str, repo: str, ref: str, path: str) -> list:
    key = ("commits", owner, repo, ref, path)
    if key in CACHE:
        return CACHE[key]

    params = {"per_page": 30}
    if ref:
        params["sha"] = ref
    if path:
        params["path"] = path
    response = httpx.get(
        f"https://api.github.com/repos/{owner}/{repo}/commits",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    CACHE[key] = response.json()
    return CACHE[key]
