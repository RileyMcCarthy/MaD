#!/usr/bin/env bash
# The firmware the firmware-compatibility scenario COMPAT-app-too-old needs
# on the board (Software/Control/e2e/run-all.mjs), laid out for the module's
# flash as `make flash-image` lays out this tree's (`embsim flash-image`):
#
#   build/flash-compat-future.bin  this tree's image (pio env MaD), generated
#                                  from the schema with protocol_version one
#                                  higher: firmware from after the app's
#                                  protocol, and otherwise this tree's.
#
# No firmware source changes for it: it is this tree built from a scratch
# copy whose schema says the next version (target/compat/future).
#
# COMPAT-too-old's firmware, a release from before the device-info
# handshake, is not built here: every such release has its protocol on the
# debug header J1 (P62/P63), and the e2e's board has its host on the control
# port J4 (P30/P32), where that firmware never listens (SIL/makefile,
# e2e-compat).
#
# Environment: EMBSIM (the embsim command).
set -euo pipefail

sil=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$sil/.." && pwd)
embsim=${EMBSIM:-cargo run --release --quiet --manifest-path $sil/embsim/Cargo.toml -p embsim-cli --}
work="$sil/target/compat"
mkdir -p "$work" "$sil/build"

# This tree's firmware with the next protocol_version: a copy of the firmware
# project beside a copy of the schema, the generator linked in, as the
# firmware's pre-build hook expects (../../Protocol from the project).
future="$work/future"
protocol=$(sed -n 's/^protocol_version:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$root/Protocol/MaDProtocol.yaml")
[ -n "$protocol" ] || {
  echo "compat-images: no protocol_version in Protocol/MaDProtocol.yaml" >&2
  exit 1
}
next=$((protocol + 1))
rm -rf "$future/Firmware" "$future/Protocol"
mkdir -p "$future/Firmware/MaDCore" "$future/Protocol"
(cd "$root/Firmware/MaDCore" && tar cf - --exclude=.pio --exclude=src/Generated .) | (cd "$future/Firmware/MaDCore" && tar xf -)
sed "s/^protocol_version:.*/protocol_version: $next/" "$root/Protocol/MaDProtocol.yaml" > "$future/Protocol/MaDProtocol.yaml"
ln -s "$root/Protocol/ProtoEmb" "$future/Protocol/ProtoEmb"
echo "compat-images: building this tree's image at protocol_version $next"
(cd "$future/Firmware/MaDCore" && PLATFORMIO_BUILD_FLAGS='-DFIRMWARE_VERSION=\"compat-next\"' pio run -e MaD >"$work/future-build.log" 2>&1) || {
  tail -40 "$work/future-build.log" >&2
  exit 1
}
grep -q "^#define PROTOEMB_PROTOCOL_VERSION $next\$" "$future/Firmware/MaDCore/src/Generated/protoemb.h" || {
  echo "compat-images: the future build did not generate protocol_version $next" >&2
  exit 1
}

$embsim flash-image "$future/Firmware/MaDCore/.pio/build/MaD/program" -o "$sil/build/flash-compat-future.bin"
echo "compat-images: build/flash-compat-future.bin (protocol_version $next)"
