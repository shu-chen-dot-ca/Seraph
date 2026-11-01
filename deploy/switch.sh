#!/usr/bin/env bash
# Puts release $1 live in ~/seraph. The app runs this with systemd-run (github_searcher/updates.py), outside itself,
# since it stops on the way: stop the app, copy data/ to backups/, point current at the release, start it. When it
# doesn't answer on /api/health within a minute, data/ and current go back and the release before starts again.
# $2, optional: a copy of data/ to put in place first (Previous version: data/ from before the update).
#
# Then it watches the release for its first WATCH_SECONDS: when /api/health stops answering for DOWN_LIMIT checks in a
# row (a minute), or its "errors" (what the app reported since it started, github_searcher/crashes.py) reach
# ERROR_LIMIT, it goes back the same way. Before that, what the release reported is kept in failed-crashes.json, and
# the release before reports it once it runs (so it becomes an issue); failed and failed-reason say which and why.
# Another switch meanwhile (current points elsewhere) ends the watch.
set -u
cd "$HOME/seraph"
NEW="$1"
RESTORE="${2:-}"
OLD=$(basename "$(readlink current)")
PORT=$(grep '^BACKEND_PORT=' .env | cut -d= -f2)
BACKUP="backups/$(date +%Y-%m-%d-%H%M%S)-$OLD"
PREVIOUS_BEFORE=$(cat previous 2>/dev/null || true)
WATCH_SECONDS=600
DOWN_LIMIT=6
ERROR_LIMIT=3

# Everything back as it was before this switch, with why ($1).
go_back() {
    echo "Going back to $OLD: $1"
    if [[ -f data/crashes.json ]]; then
        python3 - "$NEW" "$1" <<'EOF' > failed-crashes.json
import json, sys
crashes = json.load(open("data/crashes.json"))
print(json.dumps({"tag": sys.argv[1], "reason": sys.argv[2], "crashes": [item for item in crashes if item["version"] == sys.argv[1]]}))
EOF
    else
        echo "{\"tag\": \"$NEW\", \"reason\": \"$1\", \"crashes\": []}" > failed-crashes.json
    fi
    systemctl --user stop seraph
    rm -rf data
    cp -a "$BACKUP" data
    ln -sfn "releases/$OLD" current
    echo "$NEW" > failed
    echo "$1" > failed-reason
    if [[ -n "$PREVIOUS_BEFORE" ]]; then
        echo "$PREVIOUS_BEFORE" > previous
    else
        rm -f previous
    fi
    systemctl --user start seraph
    exit 0
}

rm -f failed failed-reason
systemctl --user stop seraph
mkdir -p backups
cp -a data "$BACKUP"
if [[ -n "$RESTORE" ]]; then
    rm -rf data
    cp -a "$RESTORE" data
fi
ln -sfn "releases/$NEW" current
systemctl --user start seraph

STARTED=""
for i in $(seq 60); do
    if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then
        STARTED="yes"
        echo "$OLD $BACKUP" > previous
        # The last 10 copies of data/ stay.
        ls -1d backups/* | head -n -10 | xargs -r rm -rf
        break
    fi
    sleep 1
done
if [[ -z "$STARTED" ]]; then
    go_back "it didn't answer within a minute"
fi

DOWN=0
for i in $(seq $((WATCH_SECONDS / 10))); do
    sleep 10
    if [[ "$(basename "$(readlink current)")" != "$NEW" ]]; then
        exit 0
    fi
    HEALTH=$(curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/health" || true)
    if [[ -z "$HEALTH" ]]; then
        DOWN=$((DOWN + 1))
        if [[ $DOWN -ge $DOWN_LIMIT ]]; then
            go_back "it stopped answering for a minute"
        fi
        continue
    fi
    DOWN=0
    ERRORS=$(echo "$HEALTH" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("errors", 0))')
    if [[ $ERRORS -ge $ERROR_LIMIT ]]; then
        go_back "it reported $ERRORS errors in its first minutes"
    fi
done
