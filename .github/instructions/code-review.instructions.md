---
applyTo: "**"
---

# PR review focus (MaD)

When reviewing pull requests for this repository:

1. **Docs** — If behaviour, APIs, protocol, G-code, build commands, or architecture
   changed without corresponding docs (`Claude.md`, `docs/`, coding guidelines), leave a
   comment naming the file(s) to update.

2. **Tests in this PR** — Behaviour changes need matching coverage (Unity / Vitest /
   SIL / e2e as appropriate). Flag gaps tied to the diff.

3. **Suggested additional testing** — For higher-risk areas (motion, control states,
   NVRAM, protocol wire, serial/WASM sample path, FFI), suggest concrete follow-up tests
   the author can implement later. Phrase them so **Fix with Copilot** or `@copilot` can
   open a follow-up PR (scenario + expected assertion + suggested location).

4. **Do not re-report** MISRA, ESLint, `tsc`, Clippy, ruff, schema-validator, or
   layering-linter failures — CI already gates those.

5. **Never** request that the UI become a safety authority (e.g. halt on tab close).
