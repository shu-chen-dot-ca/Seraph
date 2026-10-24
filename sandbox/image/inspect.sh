#!/usr/bin/env bash
# List what an image has (system, languages, tools, packages, models), for the VMs page's Images tab:
#
#     sandbox/image/inspect.sh <image name> <folder>
#
# Starts a throwaway VM from the image, runs inventory.py in it, deletes the VM, and writes
# <folder>/<image fingerprint>.json. Takes about two minutes and 4 GB of memory meanwhile.
# Images never change, so this is done once per image (build and save do it at the end).

set -euo pipefail
cd "$(dirname "$0")"

# Read only the SANDBOX_* lines of .env, never the rest of it.
source <(grep -E '^SANDBOX_[A-Z_]+=' ../../.env)

IMAGE=$1
OUT_DIR=$2
FINGERPRINT=$(incus query "/1.0/images/aliases/$IMAGE" | python3 -c 'import json, sys; print(json.load(sys.stdin)["target"])')
CREATED=$(incus query "/1.0/images/$FINGERPRINT" | python3 -c 'import json, sys; print(json.load(sys.stdin)["created_at"])')
# Not named like the app's VMs (SANDBOX_VM_PREFIX), so the VM list never picks it up.
VM="image-inspect-${FINGERPRINT:0:12}"

# Whatever happens, don't leave the throwaway VM behind.
trap 'incus delete --force "$VM" >/dev/null 2>&1 || true' EXIT

echo "==> Starting a throwaway VM from $IMAGE"
incus delete --force "$VM" >/dev/null 2>&1 || true
incus launch "$FINGERPRINT" "$VM" --vm --profile "$SANDBOX_PROFILE" \
    --config limits.cpu=2 \
    --config limits.memory=4GiB \
    --device root,size="${SANDBOX_DISK_GB_MIN}GiB"

echo "==> Waiting for it"
for _ in $(seq 150); do
    if incus exec "$VM" -- true >/dev/null 2>&1; then
        break
    fi
    sleep 2
done
# fwupd crashes VMs on this host (see VM.guard_shadow_stack in sandbox/vm.py); older images still start it.
incus exec "$VM" -- systemctl mask --now fwupd.service fwupd-refresh.service fwupd-refresh.timer >/dev/null 2>&1 || true

echo "==> Listing what it has"
mkdir -p "$OUT_DIR"
incus exec "$VM" -- python3 - "$IMAGE" "$FINGERPRINT" "$CREATED" < inventory.py > "$OUT_DIR/$FINGERPRINT.json.tmp"
mv "$OUT_DIR/$FINGERPRINT.json.tmp" "$OUT_DIR/$FINGERPRINT.json"
echo "==> Listed $IMAGE"
