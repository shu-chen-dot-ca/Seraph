#!/usr/bin/env bash
# This computer's half of remote access (README.md here), on Linux with systemd. Run it after set_up_server.sh, once
# the domain points at the server. Safe to run again (also after moving this folder).
#
# It makes two services of your own user, seraph-caddy (start_caddy.sh) and seraph-tunnel (start_tunnel.sh). Each
# starts with your session, and again 5 seconds after it stops. On a Mac or Windows the same two scripts would run
# under launchd or as a Windows service instead.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v caddy > /dev/null; then
    echo "Install Caddy first: sudo dnf install caddy (Fedora), or see https://caddyserver.com/docs/install"
    exit 1
fi
if [[ ! -f data/remote_access/tunnel_key ]]; then
    echo "No tunnel key yet: run remote_access/set_up_server.sh first."
    exit 1
fi

mkdir -p ~/.config/systemd/user
for NAME in caddy tunnel; do
    cat > ~/.config/systemd/user/seraph-$NAME.service <<EOF
[Unit]
Description=Seraph remote access: $NAME ($PWD/remote_access/start_$NAME.sh)
After=network-online.target

[Service]
ExecStart=$PWD/remote_access/start_$NAME.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
done

systemctl --user daemon-reload
systemctl --user enable seraph-caddy seraph-tunnel
systemctl --user restart seraph-caddy seraph-tunnel
echo "Running. Logs: journalctl --user -u seraph-caddy -u seraph-tunnel -f"
