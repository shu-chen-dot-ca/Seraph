#!/usr/bin/env bash
# Sets up the forwarder, run from this computer once the server exists (README.md here). Safe to run again.
#
# It makes this computer's tunnel key (data/remote_access/tunnel_key) if there is none, then logs in to the server as
# its admin user (REMOTE_ACCESS_SERVER_ADMIN, with data/remote_access/admin_key) and sets it up so that the tunnel
# key, and only it, may open the server's ports 443 and 80 and send them back here. That key can do nothing else
# there: no shell, no other ports. The server runs nothing but SSH.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER=$(grep '^REMOTE_ACCESS_SERVER=' .env | cut -d= -f2)
TUNNEL_USER=$(grep '^REMOTE_ACCESS_SERVER_USER=' .env | cut -d= -f2)
ADMIN=$(grep '^REMOTE_ACCESS_SERVER_ADMIN=' .env | cut -d= -f2)

if [[ -z "$SERVER" ]]; then
    echo "Set REMOTE_ACCESS_SERVER in .env first: the server's address."
    exit 1
fi
if [[ ! -f data/remote_access/admin_key ]]; then
    echo "No data/remote_access/admin_key: the key the server was made with goes there."
    exit 1
fi

mkdir -p data/remote_access
chmod 700 data/remote_access
if [[ ! -f data/remote_access/tunnel_key ]]; then
    ssh-keygen -q -t ed25519 -N "" -C seraph-tunnel -f data/remote_access/tunnel_key
fi

# The first login learns the server's own key; start_tunnel.sh checks it from then on.
ssh -i data/remote_access/admin_key \
    -o IdentitiesOnly=yes \
    -o UserKnownHostsFile=data/remote_access/known_hosts \
    -o StrictHostKeyChecking=accept-new \
    "$ADMIN@$SERVER" sudo bash -s -- "$TUNNEL_USER" "'$(cat data/remote_access/tunnel_key.pub)'" <<'EOF'
set -euo pipefail
user=$1
key=$2

if ! id "$user" > /dev/null 2>&1; then
    useradd --create-home --shell /usr/sbin/nologin "$user"
fi

# The tunnel key may only open ports 443 and 80 and send them back: no shell, nothing else.
mkdir -p "/home/$user/.ssh"
echo "restrict,port-forwarding,permitlisten=\"0.0.0.0:443\",permitlisten=\"0.0.0.0:80\" $key" > "/home/$user/.ssh/authorized_keys"
chown -R "$user:" "/home/$user/.ssh"
chmod 700 "/home/$user/.ssh"
chmod 600 "/home/$user/.ssh/authorized_keys"

# Ports below 1024 need root otherwise. The server runs nothing else, so this is fine.
echo "net.ipv4.ip_unprivileged_port_start=80" > /etc/sysctl.d/90-seraph.conf
sysctl --quiet -p /etc/sysctl.d/90-seraph.conf

cat > /etc/ssh/sshd_config.d/90-seraph.conf <<CONF
# A connection that went quiet (the computer's network changed) is dropped after 45 seconds, so its ports are free
# again for the next one.
ClientAliveInterval 15
ClientAliveCountMax 3

Match User $user
    GatewayPorts clientspecified
    AllowTcpForwarding remote
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ForceCommand /usr/sbin/nologin
Match all
CONF
sshd -t
systemctl restart ssh
echo "The forwarder is set up."
EOF
