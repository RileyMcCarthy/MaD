#!/bin/bash
# usage: bench.sh <image.bin> <budget> <N> [icount-opts] ; best-of-3, awk-parsed
Q=./qemu/build/qemu-system-riscv32-unsigned
IC=${4:-shift=0,sleep=off}
best=999999999999; bins=0
for r in 1 2 3; do
  line=$(QEMU_SPIKE_SLICE=$2 QEMU_SPIKE_N=$3 $Q -M virt -m 8M -bios none -icount $IC \
        -nographic -monitor none -serial none -display none \
        -device loader,file=$1,addr=0x80000000,cpu-num=0 2>&1 | grep SPIKE | tail -1)
  read ns ins < <(echo "$line" | awk '{for(i=1;i<=NF;i++){split($i,a,"="); if(a[1]=="ns/slice")ns=a[2]; if(a[1]=="insns/slice")ins=a[2]} print ns, ins}')
  best=$(python3 -c "print(min(float('$best'), float('$ns')))"); bins=$ins
done
python3 -c "
ns=float('$best'); n=float('$bins')
print('%-14s %16.1f %12.4f %12.1f' % ('$(basename $1 .bin)', ns, ns/n, n/ns*1000))"
