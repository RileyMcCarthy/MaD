#!/bin/bash
# Run the randomised differential test and report the first divergence.
# usage: difftest.sh <qemu-system-p2> [ops] [n] [seed]
set -euo pipefail
QEMU=${1:?usage: difftest.sh <qemu-system-p2> [ops] [n] [seed]}
OPS=${2:-add,sub,and,or,xor,mov,not}
N=${3:-400}
SEED=${4:-1}
HERE=$(cd "$(dirname "$0")" && pwd); CRATE=$(dirname "$HERE"); SIL=$(dirname "$CRATE")
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

COUNT=$(python3 "$HERE/difftest.py" --ops "$OPS" --n "$N" --seed "$SEED" --out "$W/prog.bin")
cargo build --release --quiet --manifest-path "$SIL/Cargo.toml" -p p2core --example p2state
"$SIL/target/release/examples/p2state" "$W/prog.bin" "$COUNT" > "$W/ref.txt"

timeout 60 "$QEMU" -M p2 -nographic -monitor none -serial none -display none \
    -accel tcg,one-insn-per-tb=on \
    -device loader,file="$W/prog.bin",addr=0x1000,cpu-num=0 \
    -device loader,addr=0x1000,cpu-num=0 \
    -d cpu -D /dev/stdout 2>/dev/null | grep '^P2STATE' | head -n "$COUNT" > "$W/qemu.txt"

R=$(wc -l < "$W/ref.txt"); Q=$(wc -l < "$W/qemu.txt")
echo "  reference $R lines | qemu $Q lines | program $COUNT instructions"
if diff -q "$W/ref.txt" "$W/qemu.txt" >/dev/null; then
    echo "  OK: traces identical over $Q instructions"
    exit 0
fi
echo "  DIVERGENCE at:"
diff "$W/ref.txt" "$W/qemu.txt" | head -6 | cut -c1-140
LINE=$(diff --unchanged-line-format= --old-line-format='%dn ' --new-line-format= "$W/ref.txt" "$W/qemu.txt" | awk '{print $1; exit}')
echo "  first differing state line: $LINE"
exit 1
