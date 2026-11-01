#!/usr/bin/env bash
# Once: makes the live copy of Seraph in ~/seraph from release $1 (a tag of this repo, e.g. v0.1.0) and moves data/
# there. ./live.sh runs it from then on (the user service seraph, never started by itself), and it updates from Update
# in the app's header. Run it from this folder, with ./run.sh stopped. README.md (Live copy and updates) has what changes.
#
# After it:
#   ~/seraph/current -> releases/$1    the live copy (./live.sh): http://localhost:$BACKEND_PORT (8001), and remote access
#   ~/seraph/data, ~/seraph/.env       data/ and .env moved there (DATA_DIR, SERAPH_REPO set)
#   this folder                        ./run.sh, your working code, on the same data, VMs and port: .env is a link to
#                                      ~/seraph/.env. One of the two runs at a time.
set -eu
cd "$(dirname "$0")/.."
DEV="$PWD"
TAG="${1:-}"
LIVE="$HOME/seraph"
PORT=$(grep '^BACKEND_PORT=' .env | cut -d= -f2)

if [[ -z "$TAG" ]]; then
    echo "Usage: deploy/install.sh <tag>, e.g. deploy/install.sh v0.1.0"
    exit 1
fi
if [[ -e "$LIVE" ]]; then
    echo "$LIVE already exists."
    exit 1
fi
if ! git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
    echo "There is no tag $TAG here. Make the release on GitHub, then git fetch --tags."
    exit 1
fi
# Only 127.0.0.1, where the app listens: something else on another address (a k3s pod on 10.42.0.1) doesn't clash.
if lsof -t -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN > /dev/null; then
    echo "Port $PORT is in use: stop ./run.sh first."
    exit 1
fi
REPO=$(git remote get-url origin | sed -E 's#.*github\.com[:/]##; s#\.git$##')

# The release, made the way github_searcher/updates.py makes one from GitHub's archive.
echo "Making $TAG ready in $LIVE/releases/$TAG ..."
mkdir -p "$LIVE/releases/$TAG"
git archive "$TAG" | tar -x -C "$LIVE/releases/$TAG"
ln -s "$LIVE/.env" "$LIVE/releases/$TAG/.env"
(cd "$LIVE/releases/$TAG" && env -u VIRTUAL_ENV uv sync --frozen --no-dev)
(cd "$LIVE/releases/$TAG/frontend" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules)
echo "$TAG" > "$LIVE/releases/$TAG/VERSION"
ln -s "releases/$TAG" "$LIVE/current"

# .env: the live copy's data/ is ~/seraph/data, and it knows its repo, to look for releases in. This folder's .env
# becomes a link to it: ./run.sh uses the same data, VMs and port.
sed -e "s#^DATA_DIR=.*#DATA_DIR=$LIVE/data#" .env > "$LIVE/.env"
echo "SERAPH_REPO=$REPO" >> "$LIVE/.env"
chmod 600 "$LIVE/.env"
mv .env "$LIVE/env-before-install"
ln -s "$LIVE/.env" .env

# data/ moves. The agents' conversations are kept by Claude Code under a name made from their folder's path
# (data/agent_home, ...): copied to the new path's name, so every agent carries on its conversation.
mv data "$LIVE/data"
OLD_NAME=$(echo "$DEV/data" | sed 's/[^a-zA-Z0-9]/-/g')
NEW_NAME=$(echo "$LIVE/data" | sed 's/[^a-zA-Z0-9]/-/g')
shopt -s nullglob
for FOLDER in "$HOME/.claude/projects/$OLD_NAME"-*; do
    cp -a "$FOLDER" "$HOME/.claude/projects/$NEW_NAME${FOLDER#"$HOME/.claude/projects/$OLD_NAME"}"
done

# The live copy's service: ./live.sh starts it; nothing else does. Remote access stays run from this folder, and shows
# whichever copy runs.
mkdir -p "$HOME/.config/systemd/user"
cp deploy/seraph.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload

echo "Seraph $TAG is installed. ./live.sh runs it at http://localhost:$PORT; ./run.sh runs your working code instead."
