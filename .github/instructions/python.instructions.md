---
applyTo: "Protocol/ProtoEmb/core/**,Firmware/MaDCore/extra_scripts/**"
---

Python (protocol generator + PlatformIO SCons hooks). Full conventions:
`docs/coding-guidelines/python.md`. Target Python 3.9.

Focus on what ruff can't decide:
- the generator's error-handling model (accumulate errors, then report; `SystemExit` vs
  `ValueError` by cause);
- schema-enrichment conventions (`_`-prefixed computed keys, don't overwrite raw keys);
- Jinja template hygiene — no logic pushed into templates, use the configured `prefix`
  (not a hardcoded name), keep the DO-NOT-EDIT banner.

Don't re-report ruff findings.
