#!/usr/bin/env bash
# Runs the live copy: the release installed in ~/seraph (deploy/install.sh), on your data, VMs and agents, at
# http://localhost:8001 and your remote access address. It shows the app's log here; Ctrl+C stops it. Nothing starts
# it otherwise, not even a reboot.
#
# It runs as the user service seraph (deploy/seraph.service), so Update in the app can switch it to a new release
# while it runs (deploy/switch.sh). ~/seraph/stopped tells switch.sh you stopped it, so it never starts it again.
# ./run.sh (your working code) uses the same data, VMs and port: only one of the two runs at a time.
cd "$(dirname "$0")"
LIVE="$HOME/seraph"
PORT=$(grep '^BACKEND_PORT=' .env | cut -d= -f2)

if [[ ! -L "$LIVE/current" ]]; then
    echo "There is no live copy yet: deploy/install.sh <tag> makes it."
    exit 1
fi
if systemctl --user is-active --quiet seraph; then
    echo "The live copy runs already (another ./live.sh?)."
    exit 1
fi
if lsof -t -iTCP@127.0.0.1:"$PORT" -sTCP:LISTEN > /dev/null; then
    echo "Something runs on port $PORT already: stop ./run.sh first."
    exit 1
fi

rm -f "$LIVE/stopped"
systemctl --user start seraph
echo "Seraph $(cat "$LIVE/current/VERSION") runs at http://localhost:$PORT. Ctrl+C stops it."

trap 'touch "$LIVE/stopped"; echo "Stopping..."; systemctl --user stop seraph' EXIT
trap 'exit' INT TERM HUP
journalctl --user -u seraph -f -n 0 --output=cat
