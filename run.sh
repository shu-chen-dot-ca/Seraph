#!/usr/bin/env bash
cd "$(dirname "$0")"
set -m

(cd frontend && npm install --no-audit --no-fund)

uv run serve &
BACKEND=$!
(cd frontend && npm run dev) &
FRONTEND=$!

trap 'kill -- -$BACKEND -$FRONTEND 2>/dev/null' EXIT
trap 'exit' INT TERM

wait -n
