---
applyTo: "Firmware/MaDCore/extra_scripts/**"
---

Python (PlatformIO SCons hooks; the ProtoEmb generator lives in its own repo —
github.com/RileyMcCarthy/protoemb — with its own instructions). Full
conventions: `docs/coding-guidelines/python.md`. Target Python 3.9.

Focus on what ruff can't decide:
- SCons hook constraints: `Import("env")` injects `env` (F821 is ignored for
  these files); a hook must fail the build via `env.Exit(1)` with an actionable
  message, never a bare traceback or a silent skip of a required step;
- keep hooks dependency-light (deps are pip-installed into PlatformIO's Python
  at build time);
- user-facing errors: `SystemExit("message")`, never bare `exit()` or `assert`.

Don't re-report ruff findings.
