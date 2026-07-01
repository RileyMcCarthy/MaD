#!/usr/bin/env python3
"""Assemble prompts for the advisory AI PR reviewer (free GitHub Models).

The free tier caps each request at ~16K input tokens, so we cannot feed the whole
repo. Instead, per *concern* (one per changed language + a cross-cutting docs pass)
we feed exactly three bounded things and let the model judge:

  1. the project's coding-guideline doc for that language (the codified expertise),
  2. a compact index of existing shared/reusable code in that area (so the model
     can flag duplication / missed reuse), and
  3. the PR's changed hunks for that language (bounded).

Two modes:
  --mode detect            print a JSON array of concern keys this PR touches
                           (consumed by the workflow's matrix `include`)
  --mode prep --concern K  write ai-system.md + ai-prompt.md for concern K

Stdlib only; shells out to `git`. Run from the repo root.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

# Byte budgets (≈ chars; ~4 chars/token). Keep the sum under ~60 KB so the whole
# request stays under the free-tier 16K-token input cap for openai/gpt-4o-mini.
GUIDE_BUDGET = 26000
INDEX_BUDGET = 6000
DIFF_BUDGET = 18000

REPO_DESC = (
    "MaD is a low-cost open-source uniaxial tensile-testing machine. Monorepo: "
    "Propeller 2 firmware (C, strictly layered APP->DEV->IO->Library->HAL->HW), a "
    "React/Vite + WebAssembly browser control app (Software/MaDWasmControl), a Rust "
    "software-in-the-loop emulator (SIL/), and a YAML->C/TS/Rust protocol generator "
    "(Protocol/). The firmware<->UI wire protocol is generated from "
    "Protocol/MaDProtocol.yaml."
)

# Concerns: one per language (routed by changed path) + a cross-cutting docs pass.
CONCERNS = {
    "c": {
        "title": "C / Firmware",
        "guide": "docs/coding-guidelines/c-firmware.md",
        "diff_pathspecs": ["Firmware/MaDCore/src/"],
        "extra": (
            "Pay special attention to the rules NO linter can check: the strict layer "
            "rule (APP->DEV->IO->Library->HAL->HW, downward only); HAL locks are NOT "
            "reentrant and a module must never call another module's API while holding "
            "its own lock (ABBA/self-deadlock); the state-machine idiom; one canonical "
            "_data struct per module. MISRA/cppcheck and build errors are enforced "
            "separately — do not re-report those."
        ),
    },
    "ts": {
        "title": "TypeScript / React (web app)",
        "guide": "docs/coding-guidelines/typescript.md",
        "diff_pathspecs": ["Software/MaDWasmControl/src/", "Software/MaDControl/src/"],
        "extra": (
            "The shipped app (Software/MaDWasmControl/src) must use only Web Serial + "
            "File System Access — no Electron, no test-only fakes in src/. Watch for "
            "exactOptionalPropertyTypes / null-vs-undefined semantics the compiler does "
            "not enforce. tsc/eslint errors are enforced separately — do not re-report."
        ),
    },
    "rust": {
        "title": "Rust / SIL",
        "guide": "docs/coding-guidelines/rust.md",
        "diff_pathspecs": ["SIL/", "Protocol/ProtoEmb/runtime/"],
        "extra": (
            "No generic embsim crate may depend on MaD-specific code. Repo-wide "
            "`cargo fmt` is forbidden — match the neighbouring style by hand. clippy/"
            "build errors are enforced separately — do not re-report those."
        ),
    },
    "python": {
        "title": "Python (protocol generator)",
        "guide": "docs/coding-guidelines/python.md",
        "diff_pathspecs": ["Protocol/ProtoEmb/core/", "Firmware/MaDCore/extra_scripts/"],
        "extra": (
            "Target Python 3.9. ruff is enforced separately — do not re-report lint. "
            "Focus on the generator's error-handling model and template hygiene."
        ),
    },
    "yaml": {
        "title": "Protocol YAML (wire schema)",
        "guide": "docs/coding-guidelines/protocol-yaml.md",
        "diff_pathspecs": ["Protocol/MaDProtocol.yaml"],
        "extra": (
            "CRITICAL: the wire format is append-only. Reordering or inserting enum "
            "variants, struct fields, or union variants silently breaks firmware<->UI<->"
            "SIL compatibility. Flag any reorder/insert and any breaking change that is "
            "not paired with a protocol_version bump, and remind that all three targets "
            "(C/TS/Rust) must be regenerated."
        ),
    },
    "docs": {
        "title": "Documentation freshness",
        "guide": None,  # cross-cutting; no single guide
        "diff_pathspecs": ["."],
        "extra": "",
    },
}

# Doc-only changes don't need a code review; the docs pass also skips when only docs changed.
DOC_RE = re.compile(r"(\.md$|^docs/|^mkdocs\.yml$|^site/)")


def git(*args: str) -> str:
    return subprocess.run(["git", *args], capture_output=True, text=True).stdout


def changed_files(base: str, head: str) -> list[str]:
    out = git("diff", "--name-only", f"{base}...{head}")
    return [ln for ln in out.splitlines() if ln.strip()]


def matches(path: str, pathspecs: list[str]) -> bool:
    return any(path == p or path.startswith(p) for p in pathspecs)


def diff_for(base: str, head: str, pathspecs: list[str]) -> str:
    args = ["diff", f"{base}...{head}", "--"]
    args += pathspecs if pathspecs != ["."] else ["."]
    return git(*args)


def walk_files(roots: list[str], exts: tuple[str, ...], skip: tuple[str, ...]) -> list[str]:
    found = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            if any(s in dirpath for s in skip):
                continue
            for f in sorted(files):
                if f.endswith(exts):
                    found.append(os.path.join(dirpath, f))
    return found


def _grep_lines(paths: list[str], pattern: re.Pattern, label_strip: str = "") -> list[str]:
    out = []
    for p in paths:
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if pattern.search(line):
                        rel = p[len(label_strip):] if label_strip and p.startswith(label_strip) else p
                        out.append(f"{rel}: {line.strip()}")
        except OSError:
            continue
    return out


def build_index(concern: str) -> str:
    """A compact map of existing shared/reusable symbols, so the model can flag duplication."""
    lines: list[str] = []
    if concern == "c":
        hdrs = walk_files(["Firmware/MaDCore/src"], (".h",), ("Generated", "Native"))
        decl = re.compile(r"^[A-Za-z_].*[A-Za-z0-9_]\s*\([^;{]*\)\s*;")
        lines = _grep_lines(hdrs, decl, "Firmware/MaDCore/src/")
    elif concern == "ts":
        srcs = walk_files(["Software/MaDWasmControl/src"], (".ts", ".tsx"),
                          ("generated", "node_modules", ".test.", ".spec."))
        exp = re.compile(r"export\s+(?:async\s+)?(?:function|const|type|interface|class|enum)\s+\w+")
        lines = _grep_lines(srcs, exp, "Software/MaDWasmControl/src/")
    elif concern == "rust":
        srcs = walk_files(["SIL/embsim", "SIL/mad-protocol"], (".rs",), ("target", "generated"))
        pub = re.compile(r"^\s*pub\s+(?:fn|struct|trait|enum|type)\s+\w+")
        lines = _grep_lines(srcs, pub, "SIL/")
    elif concern == "python":
        srcs = walk_files(["Protocol/ProtoEmb/core"], (".py",), ("__pycache__",))
        defs = re.compile(r"^(?:def|class)\s+\w+")
        lines = _grep_lines(srcs, defs, "Protocol/ProtoEmb/")
    elif concern == "yaml":
        try:
            with open("Protocol/MaDProtocol.yaml", encoding="utf-8") as fh:
                for line in fh:
                    m = re.match(r"^  (\w+):\s*$", line)  # top-level type/message names
                    if m:
                        lines.append(m.group(1))
        except OSError:
            pass
        return "Existing schema type/message names (wire format is append-only):\n" + ", ".join(lines)
    if not lines:
        return "(no shared-code index available for this area)"
    text = "\n".join(lines)
    return text[:INDEX_BUDGET] + ("\n... (index truncated)" if len(text) > INDEX_BUDGET else "")


SYSTEM_TMPL = """You are a senior engineer reviewing a pull request on the MaD codebase.
{repo}

You are reviewing the **{title}** changes. You are given the project's coding
guidelines for this area, an index of existing shared/reusable code, and the PR's
changed hunks. Produce a concise, HIGH-SIGNAL advisory review covering only what the
diff shows:

1. GUIDELINE ADHERENCE — cite the specific guideline rule a change violates (quote it briefly).
2. REUSE / DUPLICATION — if the change reimplements something already in the shared-code index or an obvious existing utility, point to the existing API to use instead.
3. DOCS — name any documentation this change makes stale or incomplete.
4. TESTS — if a behaviour change lacks a matching test update, say so.
5. EXPERT SUGGESTIONS — design/correctness/safety/idiom improvements a senior engineer on THIS codebase would raise.
{extra}

Rules: tie every point to a file/path in the diff. Prefer precision over volume (max ~8 bullets). Do NOT restate the diff or re-report what linters/compilers already catch. If the change looks good, say so briefly. This is advisory — suggest, don't demand.

Format: a one-line verdict, then grouped bullets under the headings above (omit empty headings)."""

DOCS_SYSTEM = """You are a documentation reviewer for the MaD codebase.
{repo}

You are given the PR's code diff and the list of documentation files in the repo.
Decide whether the change leaves any documentation MISSING, INCORRECT, or STALE
(a new/renamed command, flag, env var, G-code, public API, file move, or behaviour
change that the docs no longer match).

Rules: only reference docs from the provided inventory; name the doc file and the
exact thing to add or fix, tied to a concrete change in the diff. Max 6 bullets. If
the docs already cover the change, reply exactly: "✅ Docs look up to date for this change."
This is advisory."""


def write_prep(concern: str, base: str, head: str) -> None:
    c = CONCERNS[concern]
    if concern == "docs":
        files = changed_files(base, head)
        non_doc = [f for f in files if not DOC_RE.search(f)]
        system = DOCS_SYSTEM.format(repo=REPO_DESC)
        inventory = git("ls-files", "*.md", "mkdocs.yml")
        diff = diff_for(base, head, ["."])[:DIFF_BUDGET]
        prompt = (
            "## Files changed\n```\n" + "\n".join(files) + "\n```\n\n"
            "## Documentation inventory (reference only these)\n```\n" + inventory + "```\n\n"
            "## Code diff (truncated)\n```diff\n" + diff + "\n```\n"
        )
    else:
        system = SYSTEM_TMPL.format(repo=REPO_DESC, title=c["title"], extra=c["extra"])
        guide = ""
        if c["guide"] and os.path.exists(c["guide"]):
            with open(c["guide"], encoding="utf-8") as fh:
                guide = fh.read()[:GUIDE_BUDGET]
        index = build_index(concern)
        diff = diff_for(base, head, c["diff_pathspecs"])[:DIFF_BUDGET]
        prompt = (
            f"## Coding guidelines — {c['title']}\n" + guide + "\n\n"
            "## Existing shared/reusable code in this area (use, don't duplicate)\n```\n"
            + index + "\n```\n\n"
            "## Changed hunks in this PR (truncated)\n```diff\n" + diff + "\n```\n"
        )
    with open("ai-system.md", "w", encoding="utf-8") as fh:
        fh.write(system)
    with open("ai-prompt.md", "w", encoding="utf-8") as fh:
        fh.write(prompt)
    print(f"Wrote ai-system.md ({len(system)} B) + ai-prompt.md ({len(prompt)} B) for '{concern}'")


def detect(base: str, head: str) -> None:
    files = changed_files(base, head)
    touched = []
    for key, c in CONCERNS.items():
        if key == "docs":
            # docs pass runs whenever any non-doc file changed (something to check docs against)
            if any(not DOC_RE.search(f) for f in files):
                touched.append(key)
            continue
        if any(matches(f, c["diff_pathspecs"]) for f in files):
            touched.append(key)
    # GitHub Actions matrix `include` list
    include = [{"concern": k, "title": CONCERNS[k]["title"]} for k in touched]
    print(json.dumps(include))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["detect", "prep"], required=True)
    ap.add_argument("--concern", choices=list(CONCERNS))
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    args = ap.parse_args()
    if args.mode == "detect":
        detect(args.base, args.head)
    else:
        if not args.concern:
            print("--concern required for --mode prep", file=sys.stderr)
            return 2
        write_prep(args.concern, args.base, args.head)
    return 0


if __name__ == "__main__":
    sys.exit(main())
