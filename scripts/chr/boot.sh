#!/usr/bin/env bash
# Boot a throwaway RouterOS CHR in QEMU for the CHR test suite (CI on Linux; KVM when /dev/kvm is
# writable, TCG otherwise). Never points at a real router.
#
#   CHR_VERSION   RouterOS version (default 7.25.1)
#   CHR_SHA256    sha256 of chr-<version>.img.zip — required, pinned in the workflow so a swapped
#                 image fails even if the vendor's .sha256 file were swapped too
#   CHR_DIR       cache + working dir (default ~/.cache/chr)
#   CHR_HTTP_PORT host port forwarded to the CHR's www service :80 (default 18080)
set -euo pipefail

VERSION="${CHR_VERSION:-7.25.1}"
SHA256="${CHR_SHA256:?set CHR_SHA256 to the pinned sha256 of chr-$VERSION.img.zip}"
DIR="${CHR_DIR:-$HOME/.cache/chr}"
PORT="${CHR_HTTP_PORT:-18080}"
ZIP="$DIR/chr-$VERSION.img.zip"
IMG="$DIR/chr-$VERSION.img"
mkdir -p "$DIR"

if [ ! -f "$ZIP" ]; then
  curl -fsSL --retry 3 --retry-delay 5 -o "$ZIP.part" "https://download.mikrotik.com/routeros/$VERSION/chr-$VERSION.img.zip"
  mv "$ZIP.part" "$ZIP"
fi
echo "$SHA256  $ZIP" | sha256sum -c -

# Fresh disk every run: the zip is what gets cached, never a disk a previous run wrote to.
rm -f "$IMG"
unzip -o -q "$ZIP" -d "$DIR"
[ -f "$IMG" ] || { echo "expected $IMG inside $ZIP" >&2; ls -la "$DIR" >&2; exit 1; }

ACCEL=tcg
CPU=max
if [ -w /dev/kvm ]; then
  ACCEL=kvm
  CPU=host
fi

# Machine flags as in tikoci/quickchr (src/lib/qemu.ts, x86): pc machine, virtio disk and NIC,
# user-mode network with one host port forwarded to the guest's www service.
qemu-system-x86_64 -M pc -m 512 -smp 2 -accel "$ACCEL" -cpu "$CPU" \
  -drive "file=$IMG,format=raw,if=virtio" \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$PORT-:80" -device virtio-net-pci,netdev=net0 \
  -display none -serial "file:$DIR/serial.log" -daemonize -pidfile "$DIR/qemu.pid"

# RouterOS answers an unauthenticated REST request with 401 JSON (the tool's identity probe relies
# on the same signature), so 401 means the www service is up.
for i in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT/rest/system/identity" || true)
  if [ "$code" = "401" ]; then
    echo "CHR $VERSION REST ready after $((i * 2)) s (accel $ACCEL)"
    exit 0
  fi
  sleep 2
done
echo "CHR REST not ready after 240 s (accel $ACCEL); last serial lines:" >&2
tail -n 60 "$DIR/serial.log" >&2 || true
exit 1
