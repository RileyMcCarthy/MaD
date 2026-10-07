#!/bin/bash
# Diff the boot ROM, state by state, between p2core and the embsim QEMU node.
#
# The standalone qemu-system-p2 flash bus is gone. The node boots the same
# chain the silicon does: Parallax's ROM, the EC32MB nets, the SPI flash
# model. This script builds the reference with p2core and the other side by
# tracing that boot (`EMBSIM_P2_QEMU_TRACE`).
#
# usage: romtest.sh [states]
# requires: EMBSIM_QEMU_P2_BUILD, a node-configured QEMU build
#           (p2-qemu/qemu-target/README.md)
set -euo pipefail
N=${1:-60000}
HERE=$(cd "$(dirname "$0")" && pwd)
CRATE=$(dirname "$HERE")
SIL=$(dirname "$CRATE")
EMB="$SIL/embsim"
ROM="$EMB/p2-qemu/rom"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

if [ -z "${EMBSIM_QEMU_P2_BUILD:-}" ]; then
    echo "*** EMBSIM_QEMU_P2_BUILD is unset."
    echo "*** Point it at a QEMU build configured with --with-devices-p2=node."
    exit 1
fi
if [ ! -f "$ROM/rom_booter_v33k.bin" ] || [ ! -f "$ROM/stage1.bin" ]; then
    echo "*** missing $ROM/rom_booter_v33k.bin or stage1.bin"
    exit 1
fi

# The flash image the node test builds (flashimage::boot_flash): stage-1 in
# the first KB balanced to "Prop", the payload's length and image at $400.
python3 - "$ROM/stage1.bin" "$W/flash.bin" <<'PYEOF'
import sys, struct
stage1 = open(sys.argv[1], 'rb').read()
assert len(stage1) <= 0x3FC, f"stage-1 must leave the fix-up long free, is {len(stage1)}"
payload = b''.join(struct.pack('<I', w) for w in (0xF607EC42, 0xFC27EC3E, 0xFD9FFFFC))
img = bytearray(0x404 + len(payload))
img[:len(stage1)] = stage1
img[0x400:0x404] = struct.pack('<I', len(payload))
img[0x404:] = payload
PROP = struct.unpack('<I', b'Prop')[0]
s = sum(struct.unpack_from('<I', img, i)[0] for i in range(0, 0x400, 4)) & 0xFFFFFFFF
img[0x3FC:0x400] = struct.pack('<I', (PROP - s) & 0xFFFFFFFF)
open(sys.argv[2], 'wb').write(bytes(img))
PYEOF

cargo build --release --quiet --manifest-path "$SIL/Cargo.toml" -p p2core --example p2state

P2CORE_NO_FF=1 P2STATE_ROM="$ROM/rom_booter_v33k.bin" P2STATE_FLASH="$W/flash.bin" \
    "$SIL/target/release/examples/p2state" - "$N" > "$W/ref.txt"

# The node test writes one P2STATE line per instruction. A traced run is
# large (~450 bytes an instruction) and the payload spins, so the test bounds
# its own wait. The boot's own asserts (flash reads at 0 and $400, the
# payload byte) run inside the test; this script diffs the states.
EMBSIM_P2_QEMU_TRACE="$W/trace.txt" \
    cargo test --manifest-path "$EMB/Cargo.toml" -p embsim-p2-qemu --test rom_boot_ec32mb -- --nocapture

awk -v n="$N" '/^P2STATE cog=0/ { print; if (++c >= n) exit }' "$W/trace.txt" > "$W/qemu.txt"

python3 - "$W/ref.txt" "$W/qemu.txt" <<'PYEOF'
import sys

ref = open(sys.argv[1]).read().splitlines()
qemu = open(sys.argv[2]).read().splitlines()

# QEMU logs CPU state when a translation block is ENTERED, and a block can be
# entered and then exit before executing anything. The same line appears
# twice. A repeated QEMU line is dropped ONLY when the reference does not
# repeat there too. A genuine one-instruction self-loop repeats on both sides
# and is still compared.
i = j = dropped = 0
while i < len(ref) and j < len(qemu):
    if ref[i] == qemu[j]:
        i += 1
        j += 1
        continue
    if j and qemu[j] == qemu[j - 1] and not (i and ref[i] == ref[i - 1]):
        j += 1
        dropped += 1
        continue
    break

print("  reference %d states | qemu %d states | compared %d" % (len(ref), len(qemu), i))
if dropped:
    print("  (%d duplicate block-entry log lines dropped)" % dropped)

failed = False
if i < len(ref) and j < len(qemu):
    print("  FAIL: diverged at state %d" % i)
    print("    ref : %s" % " ".join(ref[i].split()[:7]))
    print("    qemu: %s" % " ".join(qemu[j].split()[:7]))
    rf, qf = ref[i].split(), qemu[j].split()
    for k, (a, b) in enumerate(zip(rf, qf)):
        if a != b:
            print("    first differing field %d: ref=%s qemu=%s" % (k, a, b))
            break
    failed = True
elif i == 0:
    print("  FAIL: nothing was compared")
    failed = True

print("  " + ("FAILED" if failed else "OK: %d states identical" % i))
sys.exit(1 if failed else 0)
PYEOF
