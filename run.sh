#!/usr/bin/env bash
cd "$(dirname "$0")"
set -m

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
