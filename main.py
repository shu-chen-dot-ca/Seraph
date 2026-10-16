"""Development entry point: chat with the filter agent in the terminal.

    uv run main.py

Type a request and the agent sets the filters; /search runs them, like the Search button.
Commands: /search runs the search, /new starts a new conversation, /quit exits.
"""

import asyncio
import logging

from github_searcher.agent.agent import SearchChatAgent
from github_searcher.search import (
    GitHubClient,
    GitHubError,
    GitHubFilters,
    InvalidFiltersError,
    find_repos,
    load_settings,
)


async def run() -> None:
    settings = load_settings()
    logging.basicConfig(level=settings.log_level, format="%(levelname)s %(name)s: %(message)s")

    with GitHubClient(
        token=settings.github_token,
        graphql_url=settings.github_graphql_url,
        timeout_seconds=settings.http_timeout_seconds,
    ) as client:
        agent = SearchChatAgent()
        await agent.start()
        filters = GitHubFilters()

        print("Describe the repos you want. /search runs the search, /new starts over, /quit exits.\n")
        while True:
            message = input("you> ").strip()
            if message == "/quit":
                await agent.stop()
                break
            if message == "/new":
                await agent.stop()
                agent = SearchChatAgent()
                await agent.start()
                filters = GitHubFilters()
                print("New conversation.\n")
                continue
            if message == "/search":
                print_search(client, filters, settings.search_max_candidates)
                continue
            if not message:
                continue

            print()
            await agent.run(message)
            print(f"\n(tokens: {agent.tokens:,}, cost: ${agent.cost:.4f})\n")


def print_search(client: GitHubClient, filters: GitHubFilters, max_candidates: int) -> None:
    try:
        result = find_repos(client, filters, max_candidates)
    except (InvalidFiltersError, GitHubError) as error:
        print(f"Can't search: {error}\n")
        return

    print(f"Query: {result.github_query}")
    print(f"{len(result.repos)} downloaded, {result.total_matches:,} matched on GitHub")
    for repo in result.repos[:10]:
        print(f"  ★ {repo.stars:>7,}  {repo.full_name}")
    print()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
