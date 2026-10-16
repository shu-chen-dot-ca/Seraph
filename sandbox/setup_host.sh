#!/usr/bin/env bash
# One-time setup of this machine for repo sandboxes (Fedora). Needs root:
#
#     sudo sandbox/setup_host.sh
#
# Installs Incus (KVM virtual machines with an API) and creates what every
# sandbox VM uses:
#   - network  sandboxbr0      NAT bridge, IPv4 only
#   - ACL      sandbox-egress  the VMs reach the internet, but not this machine
#                              or anything on the local network
#   - profile  sandbox         root disk + a NIC on sandboxbr0
# Safe to run again: existing pieces are kept and updated.
#
# Afterwards log out and back in (so your user is in the incus-admin group),
# then build the base image with sandbox/image/build.sh.

set -euo pipefail

NETWORK=sandboxbr0
ACL=sandbox-egress
PROFILE=sandbox
POOL=default

# Addresses the VMs may not reach: this machine (its bridge address is in
# 10.0.0.0/8), private networks, link-local (cloud metadata), CGNAT (Tailscale),
# loopback, multicast and reserved ranges. DNS and DHCP to the bridge still work:
# Incus allows those before any ACL rule.
BLOCKED_RANGES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,0.0.0.0/8,127.0.0.0/8,224.0.0.0/4,240.0.0.0/4

if [[ $EUID -ne 0 ]]; then
    echo "Run this with sudo: sudo $0" >&2
    exit 1
fi

echo "==> Installing Incus"
dnf install -y incus incus-agent qemu-kvm edk2-ovmf
systemctl enable --now incus.socket incus.service

if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
    echo "==> Adding $SUDO_USER to incus-admin"
    usermod -aG incus-admin "$SUDO_USER"
fi

echo "==> Storage pool '$POOL'"
# 'dir' keeps each VM disk in a plain file. Incus advises against VMs on btrfs pools.
if ! incus storage show "$POOL" >/dev/null 2>&1; then
    incus storage create "$POOL" dir
fi

echo "==> Network '$NETWORK'"
if ! incus network show "$NETWORK" >/dev/null 2>&1; then
    incus network create "$NETWORK" ipv4.address=auto ipv4.nat=true ipv6.address=none
fi

echo "==> Network ACL '$ACL'"
if ! incus network acl show "$ACL" >/dev/null 2>&1; then
    incus network acl create "$ACL"
fi
incus network acl edit "$ACL" <<EOF
description: Sandbox VMs reach the internet, but not this machine or the local network
egress:
- action: reject
  destination: $BLOCKED_RANGES
  state: enabled
ingress: []
EOF
# Everything not rejected above is allowed, including this machine connecting
# to the VMs (the backend's preview proxy).
incus network set "$NETWORK" \
    security.acls="$ACL" \
    security.acls.default.egress.action=allow \
    security.acls.default.ingress.action=allow

echo "==> Profile '$PROFILE'"
if ! incus profile show "$PROFILE" >/dev/null 2>&1; then
    incus profile create "$PROFILE"
fi
incus profile edit "$PROFILE" <<EOF
description: Repo sandbox VMs (see sandbox/setup_host.sh)
config: {}
devices:
  root:
    type: disk
    path: /
    pool: $POOL
  eth0:
    type: nic
    name: eth0
    network: $NETWORK
EOF

if systemctl is-active --quiet firewalld; then
    echo "==> firewalld: letting Incus manage $NETWORK"
    # As the Incus docs advise: firewalld trusts the bridge, and the ACL above
    # decides what the VMs may reach.
    firewall-cmd --permanent --zone=trusted --change-interface="$NETWORK"
    firewall-cmd --reload
fi

cat <<EOF

Done. Next:
  1. Log out and back in, so your user is in the incus-admin group
     (or prefix commands with: sg incus-admin -c "...").
  2. Build the base image (about 10 minutes):  sandbox/image/build.sh
EOF
