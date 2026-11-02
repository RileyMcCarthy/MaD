#!/usr/bin/env bash
# The firmware the firmware-compatibility scenarios need on the board
# (Software/Control/e2e/run-all.mjs: COMPAT-too-old, COMPAT-app-too-old),
# each laid out for the module's flash as `make flash-image` lays out this
# tree's (`embsim flash-image`):
#
#   build/flash-compat-old.bin     a released production image from before the
#                                  app could ask the firmware which protocol it
#                                  speaks: COMPAT_OLD_TAG (firmware-v0.14), as
#                                  published. It refuses the question, and its
#                                  samples and configuration have fewer fields
#                                  than this app reads.
#   build/flash-compat-future.bin  this tree's production image, generated from
#                                  the schema with protocol_version one higher:
#                                  firmware from after the app's protocol, and
#                                  otherwise this tree's.
#
# No firmware source changes for either: the old one is a release, and the
# new one is this tree built from a scratch copy whose schema says the next
# version (target/compat/future).
#
# Environment: EMBSIM (the embsim command), COMPAT_OLD_TAG, MAD_REPO
# (owner/name the release comes from; RileyMcCarthy/MaD).
set -euo pipefail

sil=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$sil/.." && pwd)
embsim=${EMBSIM:-cargo run --release --quiet --manifest-path $sil/embsim/Cargo.toml -p embsim-cli --}
tag=${COMPAT_OLD_TAG:-firmware-v0.14}
repo=${MAD_REPO:-RileyMcCarthy/MaD}
work="$sil/target/compat"
mkdir -p "$work" "$sil/build"

# The released image, as the Firmware screen would have downloaded it.
version=${tag#firmware-v}
old="$work/$tag-release.bin"
if [ ! -s "$old" ]; then
  echo "compat-images: downloading $tag's production image from $repo"
  curl -fsSL --retry 3 -o "$old.part" \
    "https://github.com/$repo/releases/download/$tag/MaD-Firmware-$version-release.bin"
  mv "$old.part" "$old"
fi

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
echo "compat-images: building this tree's production image at protocol_version $next"
(cd "$future/Firmware/MaDCore" && PLATFORMIO_BUILD_FLAGS='-DFIRMWARE_VERSION=\"compat-next\"' pio run -e P2Eval >"$work/future-build.log" 2>&1) || {
  tail -40 "$work/future-build.log" >&2
  exit 1
}
grep -q "^#define PROTOEMB_PROTOCOL_VERSION $next\$" "$future/Firmware/MaDCore/src/Generated/protoemb.h" || {
  echo "compat-images: the future build did not generate protocol_version $next" >&2
  exit 1
}

$embsim flash-image "$old" -o "$sil/build/flash-compat-old.bin"
$embsim flash-image "$future/Firmware/MaDCore/.pio/build/P2Eval/program" -o "$sil/build/flash-compat-future.bin"
echo "compat-images: build/flash-compat-old.bin ($tag), build/flash-compat-future.bin (protocol_version $next)"
