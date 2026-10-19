#!/bin/bash
# Differential test for D4: does the generated QEMU DecodeTree decode the real
# firmware exactly as p2core's Rust decoder does?
#
# usage: check_decodetree.sh <qemu-src-dir> <p2-image>
#
# Builds the DecodeTree into C, stubs every trans_ function to record which
# pattern matched, and compares against p2core over every DISTINCT instruction
# word in the image. Expects 100% agreement.
set -euo pipefail
QEMU=${1:?usage: check_decodetree.sh <qemu-src-dir> <p2-image>}
IMAGE=${2:?usage: check_decodetree.sh <qemu-src-dir> <p2-image>}
HERE=$(cd "$(dirname "$0")" && pwd); CRATE=$(dirname "$HERE")
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

python3 "$HERE/gen_decoder.py" --decodetree "$WORK/insn.decode"
python3 "$QEMU/scripts/decodetree.py" --static-decode=decode_p2 -o "$WORK/out.c" "$WORK/insn.decode"
cargo run --quiet --release --manifest-path "$CRATE/Cargo.toml" \
      --example dumpdec -- "$IMAGE" > "$WORK/want.txt"

python3 - "$WORK" <<'PY'
import re, sys
W = sys.argv[1]
names = re.findall(r"^static bool trans_(\w+)\(DisasContext \*ctx, arg_(\w+) \*a\);",
                   open(W + "/out.c").read(), re.M)
stub = lambda n, a: ('static bool trans_%s(DisasContext *c, arg_%s *a){(void)a;c->hit="%s";return true;}'
                     % (n, a, 'nop' if re.sub(r'_\d+$', '', n) == 'nop_zero' else re.sub(r'_\d+$', '', n)))
open(W + "/harness.c", "w").write(
    '#include <stdint.h>\n#include <stdbool.h>\n#include <stdio.h>\n#include <string.h>\n'
    'typedef struct { const char *hit; } DisasContext;\n'
    'static inline uint32_t extract32(uint32_t v,int s,int l){return (v>>s)&(~0u>>(32-l));}\n'
    'static inline int sextract32(uint32_t v,int s,int l){return ((int32_t)(v<<(32-s-l)))>>(32-l);}\n'
    '#include "out.c"\n' + "\n".join(stub(n, a) for n, a in names) + r'''
int main(int argc,char**argv){FILE*f=fopen(argv[1],"r");char l[256];
 unsigned long tot=0,ag=0,ub=0,qn=0,mm=0;
 while(fgets(l,sizeof l,f)){unsigned w;char want[64];
  if(sscanf(l,"%x %63s",&w,want)!=2)continue; tot++;
  DisasContext c; c.hit=NULL; int ok=decode_p2(&c,(uint32_t)w);
  const char*got=ok?c.hit:NULL; int wu=!strcmp(want,"<undecoded>");
  if(!got){ if(wu)ub++; else {qn++; if(qn<=8)printf("  QEMU-none   %08X p2core=%s\n",w,want);} }
  else if(wu){mm++; if(mm<=8)printf("  p2core-none %08X qemu=%s\n",w,got);}
  else if(!strcmp(got,want))ag++;
  else {mm++; if(mm<=8)printf("  DIFFER      %08X p2core=%-10s qemu=%s\n",w,want,got);} }
 printf("\n  total %lu | agree %lu | both-undecoded %lu | qemu-undecoded %lu | differ %lu\n",
        tot,ag,ub,qn,mm);
 int bad = (mm||qn);
 printf("  %s\n", bad ? "FAIL: the DecodeTree disagrees with p2core" : "OK: 100% agreement");
 return bad;}
''')
PY
cc -O1 -w -o "$WORK/harness" "$WORK/harness.c" -I"$WORK"
"$WORK/harness" "$WORK/want.txt"
