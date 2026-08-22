# Diagnostics: what shipped

The original plan here was a four-phase build. It was cut down, then most of the
cut items were added back once the logging proved its worth. This records what
exists and what is still deliberately out.

**Implemented** — see [LOGGING.md](LOGGING.md) for the detail:

- Structured session log, merged across the main thread and the device worker
- Raw 64 KiB serial byte tail with per-chunk metadata
- Protocol, app, store, storage, UI, performance and **firmware-flash**
  instrumentation
- Correlation ids linking a user action to the frames it produced
- Undecodable-traffic detection (the wrong-baud / bad-wiring case)
- **IndexedDB persistence**, so a reload no longer destroys the evidence
- **Computed triage summary** at the top of every bundle and issue
- **Review-before-send preview** naming the identifying details being published
- **`tools/view-diagnostics.mjs`** — timeline + annotated hex dump
- E2E failure artifacts, plus a 9-check diagnostics suite gating CI
- "Report a bug" → downloaded bundle + pre-filled GitHub issue

**Still deliberately out:**

| Not built | Why | What it would buy |
| --- | --- | --- |
| Incident freezing | Steady-state backoff took the ring from ~83 min to ~14 h, and persistence covers the crash case — the original motivation is largely gone | A pathologically chatty multi-day session still can't evict its own first failure |
| `/diagnostics` viewer screen | The console mirror covers the maintainer, and the report preview now covers the user | Non-technical users could browse and filter the log in-app |
| Gzip | Plain JSON is readable in any editor and the viewer handles the rest | Smaller attachments for very long sessions |
| Serverless intake | Breaks the no-backend property; needs a deployed secret and abuse handling | True one-click filing, no GitHub account needed |

Serverless intake is the only one that would meaningfully change what a
maintainer receives, and it costs the app its "no backend" property to get it.
