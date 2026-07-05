#!/usr/bin/env python3
"""Firmware layer-dependency linter (downward-only includes).

The MaD firmware is strictly layered (see CLAUDE.md / coding guidelines):

    APP -> DEV -> IO -> Library -> HAL -> HW         (each layer calls only DOWN)

PlatformIO puts every layer directory on the include path, so all project
``#include "..."`` are by *basename*; a header's layer is decided by where the
file physically lives. This linter resolves each include to its layer and flags:

  * an UPWARD include   (e.g. an IO file including an ``app_*`` header), and
  * an MCU/toolchain header (``propeller2.h`` etc.) included from a layer
    ABOVE the HAL (those must go through the HAL).

It is deliberately a *direct-edge* policy check on the source text (comments
stripped), not a compiler include graph: the rule is about which header a file
names directly, which a transitive ``-MM`` graph cannot tell apart.

Pre-existing violations are frozen in a baseline file so the gate gives a clean
GREEN on today's tree and fails only on NEW upward includes. Run with
``--update-baseline`` to (re)freeze, and ``--strict`` to ignore the baseline
(Phase 2: zero-tolerance, once the debt is refactored away).
"""
from __future__ import annotations

import argparse
import os
import re
import sys

# Layer rank: higher may include lower-or-equal; including a higher rank is a
# violation. Resolved from the first path segment under src/.
LAYER_RANK = {"HW": 0, "HAL": 1, "Library": 2, "IO": 3, "DEV": 4, "APP": 5, "Main": 6}
RANK_NAME = {v: k for k, v in LAYER_RANK.items()}

# Headers that live below the HAL and must never be named above it.
MCU_HEADERS = {
    "propeller2.h", "propeller.h", "smartpins.h", "p2es_clock.h",
    "sys/p2es_clock.h",
}

# Sanctioned cross-layer header(s): IO_Debug.h is an upward-logging shim that
# only wraps HAL primitives and is intentionally included from every layer.
ALLOWLIST = {"IO_Debug.h"}

# Files we do NOT treat as includers: Main is the composition root (it wires
# everything by design). Generated/ files and system/toolchain headers resolve to
# layer None (not in LAYER_RANK) and are already skipped by the `is None` /
# not-in-`headers` guards below, so they need no named entry here.
SKIP_INCLUDER_LAYERS = {"Main"}

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"//[^\n]*")
_INCLUDE = re.compile(r'^\s*#\s*include\s*[<"]([^">]+)[">]', re.MULTILINE)


def layer_of(relpath: str) -> str | None:
    """Layer name for a path relative to the src/ root (by first segment)."""
    top = relpath.split(os.sep, 1)[0]
    return top if top in LAYER_RANK else None


def strip_comments(text: str) -> str:
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


def build_header_map(src: str):
    """basename -> set of layer names where a header by that name lives."""
    headers: dict[str, set[str]] = {}
    for root, _dirs, files in os.walk(src):
        for f in files:
            if not f.endswith(".h"):
                continue
            rel = os.path.relpath(os.path.join(root, f), src)
            lyr = layer_of(rel)
            if lyr is not None:
                headers.setdefault(f, set()).add(lyr)
    return headers


def find_violations(src: str):
    """Return sorted list of (relpath, included, reason) policy violations."""
    headers = build_header_map(src)
    violations = []
    for root, _dirs, files in os.walk(src):
        for f in sorted(files):
            if not (f.endswith(".c") or f.endswith(".h")):
                continue
            rel = os.path.relpath(os.path.join(root, f), src)
            inc_layer = layer_of(rel)
            if inc_layer is None or inc_layer in SKIP_INCLUDER_LAYERS:
                continue
            inc_rank = LAYER_RANK[inc_layer]
            try:
                with open(os.path.join(root, f), encoding="utf-8", errors="replace") as fh:
                    body = strip_comments(fh.read())
            except OSError:
                continue
            for inc in _INCLUDE.findall(body):
                base = os.path.basename(inc)
                if base in ALLOWLIST:
                    continue
                # MCU/toolchain header named above the HAL.
                if (inc in MCU_HEADERS or base in MCU_HEADERS) and inc_rank > LAYER_RANK["HAL"]:
                    violations.append((rel, inc, f"MCU header below HAL included from {inc_layer}"))
                    continue
                # Project header resolved by basename.
                tgt_layers = headers.get(base)
                if not tgt_layers:
                    continue  # system / libc / Generated / unknown header: out of policy scope
                # Worst (highest) candidate layer for this basename.
                tgt_rank = max(LAYER_RANK[t] for t in tgt_layers)
                if tgt_rank > inc_rank:
                    tgt_name = RANK_NAME[tgt_rank]
                    violations.append((rel, inc, f"upward include {inc_layer} -> {tgt_name}"))
    return sorted(set(violations))


def load_baseline(path: str):
    if not os.path.exists(path):
        return set()
    out = set()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 2:
                out.add((parts[0], parts[1]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Firmware layer-dependency linter")
    ap.add_argument("src", help="firmware src/ directory")
    ap.add_argument("--baseline", default=None,
                    help="baseline file (default: <src>/../.layering-baseline)")
    ap.add_argument("--strict", action="store_true",
                    help="ignore the baseline; flag every violation (Phase 2)")
    ap.add_argument("--update-baseline", action="store_true",
                    help="rewrite the baseline from the current violations and exit 0")
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    baseline_path = args.baseline or os.path.join(os.path.dirname(src), ".layering-baseline")

    violations = find_violations(src)
    keyed = {(v[0], v[1]): v for v in violations}

    if args.update_baseline:
        with open(baseline_path, "w", encoding="utf-8") as fh:
            fh.write("# Frozen pre-existing firmware layer violations (downward-only rule).\n")
            fh.write("# Format: <relpath-under-src>\\t<included-header>. Gate fails on NEW edges only.\n")
            fh.write("# Burn these down, then run the linter with --strict and delete this file.\n")
            for rel, inc, _reason in violations:
                fh.write(f"{rel}\t{inc}\n")
        print(f"Wrote {len(violations)} baselined violation(s) to {baseline_path}")
        return 0

    if args.strict:
        new = violations
        baseline = set()
    else:
        baseline = load_baseline(baseline_path)
        new = [keyed[k] for k in keyed if k not in baseline]

    stale = sorted(baseline - set(keyed)) if not args.strict else []

    for rel, inc, reason in sorted(new):
        print(f"::error file=Firmware/MaDCore/src/{rel}::layering: {reason} (#include \"{inc}\")")
    for rel, inc in stale:
        print(f"::notice::stale baseline entry (fixed? please prune): {rel} -> {inc}")

    known = len(set(keyed) & baseline)
    if new:
        print(f"\nFAIL: {len(new)} NEW layering violation(s) "
              f"({known} known/baselined, {len(stale)} stale).")
        return 1
    print(f"OK: {known} known/baselined violation(s), 0 new"
          + (f", {len(stale)} stale (prune the baseline)." if stale else "."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
