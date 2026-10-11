#!/bin/bash
# Run the randomised differential test and report the first divergence.
# usage: difftest.sh <qemu-system-p2> [ops] [n] [seed] [cf] [mem] [pins] [cog]
#
# cog=1 runs the generated body in COG space, which is the cog-exec
# INTERPRETER rather than the hub-exec translator -- a different engine over
# the same instruction set, held to the same standard.
set -euo pipefail
QEMU=${1:?usage: difftest.sh <qemu-system-p2> [ops] [n] [seed]}
OPS=${2:-add,sub,and,or,xor,mov,not}
N=${3:-400}
SEED=${4:-1}
CF=${5:-0}
MEM=${6:-0}
PINS=${7:-0}
COG=${8:-0}
COGFLAG=""; [ "$COG" = 1 ] && COGFLAG="--cog"
HERE=$(cd "$(dirname "$0")" && pwd); CRATE=$(dirname "$HERE"); SIL=$(dirname "$CRATE")
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

COUNT=$(python3 "$HERE/difftest.py" --ops "$OPS" --n "$N" --seed "$SEED" --cf "$CF" --mem "$MEM" --pins "$PINS" $COGFLAG --out "$W/prog.bin")
cargo build --release --quiet --manifest-path "$SIL/Cargo.toml" -p p2core --example p2state
# p2core fast-forwards a confirmed idle poller to the next instant anything it
# can observe might change. That is an interpreter-throughput optimisation, not
# silicon semantics, and QEMU has no equivalent -- so it would show up here as a
# pure `clk` divergence on any generated program that happens to look like a
# poll. Turn it off for the diff.
P2CORE_NO_FF=1 "$SIL/target/release/examples/p2state" "$W/prog.bin" "$COUNT" > "$W/ref.txt"

# A program with loops never stops, so `head` closes the pipe under QEMU and
# it dies of SIGPIPE. That is the expected end of the run, not a failure.
set +o pipefail
timeout 60 "$QEMU" -M p2 -nographic -monitor none -serial none -display none \
    -accel tcg,one-insn-per-tb=on \
    -device loader,file="$W/prog.bin",addr=0x1000,cpu-num=0 \
    -device loader,addr=0x1000,cpu-num=0 \
    -d cpu -D /dev/stdout 2>/dev/null | grep '^P2STATE cog=0' | head -n "$COUNT" > "$W/qemu.txt"

set -o pipefail

R=$(wc -l < "$W/ref.txt"); Q=$(wc -l < "$W/qemu.txt")
echo "  reference $R lines | qemu $Q lines | program $COUNT instructions"
if diff -q "$W/ref.txt" "$W/qemu.txt" >/dev/null; then
    echo "  OK: traces identical over $Q instructions"
    exit 0
fi
echo "  DIVERGENCE at:"
diff "$W/ref.txt" "$W/qemu.txt" | head -6 | cut -c1-140
LINE=$(python3 - "$W/ref.txt" "$W/qemu.txt" <<'PYEOF'
import sys
a=open(sys.argv[1]).read().splitlines(); b=open(sys.argv[2]).read().splitlines()
i=next((k for k in range(min(len(a),len(b))) if a[k]!=b[k]), None)
print(i+1 if i is not None else min(len(a),len(b))+1)
PYEOF
)
echo "  first differing state line: $LINE"
exit 1
