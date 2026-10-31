#!/usr/bin/env bash
# Runs Caddy for remote access (the Caddyfile here), with its values from .env. The service that runs it
# (set_up_laptop.sh) starts it again whenever it stops. Its certificates and state go in data/remote_access.
cd "$(dirname "$0")/.."
# data/ is DATA_DIR: ~/seraph/data in the live copy (deploy/), data in the dev copy.
DATA=$(grep '^DATA_DIR=' .env | cut -d= -f2)

export REMOTE_ACCESS_DOMAIN=$(grep '^REMOTE_ACCESS_DOMAIN=' .env | cut -d= -f2)
export REMOTE_ACCESS_HTTPS_PORT=$(grep '^REMOTE_ACCESS_HTTPS_PORT=' .env | cut -d= -f2)
export REMOTE_ACCESS_HTTP_PORT=$(grep '^REMOTE_ACCESS_HTTP_PORT=' .env | cut -d= -f2)
export BACKEND_PORT=$(grep '^BACKEND_PORT=' .env | cut -d= -f2)
# The app's own files: the live copy's backend serves its built page (it has a VERSION file); the dev copy's come
# from Vite.
export PAGE_PORT=5173
if [[ -f VERSION ]]; then
    export PAGE_PORT=$BACKEND_PORT
fi
export XDG_DATA_HOME="$(realpath "$DATA")/remote_access"
export XDG_CONFIG_HOME="$(realpath "$DATA")/remote_access"

if [[ -z "$REMOTE_ACCESS_DOMAIN" ]]; then
    echo "REMOTE_ACCESS_DOMAIN in .env is empty: remote access isn't set up."
    exit 1
fi

exec caddy run --config remote_access/Caddyfile --adapter caddyfile
