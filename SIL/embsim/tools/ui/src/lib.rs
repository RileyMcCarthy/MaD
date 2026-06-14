//! embsim-ui — Pluggable web UI shell for embsim.
//!
//! Provides a single axum web server with a tabbed shell layout. Crates
//! register **views** (e.g. Trace Viewer, Machine Visualizer) at startup,
//! each bringing its own HTML/CSS/JS and an optional WebSocket handler.
//!
//! # Usage
//!
//! ```rust,ignore
//! use embsim_ui::{View, start_server};
//!
//! // Register views before starting the server
//! embsim_ui::register_view(View::new(
//!     "trace",                          // id (used in URL: /view/trace)
//!     "Trace Viewer",                   // display name
//!     "📊",                             // icon/emoji
//!     include_str!("static/trace.html"),
//!     include_str!("static/trace.css"),
//!     include_str!("static/trace.js"),
//!     Some(my_ws_handler),              // optional WebSocket handler
//! ));
//!
//! embsim_ui::start_server(3000);
//! ```

mod server;
mod shell;

use axum::extract::ws::WebSocket;
use parking_lot::RwLock;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

/// Type alias for an async WebSocket handler function.
///
/// Receives the raw `WebSocket` — the view implementation owns the
/// message loop and decides its own protocol.
pub type WsHandler = fn(WebSocket) -> Pin<Box<dyn Future<Output = ()> + Send>>;

/// A static asset (e.g. a vendored JS library) a view serves over HTTP.
/// Mounted at `/asset/<view_id>/<name>` so the view's HTML can reference it
/// with a local URL instead of a CDN (keeping the tool usable offline).
pub struct ViewAsset {
    /// File name as referenced in HTML (e.g. "chart.umd.min.js").
    pub name: String,
    /// Asset bytes (usually `include_bytes!`).
    pub bytes: &'static [u8],
    /// MIME type sent in the `Content-Type` header.
    pub content_type: String,
}

/// A registered UI view.
pub struct View {
    /// Short identifier, used in URL paths (e.g. "trace" → /view/trace).
    pub id: String,
    /// Human-readable display name shown in the navigation tab.
    pub name: String,
    /// Emoji or short string used as tab icon.
    pub icon: String,
    /// View-specific HTML (injected inside the content area, NOT a full page).
    pub html: String,
    /// View-specific CSS.
    pub css: String,
    /// View-specific JavaScript.
    pub js: String,
    /// Optional WebSocket handler. Mounted at `/ws/<id>`.
    pub ws_handler: Option<WsHandler>,
    /// Static assets served at `/asset/<id>/<name>` (vendored libraries, etc.).
    pub assets: Vec<ViewAsset>,
}

impl View {
    /// Create a new view with all fields (no assets).
    pub fn new(
        id: &str,
        name: &str,
        icon: &str,
        html: &str,
        css: &str,
        js: &str,
        ws_handler: Option<WsHandler>,
    ) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            icon: icon.to_string(),
            html: html.to_string(),
            css: css.to_string(),
            js: js.to_string(),
            ws_handler,
            assets: Vec::new(),
        }
    }

    /// Attach a static asset, served at `/asset/<id>/<name>`.
    pub fn with_asset(mut self, name: &str, bytes: &'static [u8], content_type: &str) -> Self {
        self.assets.push(ViewAsset {
            name: name.to_string(),
            bytes,
            content_type: content_type.to_string(),
        });
        self
    }
}

/// Global view registry.
static VIEWS: OnceLock<RwLock<Vec<View>>> = OnceLock::new();

fn views() -> &'static RwLock<Vec<View>> {
    VIEWS.get_or_init(|| RwLock::new(Vec::new()))
}

/// Register a view. Must be called before `start_server`.
pub fn register_view(view: View) {
    views().write().push(view);
}

/// Remove all registered views. Used to re-register a fresh view set for an
/// in-process restart; the running server reads the registry live.
pub fn clear_views() {
    views().write().clear();
}

/// Start the web UI server on the given port. Non-blocking (spawns a thread
/// after binding). Returns an error if the address cannot be bound.
pub fn start_server(port: u16) -> std::io::Result<()> {
    server::start(port)
}
