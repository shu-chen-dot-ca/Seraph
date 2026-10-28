"""The Search page: find a repo on GitHub by a word or two of its name, and add it to Repos by hand.

GET /api/search asks GitHub's repo search the way the search box on github.com does (search.py find_repositories):
best match first, over names, descriptions and topics, so it isn't strict ("openclaw", "ib async", "fastapi"). On top:
- owner/name, or a GitHub link to a repo, is looked up directly and comes first; its name alone is searched too;
- a single word is also tried as word/word (openclaw → openclaw/openclaw), what a project's own org is often called;
- several words that find nothing are tried again as any of them (OR).
At most 30, without forks (GitHub's search leaves them out).

Add on the page puts one in Repos through the Repos page's own POST /api/repos/add (repos_api.add_repo).
"""

import re

import httpx
from fastapi import APIRouter, HTTPException

from github_searcher.search import find_repositories, get_repository

router = APIRouter(prefix="/api")


@router.get("/search")
def search_repos(q: str) -> dict:
    """Repos on GitHub that match the text, the best match first."""
    text = q.strip()
    if text == "":
        raise HTTPException(status_code=400, detail="Type a repo's name, a word or two.")

    # owner/name or a link to the repo (or to a page inside it).
    name = text.removeprefix("https://").removeprefix("http://").removeprefix("www.").removeprefix("github.com/")
    name = "/".join(name.removesuffix("/").removesuffix(".git").split("/")[:2])
    lookups = []
    query = text
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name):
        lookups.append(name)
        query = name.split("/")[1]
    elif re.fullmatch(r"[A-Za-z0-9_.-]+", text):
        lookups.append(f"{text}/{text}")

    found = []
    try:
        for each in lookups:
            try:
                found.append(get_repository(each.split("/")[0], each.split("/")[1]))
            except httpx.HTTPStatusError as error:
                if error.response.status_code != 404:
                    raise
        items = find_repositories(query)["items"]
        if not items and len(query.split()) > 1:
            items = find_repositories(" OR ".join(query.split()))["items"]
    except httpx.HTTPStatusError as error:
        raise HTTPException(status_code=502, detail=f"GitHub error {error.response.status_code}: {error.response.text[:200]}")
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Could not reach GitHub: {error}")

    results = []
    seen = []
    for info in found + items:
        if info["full_name"].lower() in seen:
            continue
        seen.append(info["full_name"].lower())
        results.append(
            {
                "full_name": info["full_name"],
                "description": info["description"] or "",
                "stars": info["stargazers_count"],
                "language": info["language"],
                "pushed_at": info["pushed_at"],
                "archived": info["archived"],
                "html_url": info["html_url"],
            }
        )
    return {"results": results}
