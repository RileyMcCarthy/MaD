#!/bin/bash
# usage: smp.sh <ncpu> <budget> <rounds>
Q=./qemu/build/qemu-system-riscv32-unsigned
n=$1; b=$2; r=$3
args=(-M virt -m 8M -smp $n -bios none -icount shift=0,sleep=off -nographic -monitor none -serial none -display none)
for ((c=0;c<n;c++)); do args+=(-device "loader,file=loop-nop.bin,addr=0x80000000,cpu-num=$c"); done
QEMU_SPIKE_SLICE=$b QEMU_SPIKE_N=$r "$Q" "${args[@]}" 2>&1 | grep SPIKE
