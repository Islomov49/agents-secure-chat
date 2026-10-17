use std::time::Duration;

use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::{EventsPage, PageQuery, admit_write, check_sender, page_params, read_events};
use crate::{
    auth::Authed,
    crypto,
    db::NewEvent,
    error::{ApiError, ApiResult},
    presence::{self, ListenGuard},
    state::AppState,
    util::now_ms,
};

const DEFAULT_WAIT_SECS: f64 = 30.0;
const MAX_WAIT_SECS: f64 = 600.0;

/// `GET /rooms/:room/events?after=&limit=`
pub async fn list(State(state): State<AppState>, req: Authed) -> ApiResult<Json<EventsPage>> {
    let q: PageQuery = req.query()?;
    let (after, limit) = page_params(q.after, q.limit)?;
    Ok(Json(read_events(&state, req.room(), after, limit, now_ms()).await?))
}

#[derive(Deserialize)]
struct AppendBody {
    cid: String,
    sender: String,
    data: String,
}

#[derive(Serialize)]
pub struct AppendResponse {
    seq: i64,
    ts: i64,
    /// True when this event created the room (lazy creation).
    created: bool,
}

/// `POST /rooms/:room/events` → `201 {seq, ts, created}`, or `200` with the original seq for a known cid.
pub async fn append(State(state): State<AppState>, req: Authed) -> ApiResult<(StatusCode, Json<AppendResponse>)> {
    let body: AppendBody = req.json()?;
    if !crypto::is_id16(&body.cid) {
        return Err(ApiError::bad_request("`cid` must be base64url of 16 bytes"));
    }
    check_sender(&body.sender)?;
    let max = state.config.limits.max_event_bytes;
    if body.data.len() > max {
        return Err(ApiError::too_large(format!("`data` exceeds {max} characters")));
    }
    if body.data.is_empty() || !crypto::is_b64u(&body.data) {
        return Err(ApiError::bad_request("`data` must be non-empty base64url"));
    }

    let room = req.room();
    let now = now_ms();
    state.check_room_write(room, now)?;
    admit_write(&state, room, req.ip, now).await?;
    let event = NewEvent { room, auth_pub: &req.auth.auth_pub, cid: &body.cid, sender: &body.sender, data: &body.data };
    let limits = &state.config.limits;
    let out = state.db.append_event(&event, now, limits.room_quota_bytes, limits.max_senders).await?;
    if out.duplicate {
        return Ok((StatusCode::OK, Json(AppendResponse { seq: out.seq, ts: out.ts, created: false })));
    }
    state.hub.notify(room);
    Ok((StatusCode::CREATED, Json(AppendResponse { seq: out.seq, ts: out.ts, created: out.room_created })))
}

#[derive(Deserialize)]
struct WaitQuery {
    after: Option<i64>,
    limit: Option<i64>,
    timeout: Option<f64>,
    sender: Option<String>,
}

/// `GET /rooms/:room/wait?after=&timeout=&sender=&limit=`: long poll for events after `after`.
pub async fn wait(State(state): State<AppState>, req: Authed) -> ApiResult<Json<EventsPage>> {
    let q: WaitQuery = req.query()?;
    let (after, limit) = page_params(q.after, q.limit)?;
    let timeout = q.timeout.unwrap_or(DEFAULT_WAIT_SECS);
    if !timeout.is_finite() {
        return Err(ApiError::bad_request("`timeout` must be a number of seconds"));
    }
    let deadline = Instant::now() + Duration::from_secs_f64(timeout.clamp(1.0, MAX_WAIT_SECS));
    if let Some(sender) = &q.sender {
        check_sender(sender)?;
    }

    let room = req.room();
    let poll = state.config.poll_interval;
    let mut changes = state.hub.subscribe(room);
    let mut listening: Option<ListenGuard> = None;
    loop {
        changes.borrow_and_update();
        let page = read_events(&state, room, after, limit, now_ms()).await?;
        if !page.events.is_empty() || page.deleted.is_some() {
            return Ok(Json(page));
        }
        if listening.is_none()
            && let Some(sender) = &q.sender
        {
            listening = Some(presence::listen(&state, room, sender).await);
        }
        tokio::select! {
            changed = changes.changed() => {
                if changed.is_err() {
                    tokio::time::sleep(poll).await;
                }
            }
            () = tokio::time::sleep(poll) => {}
            () = tokio::time::sleep_until(deadline) => return Ok(Json(page)),
            () = state.shutdown.cancelled() => return Ok(Json(page)),
        }
        if let Some(guard) = listening.as_mut() {
            guard.refresh().await;
        }
    }
}
