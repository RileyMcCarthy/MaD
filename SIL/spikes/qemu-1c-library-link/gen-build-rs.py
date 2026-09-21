#!/usr/bin/env python3
"""Spike 1c: generate build.rs by scraping QEMU's own link line from build.ninja.

QEMU produces no libqemu-<target>.a -- the emulator is linked from a raw list
of 764 object files plus libqemuutil.a, libfdt.a, 20 dylibs and 4 frameworks.
So the way to link it into a foreign binary is to replay that list, minus the
one object that defines main().

usage: gen-build-rs.py <qemu-build-dir>   (writes ./build.rs)
"""
import os
import re
import sys

B = os.path.abspath(sys.argv[1])
ninja = open(os.path.join(B, "build.ninja")).read()

# --- the emulator's link line -------------------------------------------
i = ninja.index("build qemu-system-riscv32-unsigned: c_LINKER ")
blk = ninja[i:ninja.index("\nbuild ", i + 10)]
toks = blk.split("\n")[0].split()
# system_main.c.o is the ONLY definition of main(); it must not come along.
objs = [t for t in toks if t.endswith(".o") and not t.endswith("system_main.c.o")]
archives = [t for t in toks if t.endswith(".a")]
args = re.search(r"LINK_ARGS = (.*)", blk).group(1).split()
libs = [a for a in args if a.startswith("-l") or a.endswith(".dylib")]
fws = [args[k + 1] for k, a in enumerate(args) if a == "-framework"]

# --- compile flags for the shim, taken from a real system object --------
j = ninja.index("build libsystem.a.p/system_cpus.c.o:")
cargs = re.search(r"ARGS = (.*)", ninja[j:ninja.index("\nbuild ", j + 10)]).group(1).split()


def absify(p):
    return p if os.path.isabs(p) else os.path.normpath(os.path.join(B, p))


cflags, k = [], 0
while k < len(cargs):
    a = cargs[k]
    if a == "-iquote":                       # takes a SEPARATE argument
        cflags.append("-iquote" + absify(cargs[k + 1])); k += 2; continue
    if a.startswith("-I"):                   # relative to the BUILD dir
        cflags.append("-I" + absify(a[2:])); k += 1; continue
    if a.startswith(("-D", "-std")) or a in ("-fno-strict-aliasing", "-fno-common", "-fwrapv"):
        cflags.append(a)
    k += 1

out = ["fn main() {", '    let b = "%s";' % B,
       "    let mut cc = cc::Build::new();", '    cc.file("p2lib.c");', "    cc.warnings(false);"]
out += ['    cc.flag("%s");' % f.replace("\\", "\\\\").replace('"', '\\"') for f in cflags]
out.append('    cc.compile("p2lib");')
out += ['    println!("cargo:rustc-link-arg={}/%s", b);' % o for o in objs]
out += ['    println!("cargo:rustc-link-arg={}/%s", b);' % a for a in archives]
out += ['    println!("cargo:rustc-link-arg=%s");' % l for l in libs]
for f in sorted(set(fws)):
    out.append('    println!("cargo:rustc-link-arg=-framework");')
    out.append('    println!("cargo:rustc-link-arg=%s");' % f)
out.append("}")
open("build.rs", "w").write("\n".join(out))
print("build.rs: %d objects, %d archives, %d libs, %d frameworks, %d cflags"
      % (len(objs), len(archives), len(libs), len(set(fws)), len(cflags)))
