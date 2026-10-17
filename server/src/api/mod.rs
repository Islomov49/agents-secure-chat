//! HTTP API `/api/v1` (PROTOCOL §6).

mod blobs;
mod events;
mod presence;
mod rooms;
mod stream;

use std::{net::IpAddr, time::Duration};

use axum::{
    Router,
    http::{HeaderName, HeaderValue, Method, header},
    middleware,
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use tower_http::{
    cors::{Any, CorsLayer},
    set_header::SetResponseHeaderLayer,
};

use crate::{
    auth,
    db::{Event, PurgeReason, Room},
    error::{ApiError, ApiResult},
    gc, ratelimit,
    state::AppState,
};

/// Default and maximum page size for `events` and `wait`.
const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 1000;

pub fn routes(state: &AppState) -> Router<AppState> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            HeaderName::from_static(auth::HEADER_PUB),
            HeaderName::from_static(auth::HEADER_TS),
            HeaderName::from_static(auth::HEADER_NONCE),
            HeaderName::from_static(auth::HEADER_SIG),
        ])
        .expose_headers([header::RETRY_AFTER])
        .max_age(Duration::from_secs(3600));

    Router::new()
        .route("/api/v1/info", get(rooms::server_info))
        .route("/api/v1/rooms/{room}", get(rooms::room_info).delete(rooms::delete_room))
        .route("/api/v1/rooms/{room}/session", post(rooms::create_session))
        .route("/api/v1/rooms/{room}/restore", post(rooms::restore_room))
        .route("/api/v1/rooms/{room}/ttl", put(rooms::set_ttl))
        .route("/api/v1/rooms/{room}/events", get(events::list).post(events::append))
        .route("/api/v1/rooms/{room}/wait", get(events::wait))
        .route("/api/v1/rooms/{room}/presence", get(presence::list).post(presence::report))
        .route("/api/v1/rooms/{room}/blobs/{blob}", get(blobs::download).put(blobs::upload))
        .route("/api/v1/rooms/{room}/stream", get(stream::stream))
        .layer(middleware::from_fn_with_state(state.clone(), ratelimit::limit_requests))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .layer(cors)
}

/// The room row, treating a room past its grace period as gone (and purging it on the spot).
async fn live_room(state: &AppState, room: &str, now: i64) -> ApiResult<Option<Room>> {
    match state.db.room(room).await? {
        Some(r) if r.is_expired(now) => {
            gc::purge(state, room, PurgeReason::Expired, now).await?;
            Ok(None)
        }
        other => Ok(other),
    }
}

/// Admission for writes that may create the room: rejects deleted rooms and applies the
/// new-rooms-per-IP limit when the room does not exist yet.
async fn admit_write(state: &AppState, room: &str, ip: IpAddr, now: i64) -> ApiResult<()> {
    match live_room(state, room, now).await? {
        Some(r) if r.is_deleted() => Err(ApiError::room_deleted(r.purge_at)),
        Some(_) => Ok(()),
        None => state.ip_new_rooms.check(ip, now).map_err(ApiError::rate_limited),
    }
}

#[derive(Debug, Default, Serialize)]
struct EventsPage {
    events: Vec<Event>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<DeletedMark>,
}

#[derive(Debug, Serialize)]
struct DeletedMark {
    purge_at: i64,
}

async fn read_events(state: &AppState, room: &str, after: i64, limit: i64, now: i64) -> ApiResult<EventsPage> {
    Ok(match live_room(state, room, now).await? {
        None => EventsPage::default(),
        Some(r) if r.is_deleted() => {
            EventsPage { events: Vec::new(), deleted: Some(DeletedMark { purge_at: r.purge_at.unwrap_or(now) }) }
        }
        Some(r) if r.last_seq <= after => EventsPage::default(),
        Some(_) => EventsPage { events: state.db.events_after(room, after, limit).await?, deleted: None },
    })
}

#[derive(Debug, Deserialize)]
struct PageQuery {
    after: Option<i64>,
    limit: Option<i64>,
}

fn page_params(after: Option<i64>, limit: Option<i64>) -> ApiResult<(i64, i64)> {
    let after = after.unwrap_or(0);
    if after < 0 {
        return Err(ApiError::bad_request("`after` must be a non-negative seq"));
    }
    Ok((after, limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)))
}

fn check_sender(sender: &str) -> ApiResult<()> {
    if crate::crypto::is_id16(sender) {
        Ok(())
    } else {
        Err(ApiError::bad_request("`sender` must be a participant id (base64url of 16 bytes)"))
    }
}
