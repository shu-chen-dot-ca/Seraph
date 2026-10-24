#!/usr/bin/env bash
# Build an image VMs can start from:
#
#     sandbox/image/build.sh [name] [recipe folder]
#
# SANDBOX_BUILD_FROM (Ubuntu 24.04 desktop) + the tools in provision.sh + the
# Python packages in python-packages.txt, published as name (default
# SANDBOX_BUILD_NAME). Those two files come from the recipe folder: this one by
# default. The VMs page's Images tab runs this too, with the image's own recipe
# (a copy of these two files that the image's agent may have changed).
# Takes about 45-60 minutes (PyTorch and the ML caches are big). Run it again to update the image; VMs that
# already exist keep their own disk.
#
# Settings come from the SANDBOX_* lines of the project's .env. Only the
# SANDBOX_VM_* values are passed into the VM; nothing else (no tokens) goes in.
#
# No SSH: files go in with `incus file push`, commands run with `incus exec`.
# Needs Incus access (the incus-admin group) and the SANDBOX_PROFILE profile.

set -euo pipefail
cd "$(dirname "$0")"

# Read only the SANDBOX_* lines of .env, never the rest of it.
source <(grep -E '^SANDBOX_[A-Z_]+=' ../../.env)

BUILDER=$SANDBOX_BUILD_VM
NAME=${1:-$SANDBOX_BUILD_NAME}
RECIPE=${2:-.}

# Whatever happens, don't leave the builder VM behind.
trap 'incus delete --force "$BUILDER" >/dev/null 2>&1 || true' EXIT

echo "==> Starting the builder VM"
incus delete --force "$BUILDER" >/dev/null 2>&1 || true
incus launch "$SANDBOX_BUILD_FROM" "$BUILDER" --vm --profile "$SANDBOX_PROFILE" \
    --config limits.cpu="$SANDBOX_BUILD_CPUS" \
    --config limits.memory="$SANDBOX_BUILD_MEMORY" \
    --device root,size="$SANDBOX_BUILD_DISK"

echo "==> Waiting for the VM agent"
for _ in $(seq 150); do
    if incus exec "$BUILDER" -- true >/dev/null 2>&1; then
        break
    fi
    sleep 2
done
# fwupd crashes VMs on this host (see VM.guard_shadow_stack in sandbox/vm.py); keep it
# from starting during the hour-long build, before provision.sh turns it off for good.
incus exec "$BUILDER" -- systemctl mask --now fwupd.service fwupd-refresh.service fwupd-refresh.timer

echo "==> Provisioning"
incus file push "$RECIPE/provision.sh" "$RECIPE/python-packages.txt" "$BUILDER/root/"
incus exec "$BUILDER" \
    --env SANDBOX_VM_NODE_MAJOR="$SANDBOX_VM_NODE_MAJOR" \
    --env SANDBOX_VM_FALLBACK_USER="$SANDBOX_VM_FALLBACK_USER" \
    --env SANDBOX_VM_PY_VENV="$SANDBOX_VM_PY_VENV" \
    --env SANDBOX_VM_RUST_DIR="$SANDBOX_VM_RUST_DIR" \
    --env SANDBOX_VM_PLAYWRIGHT_DIR="$SANDBOX_VM_PLAYWRIGHT_DIR" \
    --env SANDBOX_VM_DEMO_DIR="$SANDBOX_VM_DEMO_DIR" \
    --env SANDBOX_VM_NOVNC_PORT="$SANDBOX_VM_NOVNC_PORT" \
    --env SANDBOX_VM_TERMINAL_PORT="$SANDBOX_VM_TERMINAL_PORT" \
    --env SANDBOX_VM_VNC_PORT="$SANDBOX_VM_VNC_PORT" \
    --env SANDBOX_VM_DOCKER_IMAGES="$SANDBOX_VM_DOCKER_IMAGES" \
    -- bash /root/provision.sh

echo "==> Publishing the image as '$NAME'"
incus stop "$BUILDER"
# Uncompressed: bigger on disk, but new VMs unpack it faster.
incus publish "$BUILDER" --alias "$NAME" --reuse --compression none

echo "==> Built '$NAME'. Pick it in New VM, or make it the default in the VMs page's Images tab."
