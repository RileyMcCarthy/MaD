# Diagnostics: what shipped

The original plan here was a four-phase build (flight recorder, IndexedDB
persistence, incident freezing, a `/diagnostics` viewer screen, a serverless
intake endpoint). It was deliberately cut down to the parts that earn their
keep for a single-maintainer project. This records what exists and what was
dropped, so the gaps read as decisions rather than oversights.

**Implemented** — see [LOGGING.md](LOGGING.md) for the detail:

- Structured session log, merged across the main thread and the device worker
- Raw 64 KiB serial byte tail with per-chunk metadata
- Protocol, app, store, storage, UI and performance instrumentation
- Correlation ids linking a user action to the frames it produced
- E2E failure artifacts carrying the full merged log
- "Report a bug" → downloaded bundle + pre-filled GitHub issue

**Deliberately deferred:**

| Dropped | Why | What it would buy |
| --- | --- | --- |
| IndexedDB persistence | Adds a storage surface and a retention policy | A report would survive "the app froze so I reloaded" — currently that loses the log |
| Incident freezing | The ring holds a long session already | A two-hour run can evict the interesting 30 s before the user files anything |
| `/diagnostics` viewer screen | The DevTools console mirror covers the maintainer's own use | Non-technical users could see and filter the log themselves |
| Gzip + CLI decoder | Plain JSON is readable in any editor | Smaller attachments for very long sessions |
| Serverless intake | Breaks the no-backend property; needs a deployed secret and abuse handling | True one-click filing, no GitHub account needed |

The first two are the ones most likely to be worth revisiting: they are the
difference between "the user filed a report" and "the user filed a report that
contains the failure."
