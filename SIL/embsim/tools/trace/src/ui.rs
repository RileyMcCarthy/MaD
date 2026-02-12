//! Trace viewer static assets — embedded at compile time from the `static/` directory.

/// View-specific HTML content (no `<html>` wrapper — injected into embsim-ui shell).
pub const HTML: &str = include_str!("../static/trace.html");

/// View-specific CSS.
pub const CSS: &str = include_str!("../static/trace.css");

/// View-specific JavaScript.
pub const JS: &str = include_str!("../static/trace.js");
