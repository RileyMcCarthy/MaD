"""Per-file -O0 for the files that trip the Rosetta flexcc wedge.

flexcc ships x86-64-only and runs under Rosetta 2 on Apple Silicon. Translating
its -O1 codegen for app_control.c trips a Rosetta wedge (the process sticks in
uninterruptible state and all later flexcc invocations hang). Compiling JUST
the affected files at -O0 dodges the wedge; everything else stays at -O1 so cog
stack sizes (tuned for -O1 frame sizes) are unaffected.

  - app_control.c: reliably trips the wedge.
  - dev_servo.c:   new + float-heavy (sqrtf + PI math) — same precaution applied
                   proactively (the 1 kHz loop has ample headroom at -O0, and it
                   measures its own dt so it's insensitive to the slowdown).

Remove once a native arm64 flexcc is available (no Rosetta) or the constructs
that trip Rosetta's translator are refactored.
"""
Import("env")

_DROP = ("-O0", "-O1", "-O2", "-O3", "-Os", "-Og")


def _force_o0(env, node):
    flags = [f for f in env["CCFLAGS"] if f not in _DROP]
    return env.Object(node, CCFLAGS=flags + ["-O0"])


for _pattern in ("*app_control.c", "*dev_servo.c"):
    env.AddBuildMiddleware(_force_o0, _pattern)
