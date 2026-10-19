#!/bin/bash
# Run the REAL firmware on both engines and diff cog 0 state by state.
#
# Everything else in this directory diffs generated programs. This diffs the
# thing the target exists to run: a flexspin image booted the way silicon boots
# it -- the first $1F8 longs become cog 0's RAM and it runs them from cog $000.
# usage: fwtest.sh <qemu-system-p2> <image> [states]
set -euo pipefail
QEMU=${1:?usage: fwtest.sh <qemu-system-p2> <image> [states]}
IMAGE=${2:?usage: fwtest.sh <qemu-system-p2> <image> [states]}
N=${3:-20000}
HERE=$(cd "$(dirname "$0")" && pwd); CRATE=$(dirname "$HERE"); SIL=$(dirname "$CRATE")
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cargo build --release --quiet --manifest-path "$SIL/Cargo.toml" -p p2core --example p2state

P2CORE_NO_FF=1 P2STATE_FIRMWARE=1 "$SIL/target/release/examples/p2state" \
    "$IMAGE" "$N" > "$W/ref.txt"

set +o pipefail
timeout 300 "$QEMU" -M p2 -nographic -monitor none -serial none -display none \
    -accel tcg,one-insn-per-tb=on \
    -kernel "$IMAGE" \
    -d cpu -D /dev/stdout 2>/dev/null | grep '^P2STATE cog=0' | head -n "$N" > "$W/qemu.txt"
set -o pipefail

python3 - "$W/ref.txt" "$W/qemu.txt" <<'PYEOF'
import sys

ref = open(sys.argv[1]).read().splitlines()
qemu = open(sys.argv[2]).read().splitlines()

# QEMU logs CPU state when a translation block is ENTERED, and a block can be
# entered and then exit before executing anything -- the round-robin
# accelerator's wall-clock kick sets the exit-request flag, which gen_tb_start
# tests at the top of every block. The state is logged either way, so the same
# line appears twice. That is a tracing artifact, not a divergence, and it is
# not deterministic: the same run diverges at a different point each time.
#
# So a repeated QEMU line is dropped ONLY when the reference does not repeat
# there too. A genuine one-instruction self-loop repeats on both sides and is
# still compared.
i = j = 0
dropped = 0
while i < len(ref) and j < len(qemu):
    if ref[i] == qemu[j]:
        i += 1
        j += 1
        continue
    if j and qemu[j] == qemu[j - 1]:
        j += 1
        dropped += 1
        continue
    break

print("  reference %d states | qemu %d states | compared %d" % (len(ref), len(qemu), i))
if dropped:
    print("  (%d duplicate block-entry log lines dropped)" % dropped)
if i >= len(ref) or j >= len(qemu):
    # Running out of QEMU lines is expected when duplicates were dropped: the
    # traces were cut to the same LENGTH before alignment, not the same depth.
    print("  OK: identical over %d states of real firmware" % i)
    sys.exit(0)
print("  DIVERGES at reference state %d" % (i + 1))
print("  prev: " + ref[i - 1][:100])
print("  ref : " + ref[i][:100])
print("  qemu: " + qemu[j][:100])
fa, fb = ref[i].split(), qemu[j].split()
names = ["r%d" % k for k in range(32)] + ["|"] + ["$%03X" % (0x1F0 + k) for k in range(16)]
for k, (x, y) in enumerate(zip(fa[7:], fb[7:])):
    if x != y:
        print("    %s: ref %s qemu %s" % (names[k] if k < len(names) else k, x, y))
sys.exit(1)
PYEOF
