//! lincor-server: a deliberately dumb relay for end-to-end encrypted rooms.
//!
//! It stores opaque ciphertext envelopes and blobs per room, authenticates requests with Ed25519
//! signatures whose public key hashes to the room id, and never sees keys or plaintext.

pub mod api;
pub mod auth;
pub mod blobs;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod gc;
pub mod hub;
pub mod presence;
pub mod ratelimit;
pub mod state;
pub mod util;
pub mod web;

use std::{future::Future, net::SocketAddr, time::Instant};

use axum::{
    Router,
    extract::{MatchedPath, Request},
    middleware::{self, Next},
    response::Response,
};
use tokio::net::TcpListener;

pub use config::Config;
pub use state::AppState;

/// The complete HTTP application.
pub fn router(state: &AppState) -> Router {
    api::routes(state).merge(web::routes()).layer(middleware::from_fn(log_request)).with_state(state.clone())
}

/// Access log: method, route template (or path), status and latency. Never the query string
/// (it may carry a session token), headers or bodies.
async fn log_request(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let route = match req.extensions().get::<MatchedPath>() {
        Some(p) => p.as_str().to_owned(),
        None => req.uri().path().to_owned(),
    };
    let started = Instant::now();
    let res = next.run(req).await;
    tracing::info!(
        target: "lincor::http",
        %method,
        route,
        status = res.status().as_u16(),
        ms = started.elapsed().as_millis() as u64,
    );
    res
}

/// Serves on `listener` until `shutdown` resolves, running the retention loop alongside.
pub async fn serve(
    listener: TcpListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let gc = gc::spawn(state.clone());
    let token = state.shutdown.clone();
    let result = axum::serve(listener, router(&state).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown.await;
            // Ends long polls and streams so the graceful shutdown does not wait for them.
            token.cancel();
        })
        .await;
    state.shutdown.cancel();
    let _ = gc.await;
    result
}

/// Starts the server described by `config` and runs until SIGINT/SIGTERM.
pub async fn run(config: Config) -> anyhow::Result<()> {
    let state = AppState::new(config).await?;
    let listener = TcpListener::bind(state.config.bind).await?;
    tracing::info!(
        addr = %listener.local_addr()?,
        database = ?state.db.backend(),
        version = config::VERSION,
        "lincor-server listening"
    );
    serve(listener, state.clone(), shutdown_signal()).await?;
    state.db.close().await;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    tracing::info!("shutting down");
}
