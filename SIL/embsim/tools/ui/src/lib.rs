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

/// Crate-wide test serialization for the global `VIEWS` registry.
///
/// Both the `lib.rs` registry tests and the `server.rs` handler tests mutate the
/// process-global registry, so they must run one at a time across the whole test
/// binary — a single shared lock guarantees that.
#[cfg(test)]
pub(crate) mod test_lock {
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    /// Take the registry lock, recovering from poison left by a panicking test
    /// (matches the `pulse_out.rs` pattern).
    pub fn guard() -> std::sync::MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|p| {
            LOCK.clear_poison();
            p.into_inner()
        })
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Registry tests share the crate-wide `VIEWS` lock (see [`crate::test_lock`])
    /// so they serialize against the `server.rs` handler tests as well.
    use crate::test_lock::guard as lock_or_recover;

    /// Build a minimal view with distinct, asserting-friendly field values.
    fn sample_view(id: &str) -> View {
        View::new(
            id,
            "Display Name",
            "🔥",
            "<p>body</p>",
            ".x { color: red; }",
            "console.log('hi');",
            None,
        )
    }

    // ── View::new ──

    /// `View::new` copies every argument into the matching field and starts with
    /// an empty asset list and no WebSocket handler.
    #[test]
    fn view_new_sets_all_fields_and_empty_assets() {
        let v = View::new(
            "trace",
            "Trace Viewer",
            "📊",
            "<div>html</div>",
            ".css{}",
            "var js;",
            None,
        );
        assert_eq!(v.id, "trace");
        assert_eq!(v.name, "Trace Viewer");
        assert_eq!(v.icon, "📊");
        assert_eq!(v.html, "<div>html</div>");
        assert_eq!(v.css, ".css{}");
        assert_eq!(v.js, "var js;");
        assert!(v.ws_handler.is_none());
        assert!(v.assets.is_empty(), "a fresh view has no assets");
    }

    /// A `View` can carry a WebSocket handler; `ws_handler` is `Some` when one
    /// is supplied to `new`.
    #[test]
    fn view_new_accepts_ws_handler() {
        fn handler(_ws: WebSocket) -> Pin<Box<dyn Future<Output = ()> + Send>> {
            Box::pin(async {})
        }
        let h: WsHandler = handler;
        let v = View::new("ws", "WS", "🔌", "", "", "", Some(h));
        assert!(v.ws_handler.is_some(), "supplied handler is stored");
    }

    // ── View::with_asset ──

    /// `with_asset` appends a `ViewAsset` with the given name, bytes, and
    /// content-type, and returns the view for chaining.
    #[test]
    fn with_asset_appends_one_asset() {
        let v = sample_view("v").with_asset("chart.js", b"BYTES", "application/javascript");
        assert_eq!(v.assets.len(), 1);
        let a = &v.assets[0];
        assert_eq!(a.name, "chart.js");
        assert_eq!(a.bytes, b"BYTES");
        assert_eq!(a.content_type, "application/javascript");
    }

    /// `with_asset` chains: each call appends (never overwrites), preserving the
    /// call order of the assets.
    #[test]
    fn with_asset_chains_and_preserves_order() {
        let v = sample_view("v")
            .with_asset("a.js", b"AAA", "text/javascript")
            .with_asset("b.css", b"BBB", "text/css")
            .with_asset("c.png", b"CCC", "image/png");
        assert_eq!(v.assets.len(), 3, "all three assets are appended");
        let names: Vec<&str> = v.assets.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["a.js", "b.css", "c.png"], "append order preserved");
        assert_eq!(v.assets[1].bytes, b"BBB");
        assert_eq!(v.assets[2].content_type, "image/png");
    }

    /// An empty byte slice is a valid asset payload.
    #[test]
    fn with_asset_allows_empty_bytes() {
        let v = sample_view("v").with_asset("empty", b"", "text/plain");
        assert_eq!(v.assets.len(), 1);
        assert!(v.assets[0].bytes.is_empty());
    }

    // ── register_view / clear_views / views() ──

    /// After `clear_views()` then a single `register_view`, the registry holds
    /// exactly that one view.
    #[test]
    fn register_then_views_contains_exactly_that_view() {
        let _g = lock_or_recover();
        clear_views();
        register_view(sample_view("only"));
        let reg = views().read();
        assert_eq!(reg.len(), 1, "exactly one registered view");
        assert_eq!(reg[0].id, "only");
    }

    /// `clear_views()` empties the registry even when several views are present.
    #[test]
    fn clear_views_empties_the_registry() {
        let _g = lock_or_recover();
        clear_views();
        register_view(sample_view("a"));
        register_view(sample_view("b"));
        assert_eq!(views().read().len(), 2);
        clear_views();
        assert!(views().read().is_empty(), "registry empty after clear");
    }

    /// Registering two views preserves their insertion order.
    #[test]
    fn register_preserves_insertion_order() {
        let _g = lock_or_recover();
        clear_views();
        register_view(sample_view("first"));
        register_view(sample_view("second"));
        let reg = views().read();
        assert_eq!(reg.len(), 2);
        assert_eq!(reg[0].id, "first");
        assert_eq!(reg[1].id, "second");
    }

    /// `clear_views()` on an already-empty registry is a no-op (idempotent).
    #[test]
    fn clear_views_on_empty_is_noop() {
        let _g = lock_or_recover();
        clear_views();
        clear_views();
        assert!(views().read().is_empty());
    }
}
