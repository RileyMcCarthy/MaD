#!/bin/bash
# COGINIT across two cogs: compare the FINAL register state, not the trace.
#
# -icount is not optional once a second cog runs. Round-robin TCG only switches
# vCPUs when cpu_exec returns, and a cog parked in a spin loop never returns --
# so without an instruction budget the first cog to spin starves every other
# one. icount gives each cog a bounded quantum, which is also what makes the
# interleaving deterministic (design D1).
# See cogtest.py for why timing is deliberately out of scope.
# usage: cogtest.sh <qemu-system-p2> [steps]
set -euo pipefail
QEMU=${1:?usage: cogtest.sh <qemu-system-p2> [steps]}
STEPS=${2:-4000}
HERE=$(cd "$(dirname "$0")" && pwd); CRATE=$(dirname "$HERE"); SIL=$(dirname "$CRATE")
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

python3 "$HERE/cogtest.py" --out "$W/prog.bin" > /dev/null
cargo build --release --quiet --manifest-path "$SIL/Cargo.toml" -p p2core --example p2state

# Registers only: the clock and the PC depend on how many park iterations each
# engine happened to run, which is exactly the timing this test does not claim.
regs() { grep '^P2STATE cog=0' | tail -1 | sed 's/.*clk=[0-9]* //'; }

P2CORE_NO_FF=1 "$SIL/target/release/examples/p2state" "$W/prog.bin" "$STEPS" \
    | regs > "$W/ref.txt"

set +o pipefail
timeout 60 "$QEMU" -M p2 -nographic -monitor none -serial none -display none \
    -accel tcg,one-insn-per-tb=on -icount shift=0,sleep=off \
    -device loader,file="$W/prog.bin",addr=0x1000,cpu-num=0 \
    -device loader,addr=0x1000,cpu-num=0 \
    -d cpu -D /dev/stdout 2>/dev/null | head -n $((STEPS * 2)) | regs > "$W/qemu.txt"
set -o pipefail

echo "  p2core: $(cut -c1-80 < "$W/ref.txt")"
echo "  qemu  : $(cut -c1-80 < "$W/qemu.txt")"
if [ ! -s "$W/ref.txt" ] || [ ! -s "$W/qemu.txt" ]; then
    echo "  FAIL: one side produced no cog-0 state"; exit 1
fi
if diff -q "$W/ref.txt" "$W/qemu.txt" > /dev/null; then
    # r3 = $AB proves cog 0 got past the wait; r2 = $1AB proves cog 1 wrote it.
    if grep -q ' 000001AB 000000AB ' "$W/ref.txt"; then
        echo "  OK: both engines saw cog 1 write \$1AB, and agree on all registers"
        exit 0
    fi
    echo "  FAIL: registers agree but cog 1 never ran (r2/r3 not set)"; exit 1
fi
echo "  DIVERGENCE:"; diff "$W/ref.txt" "$W/qemu.txt" | cut -c1-140 | head -4
exit 1
