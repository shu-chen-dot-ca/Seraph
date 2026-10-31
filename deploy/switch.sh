#!/usr/bin/env bash
# Puts release $1 live in ~/seraph. The app runs this with systemd-run (github_searcher/updates.py), outside itself,
# since it stops on the way: stop the app, copy data/ to backups/, point current at the release, start it. When it
# doesn't answer on /api/health within a minute, data/ and current go back and the release before starts again.
# $2, optional: a copy of data/ to put in place first (Previous version: data/ from before the update).
set -u
cd "$HOME/seraph"
NEW="$1"
RESTORE="${2:-}"
OLD=$(basename "$(readlink current)")
PORT=$(grep '^BACKEND_PORT=' .env | cut -d= -f2)
BACKUP="backups/$(date +%Y-%m-%d-%H%M%S)-$OLD"

rm -f failed
systemctl --user stop seraph
mkdir -p backups
cp -a data "$BACKUP"
if [[ -n "$RESTORE" ]]; then
    rm -rf data
    cp -a "$RESTORE" data
fi
ln -sfn "releases/$NEW" current
systemctl --user start seraph

for i in $(seq 60); do
    if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then
        echo "$OLD $BACKUP" > previous
        # The last 10 copies of data/ stay.
        ls -1d backups/* | head -n -10 | xargs -r rm -rf
        exit 0
    fi
    sleep 1
done

# It didn't start: everything back as it was.
echo "$NEW didn't answer within a minute: going back to $OLD."
systemctl --user stop seraph
rm -rf data
cp -a "$BACKUP" data
ln -sfn "releases/$OLD" current
echo "$NEW" > failed
systemctl --user start seraph
