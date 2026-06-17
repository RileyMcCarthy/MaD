//! Trace viewer static assets — embedded at compile time from the `static/` directory.

/// View-specific HTML content (no `<html>` wrapper — injected into embsim-ui shell).
pub const HTML: &str = include_str!("../static/trace.html");

/// View-specific CSS.
pub const CSS: &str = include_str!("../static/trace.css");

/// View-specific JavaScript.
pub const JS: &str = include_str!("../static/trace.js");

#[cfg(test)]
mod tests {
    use super::*;

    /// The compile-time-embedded view assets must be non-empty, otherwise the
    /// trace tab would render blank in the embsim-ui shell.
    #[test]
    fn embedded_assets_are_non_empty() {
        assert!(!HTML.trim().is_empty(), "trace.html must be embedded");
        assert!(!CSS.trim().is_empty(), "trace.css must be embedded");
        assert!(!JS.trim().is_empty(), "trace.js must be embedded");
    }
}
