#!/usr/bin/env bash
# Build the base image every sandbox VM starts from:
#
#     sandbox/image/build.sh
#
# Ubuntu 24.04 + the dev tools in provision.sh + a web editor (code-server) and
# a web terminal (ttyd). Takes about 10 minutes. Run it again to update the
# image; sandboxes that already exist keep their own disk.
# Needs Incus access (the incus-admin group) and sandbox/setup_host.sh done.

set -euo pipefail
cd "$(dirname "$0")"

IMAGE=${SANDBOX_IMAGE:-sandbox-base}
PROFILE=${SANDBOX_PROFILE:-sandbox}
BUILDER=sandbox-image-build

echo "==> Starting the builder VM"
incus delete --force "$BUILDER" >/dev/null 2>&1 || true
incus launch images:ubuntu/24.04/cloud "$BUILDER" --vm --profile "$PROFILE" \
    --config limits.cpu=8 --config limits.memory=8GiB --device root,size=20GiB

echo "==> Waiting for the VM agent"
for _ in $(seq 120); do
    if incus exec "$BUILDER" -- true >/dev/null 2>&1; then
        break
    fi
    sleep 2
done

echo "==> Provisioning"
incus file push provision.sh check-page.mjs "$BUILDER/root/"
incus exec "$BUILDER" -- bash /root/provision.sh

echo "==> Publishing the image as '$IMAGE'"
incus stop "$BUILDER"
# Uncompressed: bigger on disk, but new sandboxes unpack it faster.
incus publish "$BUILDER" --alias "$IMAGE" --reuse --compression none
incus delete "$BUILDER"

echo "Done. New sandboxes start from '$IMAGE'."
