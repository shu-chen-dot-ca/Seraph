- Write boring, simple codes, even if it will take extra lines and decrease efficientcy.
- Do not write helper function unless not having it will increase 100+ lines.
- Use minimum and most simple way to code, if 2 intend maximum don't use 3 intend.
- Keep most tasks short and do not run anything. Never keep me waiting and you go to run a long check or test without me saying doing that. Only run things for long periods of time if i say "build the whole thing", or "build until it's working"
- Don't create __init__.py if not nessasary, if its nessasary do not create it with content. Only if it is a must or break then __init__.py can be filled.

- Name things the way an established product would: plain, common names people already know (Inbox, Pull requests, Issues, Settings, Account, Open, Closed, Approve, Reject). No made-up or cute labels like "Needs you" or "Everything". This goes for pages, tabs, buttons, sections and messages.

- Core folders are github_searcher/ and sandbox/. Do not change that without my knowledge. If we are working on something outside of those folders andn you have to change it, ask me first.

- Commit messages use Conventional Commits: `type(scope): short summary`, one line only.
  - Types: feat, fix, refactor, docs, style, test, chore, perf. Scope is the area changed (sandbox, search, agents, frontend, images, ...).
  - Every commit has exactly one scope. If a change covers more than one area, split it into one commit per area.
  - Imperative mood ("add X", not "added X"), lowercase, no period, under 72 characters.
  - No body or description, just the summary line.
  - No Co-Authored-By line or any other attribution.

- I commit with "save" while I work. Only when I say "consolidate commits", clean them up. Otherwise don't touch commits.
  - Which commits: from the oldest one that doesn't follow the format above, up to HEAD.
  - Read what every one of them changes, then plan new commits that follow the rules above: one feature and one scope each. Split a commit that does many things, merge commits that are the same work, and drop things that were added and then deleted.
  - Show me the list of new commits first. Don't change .git until I approve.
  - Never touch my working files or index, I might be in the middle of something. Build the commits with a temp index (GIT_INDEX_FILE) and git commit-tree, keep the author and dates, then move main with git update-ref.
  - The last new commit must have exactly the same files as the old HEAD. Check that before moving main, and that git status is the same after.
  - Save the old main as a backup branch first (backup/main-before-<date>).
  - Local only, never push. I push myself.
Do not use claude artifact