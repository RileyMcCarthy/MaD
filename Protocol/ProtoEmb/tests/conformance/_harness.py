"""Cross-language conformance plumbing: generate a schema to C/Rust/TS, compile a
small driver against each generated codec, run it, and return its stdout lines.

A *driver* is a tiny program that, for each test vector, encodes the value,
re-encodes the decode of those bytes (a round-trip self-check), and prints one
`label hex` line. Byte-identical stdout across languages == wire conformance.

Toolchains are probed lazily; a missing compiler yields `None` so callers can
`pytest.skip` rather than fail on a machine that lacks (say) a Rust toolchain.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

CORE_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "core"))
GENERATE_PY = os.path.join(CORE_DIR, "generate.py")
TEMPLATES_DIR = os.path.join(CORE_DIR, "templates")


def have(tool):
    return shutil.which(tool) is not None


def have_tsc():
    return have("tsc") or have("npx")


def generate_codec(schema_path, prefix, target, out_dir):
    """Generate one target's codec into out_dir; raise on generator error."""
    os.makedirs(out_dir, exist_ok=True)
    cmd = [
        sys.executable, GENERATE_PY,
        "--schema", str(schema_path), "--target", target,
        "--output", str(out_dir), "--templates", TEMPLATES_DIR,
        "--prefix", prefix,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"generate {target} failed:\n{r.stderr}")


def _run(cmd, cwd=None):
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if r.returncode != 0:
        raise RuntimeError(
            f"command failed ({' '.join(map(str, cmd))}):\n{r.stdout}\n{r.stderr}"
        )
    return r.stdout


# ── Per-language build + run ─────────────────────────────────────────────────

def build_run_c(work_dir, prefix_lower, driver_src):
    """Compile `driver_src` against the generated C codec and run it."""
    if not have("cc"):
        return None
    src = os.path.join(work_dir, "driver.c")
    with open(src, "w") as f:
        f.write(driver_src)
    exe = os.path.join(work_dir, "driver_c")
    # -Wall (no -Werror): the generated header carries `static const` remap tables
    # that a driver may legitimately not reference (matches examples/verify.sh).
    _run(["cc", "-std=c11", "-Wall", "-I", work_dir,
          os.path.join(work_dir, f"{prefix_lower}.c"), src, "-o", exe])
    return _run([exe]).splitlines()


def build_run_rust(work_dir, prefix_lower, driver_src):
    """Compile `driver_src` (which `#[path]`-includes the codec) and run it."""
    if not have("rustc"):
        return None
    src = os.path.join(work_dir, "driver.rs")
    with open(src, "w") as f:
        f.write(driver_src)
    exe = os.path.join(work_dir, "driver_rs")
    _run(["rustc", "--edition", "2021", "-A", "warnings", src, "-o", exe])
    return _run([exe]).splitlines()


def build_run_ts(work_dir, prefix_lower, driver_src):
    """Typecheck+transpile `driver_src` against the generated TS codec, run on node."""
    if not have_tsc() or not have("node"):
        return None
    src = os.path.join(work_dir, "driver.ts")
    with open(src, "w") as f:
        f.write(driver_src)
    js_dir = os.path.join(work_dir, "js")
    tsc = ["tsc"] if have("tsc") else ["npx", "--yes", "-p", "typescript", "tsc"]
    _run(tsc + [
        "--target", "es2020", "--module", "commonjs", "--moduleResolution", "node",
        "--strict", "--skipLibCheck", "--ignoreDeprecations", "6.0",
        "--outDir", js_dir, src,
    ])
    return _run(["node", os.path.join(js_dir, "driver.js")]).splitlines()


BUILDERS = {"c": build_run_c, "rs": build_run_rust, "ts": build_run_ts}


# ── High-level orchestration shared by every conformance test module ─────────

def run_all(schema_path, prefix, vectors, work_dir):
    """Generate `schema` to all targets, build+run each available driver over
    `vectors`, and return {lang: [lines]} for the toolchains that exist."""
    from render import Renderer  # local import: render imports `generate`

    import generate as gen
    renderer = Renderer(gen.load_yaml(schema_path), prefix)
    for target in ("c", "rs", "ts"):
        generate_codec(schema_path, prefix, target, work_dir)
    out = {}
    for lang, builder in BUILDERS.items():
        lines = builder(work_dir, prefix.lower(), renderer.driver(lang, vectors))
        if lines is not None:
            out[lang] = lines
    return out


def pivot_by_label(outputs):
    """{lang: [\"label hex\", ...]} -> {label: {lang: hex}}."""
    by_label = {}
    for lang, lines in outputs.items():
        for ln in lines:
            label, hexstr = ln.split(" ", 1)
            by_label.setdefault(label, {})[lang] = hexstr
    return by_label
