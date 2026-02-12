//! Machine visualizer — static assets embedded at compile time.

/// View-specific HTML content.
pub const HTML: &str = include_str!("../static/machine.html");

/// View-specific CSS.
pub const CSS: &str = include_str!("../static/machine.css");

/// View-specific JavaScript.
pub const JS: &str = include_str!("../static/machine.js");
