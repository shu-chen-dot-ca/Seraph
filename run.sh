#!/usr/bin/env bash
# Runs the code in this folder as you edit it, on the same data, VMs and agents as the live copy (.env is a link to
# ~/seraph/.env, deploy/install.sh): the backend restarts on every save, and Vite updates the page as you edit.
# Ctrl+C stops it. Only one of ./run.sh and ./live.sh (the installed release) runs at a time. Since this code isn't a
# release yet, your data is copied to ~/seraph/backups first.
cd "$(dirname "$0")"
set -m

if systemctl --user is-active --quiet seraph; then
    echo "The live copy runs (./live.sh): stop it first, they share the data and VMs."
    exit 1
fi
DATA=$(grep '^DATA_DIR=' .env | cut -d= -f2)
if [[ -d "$DATA" && "$DATA" == /* ]]; then
    BACKUPS="$(dirname "$DATA")/backups"
    mkdir -p "$BACKUPS"
    cp -a "$DATA" "$BACKUPS/$(date +%Y-%m-%d-%H%M%S)-run"
    # The last 10 copies stay (deploy/switch.sh keeps its own the same way).
    ls -1d "$BACKUPS"/*-run | head -n -10 | xargs -r rm -rf
fi

# Close the last run if it is still on the backend port or vite's 5173, so this run can take them.
# Only processes started from this folder: anything else on those ports is left alone.
PORT=$(grep '^BACKEND_PORT=' .env | cut -d= -f2)
LAST=""
for PID in $(lsof -t -iTCP:"${PORT:-8000}" -iTCP:5173 -sTCP:LISTEN); do
    if [[ "$(readlink /proc/"$PID"/cwd)" == "$PWD"* ]]; then
        LAST="$LAST $PID"
    fi
done
if [[ -n "$LAST" ]]; then
    echo "Closing the last run, still on its ports:$LAST"
    kill $LAST 2>/dev/null
    sleep 2
    kill -9 $LAST 2>/dev/null
fi

(cd frontend && npm install --no-audit --no-fund)

uv run serve &
BACKEND=$!
(cd frontend && npm run dev) &
FRONTEND=$!

trap 'kill -- -$BACKEND -$FRONTEND 2>/dev/null' EXIT
trap 'exit' INT TERM

wait -n
