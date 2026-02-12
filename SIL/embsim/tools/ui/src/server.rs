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
pub fn start(port: u16) {
    if SERVER_STARTED.swap(true, Ordering::Relaxed) {
        return;
    }

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
                    .route("/ws/{view_id}", get(ws_handler));

                let addr = format!("0.0.0.0:{}", port);
                info!("🖥  embsim UI: http://localhost:{}", port);

                let listener = tokio::net::TcpListener::bind(&addr)
                    .await
                    .expect("Failed to bind UI server");

                axum::serve(listener, app)
                    .await
                    .expect("UI server error");
            });
        })
        .expect("Failed to start UI server thread");
}

/// Serve the shell HTML page with all registered views.
async fn index_handler() -> impl IntoResponse {
    let registered = views().read();
    let html = shell::render(&registered);
    Html(html)
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
