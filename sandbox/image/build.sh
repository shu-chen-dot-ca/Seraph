#!/usr/bin/env bash
# Build the image every session VM starts from:
#
#     sandbox/image/build.sh
#
# SANDBOX_BUILD_FROM (Ubuntu 24.04 desktop) + the tools in provision.sh + the
# Python packages in python-packages.txt, published as SANDBOX_BUILD_NAME.
# Takes about 20-30 minutes. Run it again to update the image; sessions that
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

echo "==> Provisioning"
incus file push provision.sh python-packages.txt "$BUILDER/root/"
incus exec "$BUILDER" \
    --env SANDBOX_VM_NODE_MAJOR="$SANDBOX_VM_NODE_MAJOR" \
    --env SANDBOX_VM_FALLBACK_USER="$SANDBOX_VM_FALLBACK_USER" \
    --env SANDBOX_VM_PY_VENV="$SANDBOX_VM_PY_VENV" \
    --env SANDBOX_VM_RUST_DIR="$SANDBOX_VM_RUST_DIR" \
    --env SANDBOX_VM_PLAYWRIGHT_DIR="$SANDBOX_VM_PLAYWRIGHT_DIR" \
    --env SANDBOX_VM_DEMO_DIR="$SANDBOX_VM_DEMO_DIR" \
    --env SANDBOX_VM_NOVNC_PORT="$SANDBOX_VM_NOVNC_PORT" \
    --env SANDBOX_VM_VNC_PORT="$SANDBOX_VM_VNC_PORT" \
    --env SANDBOX_VM_DOCKER_IMAGES="$SANDBOX_VM_DOCKER_IMAGES" \
    -- bash /root/provision.sh

echo "==> Publishing the image as '$SANDBOX_BUILD_NAME'"
incus stop "$BUILDER"
# Uncompressed: bigger on disk, but new sessions unpack it faster.
incus publish "$BUILDER" --alias "$SANDBOX_BUILD_NAME" --reuse --compression none

echo "==> Done. Set SANDBOX_IMAGE=$SANDBOX_BUILD_NAME in .env to use it for new sessions."
