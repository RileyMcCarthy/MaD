#!/usr/bin/env python3
"""Compare public HAL/Include declarations against HAL/P2 definitions.

Only FlexC/propeller2 compiles HAL/P2/*.c; Unity/SIL paths use mocks, and the
tree sits outside check_src_filters — so a return-type or arity mismatch between
a public header and its P2 TU (the void/bool HAL_pulseOut_startVelocity bug)
never reached a toolchain that would reject it. This script closes that gap
with a parse-and-compare gate: no flexcc, no propeller2 hardware.

For each HAL/Include/<name>.h that has a matching HAL/P2/<name>.c, every public
function declared in the header must have a non-static definition in the .c
with the same normalized return type and the same arity (parameter count).
Parameter *names* may differ (channel vs ch); parameter *types* are not
compared beyond arity — return type + arity is what the acceptance criteria
require and what would have caught the pulseOut bug.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"//[^\n]*")
_PREPROCESSOR = re.compile(r"^\s*#.*?$", re.MULTILINE)
_STRING = re.compile(r'"(?:\\.|[^"\\])*"')
_CHAR = re.compile(r"'(?:\\.|[^'\\])'")

# Keywords that cannot be a function name when preceded by a type-ish token.
_TYPE_START_KW = {
    "auto", "break", "case", "const", "continue", "default", "do", "else",
    "enum", "extern", "for", "goto", "if", "inline", "register", "return",
    "sizeof", "static", "struct", "switch", "typedef", "union", "volatile",
    "while", "restrict",
}

# Leading storage / qualifier tokens stripped from the return-type scrape so
# `static void foo` is recognized as static (and skipped for defs) while
# `extern void foo` / bare `void foo` both normalize to return type `void`.
_LEADING_STORAGE = {"static", "extern", "inline", "_Noreturn"}


def strip_noise(text: str) -> str:
    """Remove comments, string/char literals, and preprocessor lines."""
    text = _BLOCK_COMMENT.sub(" ", text)
    text = _LINE_COMMENT.sub(" ", text)
    text = _STRING.sub('""', text)
    text = _CHAR.sub("''", text)
    text = _PREPROCESSOR.sub(" ", text)
    return text


def normalize_type(t: str) -> str:
    """Collapse whitespace and pointer spacing for stable comparison."""
    t = t.strip()
    t = re.sub(r"\s+", " ", t)
    # `uint32_t *` / `uint32_t*` / `uint32_t  *` → `uint32_t*`
    t = re.sub(r"\s*\*\s*", "*", t)
    # Keep a space between adjacent words (`unsigned int`, `const uint8_t`)
    # but not before `*`. Already handled.
    return t


def split_params(params: str) -> list[str]:
    """Split a parameter list on top-level commas (respect nested parens)."""
    params = params.strip()
    if not params or params == "void":
        return []
    parts: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(params):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(params[start:i].strip())
            start = i + 1
    tail = params[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def find_matching_paren(text: str, open_idx: int) -> int:
    """Return index of the `)` matching `text[open_idx] == '('`, or -1."""
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    return -1


def scrape_return_and_storage(prefix: str) -> tuple[str, set[str]]:
    """From the text immediately before a function name, recover return type
    and any leading storage-class keywords (static/extern/inline)."""
    # Walk tokens from the end. Stop at `;`, `{`, `}`, or start of text.
    # We only need the contiguous type tokens right before the name.
    cut = prefix
    for sep in (";", "{", "}", ":"):
        idx = cut.rfind(sep)
        if idx != -1:
            cut = cut[idx + 1 :]
    tokens = cut.split()
    storage: set[str] = set()
    while tokens and tokens[0] in _LEADING_STORAGE:
        storage.add(tokens.pop(0))
    return normalize_type(" ".join(tokens)), storage


def extract_functions(text: str, *, want: str) -> dict[str, dict]:
    """Extract function signatures from C source.

    want: 'decl' → prototypes ending in `;`
          'def'  → definitions ending in `{`
    Returns name → {ret, arity, params_raw, static}.
    """
    text = strip_noise(text)
    out: dict[str, dict] = {}
    # Find `identifier (` candidates; filter to real function decl/def.
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*\(", text):
        name = m.group(1)
        if name in _TYPE_START_KW:
            continue
        open_paren = m.end() - 1
        close = find_matching_paren(text, open_paren)
        if close < 0:
            continue
        after = text[close + 1 :].lstrip()
        if not after:
            continue
        if want == "decl":
            if not after.startswith(";"):
                continue
        elif want == "def":
            if not after.startswith("{"):
                continue
        else:
            raise ValueError(want)

        params_raw = text[open_paren + 1 : close]
        # Skip K&R leftovers / empty weirdness already handled by split_params.
        # Skip obvious non-functions: if the "return type" scrape is empty and
        # the name looks like a call-site, we still need a type token.
        prefix = text[max(0, m.start() - 200) : m.start()]
        ret, storage = scrape_return_and_storage(prefix)
        if not ret:
            continue
        # `typedef ... name(` / `sizeof(` already excluded via keywords.
        # Extern variables like `extern const Foo name[` never match `name(`.
        # Struct member function pointers: rare; if ret looks like it ends with
        # assignment debris we still accept — HAL headers are flat prototypes.

        # Reject if this looks like a function-*pointer* typedef:
        #   typedef void (*HAL_foo)(...);
        # The name captured would be wrong (inside parens). Our regex only
        # fires on `name(`, so `(*HAL_foo)(` would capture incorrectly — the
        # `*` before the name means scrape_return gets `typedef void (` junk.
        # Guard: return type must not contain `(`.
        if "(" in ret or ")" in ret:
            continue

        arity = len(split_params(params_raw))
        out[name] = {
            "ret": ret,
            "arity": arity,
            "params": params_raw.strip(),
            "static": "static" in storage,
        }
    return out


def pair_paths(include_dir: str, p2_dir: str) -> list[tuple[str, str, str]]:
    """Return (basename, header_path, c_path) for Include↔P2 pairs."""
    pairs = []
    for fname in sorted(os.listdir(include_dir)):
        if not fname.endswith(".h"):
            continue
        stem = fname[:-2]
        c_name = stem + ".c"
        c_path = os.path.join(p2_dir, c_name)
        if not os.path.isfile(c_path):
            continue
        pairs.append((stem, os.path.join(include_dir, fname), c_path))
    return pairs


def compare_pair(stem: str, header_path: str, c_path: str) -> list[str]:
    """Return human-readable mismatch lines for one Include↔P2 pair."""
    with open(header_path, encoding="utf-8", errors="replace") as fh:
        decls = extract_functions(fh.read(), want="decl")
    with open(c_path, encoding="utf-8", errors="replace") as fh:
        defs = extract_functions(fh.read(), want="def")

    # Public API = non-static declarations in the header.
    public = {n: d for n, d in decls.items() if not d["static"]}
    errors: list[str] = []

    for name, dcl in sorted(public.items()):
        definition = defs.get(name)
        if definition is None:
            errors.append(
                f"{stem}: {name}: declared in Include/{stem}.h but no "
                f"non-matching-name definition in P2/{stem}.c"
            )
            continue
        if definition["static"]:
            errors.append(
                f"{stem}: {name}: public declaration hides behind a static "
                f"definition in P2/{stem}.c"
            )
            continue
        if dcl["ret"] != definition["ret"]:
            errors.append(
                f"{stem}: {name}: return type mismatch: "
                f"header `{dcl['ret']}` vs P2 `{definition['ret']}`"
            )
        if dcl["arity"] != definition["arity"]:
            errors.append(
                f"{stem}: {name}: arity mismatch: "
                f"header {dcl['arity']} param(s) vs P2 {definition['arity']} param(s)"
            )
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fail if HAL/Include public decls disagree with HAL/P2 defs"
    )
    ap.add_argument(
        "src",
        nargs="?",
        default=None,
        help="firmware src/ directory (default: <repo>/Firmware/MaDCore/src)",
    )
    args = ap.parse_args()

    if args.src:
        src = os.path.abspath(args.src)
    else:
        here = os.path.dirname(os.path.abspath(__file__))
        src = os.path.abspath(os.path.join(here, "..", "src"))

    include_dir = os.path.join(src, "HAL", "Include")
    p2_dir = os.path.join(src, "HAL", "P2")
    if not os.path.isdir(include_dir) or not os.path.isdir(p2_dir):
        print(f"::error::HAL Include/P2 not found under {src}", file=sys.stderr)
        return 2

    pairs = pair_paths(include_dir, p2_dir)
    if not pairs:
        print(f"::error::no HAL/Include↔P2 pairs under {src}", file=sys.stderr)
        return 2

    all_errors: list[str] = []
    checked = 0
    for stem, h_path, c_path in pairs:
        # Count public decls for the summary even when clean.
        with open(h_path, encoding="utf-8", errors="replace") as fh:
            decls = extract_functions(fh.read(), want="decl")
        public_n = sum(1 for d in decls.values() if not d["static"])
        checked += public_n
        rel_h = os.path.relpath(h_path, os.path.dirname(src))
        for err in compare_pair(stem, h_path, c_path):
            all_errors.append(err)
            print(f"::error file=Firmware/MaDCore/src/HAL/Include/{stem}.h::{err}")

    if all_errors:
        print(
            f"\nFAIL: {len(all_errors)} HAL/P2 signature mismatch(es) "
            f"across {len(pairs)} pair(s), {checked} public symbol(s) checked."
        )
        return 1

    print(
        f"OK: {checked} public HAL symbol(s) across {len(pairs)} "
        f"Include↔P2 pair(s) — return type and arity agree."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
