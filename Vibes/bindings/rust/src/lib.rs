//! Declare a behaviour from a Rust test and emit it to `behaviours.jsonl`.
//!
//! ```ignore
//! use vibes_behaviour::{behaviour, Behaviour};
//!
//! #[test]
//! fn gantry_stops_at_the_soft_limit() {
//!     behaviour!(Behaviour {
//!         id: "motion.soft-limit",
//!         covers: Some("models/src/gantry.rs#step"),
//!         given: "a move commanded past the configured soft limit",
//!         then: "the gantry stops at the limit and raises a fault",
//!         why: None,
//!     });
//!     // ... assertions
//! }
//! ```
//!
//! See `../SCHEMA.md` for the wire contract. Two rules it imposes:
//!
//! 1. **Call it first in the test body.** The record is written on entry. If it
//!    were written at the end, a panicking test would emit nothing and Vibes
//!    would report the behaviour as REMOVED — "this PR deleted a behaviour"
//!    when a test merely panicked is the worst misreport available.
//! 2. **No status.** Pass/fail has not happened yet. Vibes joins it from the
//!    harness output on `test`.
//!
//! Inert unless `$VIBES_BEHAVIOURS` names a file, so the suite runs normally on
//! its own, and never panics: a ledger that cannot be written is a reporting
//! problem and the test's own verdict is unaffected.

use std::fs::OpenOptions;
use std::io::Write;

/// Longest string field emitted. Keeps a record under `PIPE_BUF` so concurrent
/// test threads cannot interleave a partial line.
const MAX_FIELD: usize = 512;

pub struct Behaviour<'a> {
    /// Stable across rewording — this is what makes a reworded test a metadata
    /// change rather than one behaviour deleted and another added.
    pub id: &'a str,
    /// `path#symbol`, repo-relative. Joins this behaviour to patch coverage.
    pub covers: Option<&'a str>,
    pub given: &'a str,
    pub then: &'a str,
    /// Why it matters — a pinned defect, a requirement.
    pub why: Option<&'a str>,
}

fn escape(out: &mut String, s: &str) {
    for c in s.chars().take(MAX_FIELD) {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Any other control character would make the line unparseable.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

fn field(out: &mut String, key: &str, value: &str) {
    if value.is_empty() {
        return;
    }
    out.push_str(",\"");
    out.push_str(key);
    out.push_str("\":\"");
    escape(out, value);
    out.push('"');
}

/// The harness names each test thread after the test it is running, and does so
/// under `--test-threads=1` too (verified on cargo 1.96). That is the only
/// stable handle on the test's own name — Rust has no `function_name!()` — and
/// it is the key Vibes joins pass/fail on.
fn test_name() -> String {
    std::thread::current()
        .name()
        .map(str::to_owned)
        .unwrap_or_default()
}

/// Called via [`behaviour!`], which supplies `file` from the call site.
pub fn emit_at(b: Behaviour<'_>, file: &str) {
    let path = match std::env::var("VIBES_BEHAVIOURS") {
        Ok(p) if !p.is_empty() => p,
        _ => return, // not running under Vibes
    };

    let mut line = String::with_capacity(256);
    line.push_str("{\"v\":1,\"lang\":\"rust\"");
    field(&mut line, "id", b.id);
    field(&mut line, "test", &test_name());
    field(&mut line, "file", file);
    field(&mut line, "covers", b.covers.unwrap_or_default());
    field(&mut line, "given", b.given);
    field(&mut line, "then", b.then);
    field(&mut line, "why", b.why.unwrap_or_default());
    line.push_str("}\n");

    // Append: concurrent test threads each write one short record, and an
    // O_APPEND write below PIPE_BUF lands atomically.
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        // A failed write is a reporting problem, never a test failure.
        let _ = f.write_all(line.as_bytes());
    }
}

/// Declare a behaviour. Call it as the first statement in the test body.
#[macro_export]
macro_rules! behaviour {
    ($b:expr $(,)?) => {
        $crate::emit_at($b, file!())
    };
}
