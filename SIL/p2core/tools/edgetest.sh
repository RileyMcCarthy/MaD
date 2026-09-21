#!/bin/bash
# Run every hand-built edge probe and diff the two engines instruction by
# instruction. See edgetest.py for what each one is for.
# usage: edgetest.sh <qemu-system-p2>
set -euo pipefail
QEMU=${1:?usage: edgetest.sh <qemu-system-p2>}
HERE=$(cd "$(dirname "$0")" && pwd); CRATE=$(dirname "$HERE"); SIL=$(dirname "$CRATE")
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
cargo build --release --quiet --manifest-path "$SIL/Cargo.toml" -p p2core --example p2state

fail=0
for probe in $(python3 -c "import sys; sys.path.insert(0,'$HERE'); import edgetest; print(' '.join(edgetest.PROBES))"); do
    N=$(python3 "$HERE/edgetest.py" "$probe" "$W/p.bin")
    P2CORE_NO_FF=1 "$SIL/target/release/examples/p2state" "$W/p.bin" "$N" > "$W/ref.txt"
    set +o pipefail
    timeout 60 "$QEMU" -M p2 -nographic -monitor none -serial none -display none \
        -accel tcg,one-insn-per-tb=on -icount shift=0,sleep=off \
        -device loader,file="$W/p.bin",addr=0x1000,cpu-num=0 \
        -device loader,addr=0x1000,cpu-num=0 \
        -d cpu -D /dev/stdout 2>/dev/null | grep '^P2STATE cog=0' | head -n "$N" > "$W/q.txt"
    set -o pipefail
    if [ "$(wc -l < "$W/q.txt")" -ne "$N" ]; then
        printf "  %-22s FAIL (qemu produced %s of %s states)\n" "$probe" "$(wc -l < "$W/q.txt")" "$N"; fail=1
    elif diff -q "$W/ref.txt" "$W/q.txt" > /dev/null; then
        printf "  %-22s OK (%s states identical)\n" "$probe" "$N"
    else
        printf "  %-22s DIVERGES at state %s\n" "$probe" \
            "$(diff --unchanged-line-format= --old-line-format='%dn ' --new-line-format= "$W/ref.txt" "$W/q.txt" | awk '{print $1; exit}')"
        diff "$W/ref.txt" "$W/q.txt" | head -4 | cut -c1-120
        fail=1
    fi
done
exit $fail
