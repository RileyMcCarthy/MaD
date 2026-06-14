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
