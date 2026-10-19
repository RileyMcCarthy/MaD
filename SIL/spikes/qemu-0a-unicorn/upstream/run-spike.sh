#!/bin/bash
# Spike 0a, upstream half: ns per synchronous icount slice in QEMU v10.1.0.
# Runs the patched rr loop (QEMU_SPIKE_SLICE) on a bare-metal riscv32 loop.
set -u
cd "$(dirname "$0")"
# QEMU: the patched build. macOS produces qemu-system-riscv32-unsigned (the
# signed name only appears after the HVF entitlement step; TCG runs unsigned).
# Loop images come from ./mkloops.py.
Q=${QEMU:-./qemu/build/qemu-system-riscv32-unsigned}
common=(-M virt -m 8M -bios none -icount shift=0 -nographic -monitor none -serial none -display none)

run() { # <image> <budget> <n>
  QEMU_SPIKE_SLICE=$2 QEMU_SPIKE_N=$3 "$Q" "${common[@]}" \
    -device loader,file=$1,addr=0x80000000,cpu-num=0 2>&1 | grep SPIKE
}

echo "== free-running baseline (one huge slice) =="
run loop-nop.bin  100000000 3
run loop-mmio.bin 100000000 3
echo
echo "== nop body: budget -> ns/slice =="
for b in 1 8 80 800 8000 80000; do
  n=$(( b < 80 ? 2000000 : 500000 )); [ $b -ge 8000 ] && n=20000
  run loop-nop.bin $b $n
done
echo
echo "== mmio body (16550 store every iteration): budget -> ns/slice =="
for b in 80 800 8000; do
  n=$(( b >= 8000 ? 20000 : 300000 ))
  run loop-mmio.bin $b $n
done
