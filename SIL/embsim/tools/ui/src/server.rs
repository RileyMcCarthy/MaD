//! Axum web server — serves the shell page and routes WebSocket connections
//! to the appropriate view handler.

use crate::{shell, views};
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::Path;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use axum::Router;
use std::sync::atomic::{AtomicBool, Ordering};
use tracing::info;

static SERVER_STARTED: AtomicBool = AtomicBool::new(false);

/// Start the web server on a background thread. Idempotent.
///
/// Binds synchronously so a bind failure (port in use, bad `EMBSIM_UI_BIND`)
/// is returned to the caller instead of panicking on a detached thread. The
/// serve loop then runs on a background thread.
pub fn start(port: u16) -> std::io::Result<()> {
    if SERVER_STARTED.swap(true, Ordering::Relaxed) {
        return Ok(());
    }

    // Bind loopback by default — this is a local dev tool, not a network
    // service. Override via EMBSIM_UI_BIND (e.g. "0.0.0.0") to expose it.
    let host = std::env::var("EMBSIM_UI_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());
    let addr = format!("{host}:{port}");
    let std_listener = std::net::TcpListener::bind(&addr)?;
    std_listener.set_nonblocking(true)?;
    info!("🖥  embsim UI: http://localhost:{}", port);

    std::thread::Builder::new()
        .name("embsim-ui".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to create tokio runtime for UI server");

            rt.block_on(async move {
                let app = Router::new()
                    .route("/", get(index_handler))
                    .route("/ws/{view_id}", get(ws_handler))
                    .route("/asset/{view_id}/{name}", get(asset_handler));

                let listener = tokio::net::TcpListener::from_std(std_listener)
                    .expect("Failed to adopt UI listener into tokio runtime");

                axum::serve(listener, app)
                    .await
                    .expect("UI server error");
            });
        })?;

    Ok(())
}

/// Serve the shell HTML page with all registered views.
async fn index_handler() -> impl IntoResponse {
    let registered = views().read();
    let html = shell::render(&registered);
    Html(html)
}

/// Serve a view's static asset (vendored library, image, etc.).
async fn asset_handler(Path((view_id, name)): Path<(String, String)>) -> impl IntoResponse {
    use axum::http::{header, StatusCode};
    let found = {
        let registered = views().read();
        registered.iter().find(|v| v.id == view_id).and_then(|v| {
            v.assets
                .iter()
                .find(|a| a.name == name)
                .map(|a| (a.content_type.clone(), a.bytes))
        })
    };
    match found {
        Some((content_type, bytes)) => (
            [(header::CONTENT_TYPE, content_type)],
            bytes,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "asset not found").into_response(),
    }
}

/// Route WebSocket connections to the matching view handler.
async fn ws_handler(
    Path(view_id): Path<String>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let handler = {
        let registered = views().read();
        registered
            .iter()
            .find(|v| v.id == view_id)
            .and_then(|v| v.ws_handler)
    };

    match handler {
        Some(h) => ws.on_upgrade(move |socket| h(socket)),
        None => ws.on_upgrade(|mut socket| async move {
            use axum::extract::ws::Message;
            let _ = socket.send(Message::Text(
                r#"{"error":"unknown view"}"#.into()
            )).await;
        }),
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    //! Drive the axum handlers directly (no socket bind) via `#[tokio::test]`.
    //! These mutate the global `VIEWS` registry, so they serialize against the
    //! lib.rs registry tests through the shared `crate::test_lock`.
    //!
    //! `ws_handler` / `start` are integration-level (they need a live WebSocket
    //! peer / a bound port) and are exercised by the Playwright E2E suite, not here.

    use super::{asset_handler, index_handler};
    use crate::{clear_views, register_view, View};
    use axum::body;
    use axum::extract::Path;
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    fn sample_view() -> View {
        View::new(
            "trace",
            "Trace Viewer",
            "📊",
            "<div id=\"trace-body\">hello</div>",
            ".trace { color: red; }",
            "console.log('trace');",
            None,
        )
        .with_asset("chart.js", b"VENDOR-BYTES", "application/javascript")
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    /// `index_handler` renders the shell page including the registered view's
    /// markup, nav tab, and the embsim doctype/title.
    #[tokio::test]
    async fn index_renders_shell_with_registered_view() {
        let _g = crate::test_lock::guard();
        clear_views();
        register_view(sample_view());

        let resp = index_handler().await.into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let html = body_string(resp).await;
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("<title>embsim</title>"));
        assert!(html.contains("<div id=\"trace-body\">hello</div>"), "view html injected");
        assert!(html.contains("data-view=\"trace\""), "nav tab rendered");

        clear_views();
    }

    /// `asset_handler` returns the registered asset's bytes + content-type.
    #[tokio::test]
    async fn asset_handler_serves_registered_asset() {
        let _g = crate::test_lock::guard();
        clear_views();
        register_view(sample_view());

        let resp = asset_handler(Path(("trace".to_string(), "chart.js".to_string())))
            .await
            .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/javascript"
        );
        let bytes = body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"VENDOR-BYTES");

        clear_views();
    }

    /// `asset_handler` 404s for an unknown asset name or unknown view id.
    #[tokio::test]
    async fn asset_handler_404_for_unknown() {
        let _g = crate::test_lock::guard();
        clear_views();
        register_view(sample_view());

        let unknown_name = asset_handler(Path(("trace".to_string(), "nope.js".to_string())))
            .await
            .into_response();
        assert_eq!(unknown_name.status(), StatusCode::NOT_FOUND);

        let unknown_view = asset_handler(Path(("ghost".to_string(), "chart.js".to_string())))
            .await
            .into_response();
        assert_eq!(unknown_view.status(), StatusCode::NOT_FOUND);

        clear_views();
    }
}
