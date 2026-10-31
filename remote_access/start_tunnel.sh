#!/usr/bin/env bash
# The SSH connection to the forwarder (README.md here): what reaches the server's ports 443 and 80 comes back
# through it to Caddy on this computer. It ends when the connection drops (after 45 quiet seconds, e.g. when the
# network changes); the service that runs it (set_up_laptop.sh) starts it again 5 seconds later.
cd "$(dirname "$0")/.."
# data/ is DATA_DIR: ~/seraph/data in the live copy (deploy/), data in the dev copy.
DATA=$(grep '^DATA_DIR=' .env | cut -d= -f2)

SERVER=$(grep '^REMOTE_ACCESS_SERVER=' .env | cut -d= -f2)
TUNNEL_USER=$(grep '^REMOTE_ACCESS_SERVER_USER=' .env | cut -d= -f2)
HTTPS_PORT=$(grep '^REMOTE_ACCESS_HTTPS_PORT=' .env | cut -d= -f2)
HTTP_PORT=$(grep '^REMOTE_ACCESS_HTTP_PORT=' .env | cut -d= -f2)

if [[ -z "$SERVER" ]]; then
    echo "REMOTE_ACCESS_SERVER in .env is empty: remote access isn't set up."
    exit 1
fi

# The server's own key was learned when set_up_server.sh first logged in, and must match from then on.
exec ssh -N \
    -i "$DATA/remote_access/tunnel_key" \
    -o IdentitiesOnly=yes \
    -o UserKnownHostsFile="$DATA/remote_access/known_hosts" \
    -o StrictHostKeyChecking=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=3 \
    -R "0.0.0.0:443:127.0.0.1:$HTTPS_PORT" \
    -R "0.0.0.0:80:127.0.0.1:$HTTP_PORT" \
    "$TUNNEL_USER@$SERVER"
