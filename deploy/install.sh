#!/usr/bin/env bash
# Once: makes the live copy of Seraph in ~/seraph from release $1 (a tag of this repo, e.g. v0.1.0), moves data/
# there and starts it as the user service seraph. From then on it updates from Update in the app's header.
# Run it from this folder, with ./run.sh stopped. README.md (Live copy and updates) has what changes.
#
# After it:
#   ~/seraph/current -> releases/$1    the live copy, http://localhost:$BACKEND_PORT (8001), and remote access
#   ~/seraph/data, ~/seraph/.env       data/ and .env moved and copied there (DATA_DIR, SERAPH_REPO set)
#   this folder                        the dev copy: ./run.sh on port 8002 and Vite's 5173, an empty data/, VMs named dev-...
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
if lsof -t -iTCP:"$PORT" -sTCP:LISTEN > /dev/null; then
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

# .env: the live copy's data/ is ~/seraph/data, and it knows its repo, to look for releases in.
sed -e "s#^DATA_DIR=.*#DATA_DIR=$LIVE/data#" .env > "$LIVE/.env"
echo "SERAPH_REPO=$REPO" >> "$LIVE/.env"
chmod 600 "$LIVE/.env"

# data/ moves. The agents' conversations are kept by Claude Code under a name made from their folder's path
# (data/agent_home, ...): copied to the new path's name, so every agent carries on its conversation.
mv data "$LIVE/data"
mkdir data
OLD_NAME=$(echo "$DEV/data" | sed 's/[^a-zA-Z0-9]/-/g')
NEW_NAME=$(echo "$LIVE/data" | sed 's/[^a-zA-Z0-9]/-/g')
shopt -s nullglob
for FOLDER in "$HOME/.claude/projects/$OLD_NAME"-*; do
    cp -a "$FOLDER" "$HOME/.claude/projects/$NEW_NAME${FOLDER#"$HOME/.claude/projects/$OLD_NAME"}"
done

# The dev copy gets its own port, and VM names of its own, so it never drives the live copy's VMs.
sed -i -e 's/^BACKEND_PORT=.*/BACKEND_PORT=8002/' -e 's/^SANDBOX_VM_PREFIX=.*/SANDBOX_VM_PREFIX=dev-/' .env

# The services: the app, and remote access (if it is set up) from the live copy.
mkdir -p "$HOME/.config/systemd/user"
cp deploy/seraph.service "$HOME/.config/systemd/user/"
for UNIT in seraph-caddy seraph-tunnel; do
    if [[ -f "$HOME/.config/systemd/user/$UNIT.service" ]]; then
        sed -i "s#$DEV/remote_access#$LIVE/current/remote_access#g" "$HOME/.config/systemd/user/$UNIT.service"
    fi
done
systemctl --user daemon-reload
systemctl --user enable --now seraph
for UNIT in seraph-caddy seraph-tunnel; do
    if [[ -f "$HOME/.config/systemd/user/$UNIT.service" ]]; then
        systemctl --user restart "$UNIT"
    fi
done

echo "Seraph $TAG runs at http://localhost:$PORT. The dev copy (./run.sh) is at http://localhost:5173 now."
