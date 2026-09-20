#!/bin/bash
# usage: entry.sh <qemu-binary> <label> [ENV=VAL ...]
# E  = ns per slice entry (cpus=1, budget=1), best of 5
# OP = ns/inst at the operational point (8 cogs, quantum 48), best of 5
Q=$1; LABEL=$2; shift 2
ENVS=("$@")                       # captured at script scope, not inside a function
run() {
  local n=$1 b=$2 r=$3 best=999999999 line ns
  local args=(-M virt -m 8M -smp $n -bios none -icount shift=0,sleep=off -nographic -monitor none -serial none -display none)
  local c; for ((c=0;c<n;c++)); do args+=(-device "loader,file=loop-nop.bin,addr=0x80000000,cpu-num=$c"); done
  local k; for k in 1 2 3 4 5; do
    line=$(env "${ENVS[@]}" QEMU_SPIKE_SLICE=$b QEMU_SPIKE_N=$r "$Q" "${args[@]}" 2>&1 | grep SPIKE | tail -1)
    ns=$(echo "$line" | awk '{for(i=1;i<=NF;i++){split($i,a,"="); if(a[1]=="ns/round")print a[2]}}')
    [ -z "$ns" ] && { echo "NO SPIKE LINE: $line" >&2; return 1; }
    best=$(python3 -c "print(min(float('$best'), float('$ns')))")
  done
  echo "$best"
}
E=$(run 1 1 200000) || exit 1
OP=$(run 8 48 8000) || exit 1
python3 -c "
E=float('$E'); OP=float('$OP')
nsi = OP/(8*48)
avail = 9.43 - E/48.0 - 3.29
X = avail/0.93
print('%-30s %9.1f %11.3f %9.2f %11s' % ('$LABEL', E, nsi, E/48.0,
      ('%.2f ns' % X) if X>0 else 'none'))"
