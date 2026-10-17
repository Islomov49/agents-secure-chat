use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use super::live_room;
use crate::{
    auth::{Authed, Credential},
    config::{Limits, VERSION},
    db::{Restore, SoftDelete},
    error::{ApiError, ApiResult},
    gc,
    state::AppState,
    util::now_ms,
};

const MAX_TTL_DAYS: i64 = 36_500;

#[derive(Serialize)]
pub struct ServerInfo {
    version: &'static str,
    cli_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_url: Option<String>,
    limits: InfoLimits,
}

#[derive(Serialize)]
struct InfoLimits {
    #[serde(flatten)]
    limits: Limits,
    inactive_days: f64,
    empty_room_days: f64,
    delete_grace_secs: u64,
    max_wait_secs: u64,
    presence_timeout_secs: u64,
    session_ttl_secs: u64,
}

/// `GET /api/v1/info` (no auth).
pub async fn server_info(State(state): State<AppState>) -> Json<ServerInfo> {
    let c = &state.config;
    let days = |d: std::time::Duration| d.as_secs_f64() / 86_400.0;
    Json(ServerInfo {
        version: VERSION,
        cli_command: c.cli_command.clone(),
        public_url: c.public_url.clone(),
        source_url: c.source_url.clone(),
        limits: InfoLimits {
            limits: c.limits.clone(),
            inactive_days: days(c.retention.inactive_after),
            empty_room_days: days(c.retention.empty_room_after),
            delete_grace_secs: c.retention.delete_grace.as_secs(),
            max_wait_secs: 600,
            presence_timeout_secs: c.presence_timeout.as_secs(),
            session_ttl_secs: c.session_ttl.as_secs(),
        },
    })
}

#[derive(Serialize)]
pub struct RoomInfo {
    exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    msg_ttl_days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purge_at: Option<i64>,
    usage_bytes: i64,
    event_count: i64,
}

/// `GET /rooms/:room` — unknown rooms report `exists: false`, never 404.
pub async fn room_info(State(state): State<AppState>, req: Authed) -> ApiResult<Json<RoomInfo>> {
    let info = match live_room(&state, req.room(), now_ms()).await? {
        None => RoomInfo {
            exists: false,
            created_at: None,
            msg_ttl_days: None,
            deleted_at: None,
            purge_at: None,
            usage_bytes: 0,
            event_count: 0,
        },
        Some(r) => RoomInfo {
            exists: true,
            created_at: Some(r.created_at),
            msg_ttl_days: r.msg_ttl_days,
            deleted_at: r.deleted_at,
            purge_at: r.purge_at,
            usage_bytes: r.usage_bytes,
            event_count: r.event_count,
        },
    };
    Ok(Json(info))
}

#[derive(Serialize)]
pub struct SessionToken {
    token: String,
    expires_at: i64,
}

/// `POST /rooms/:room/session` — exchanges a signed request for a bearer token.
pub async fn create_session(State(state): State<AppState>, req: Authed) -> ApiResult<Json<SessionToken>> {
    if req.auth.credential != Credential::Signed {
        return Err(ApiError::auth("a session can only be created with a signed request"));
    }
    let (token, expires_at) = state.sessions.issue(req.room(), &req.auth.auth_pub, now_ms());
    Ok(Json(SessionToken { token, expires_at }))
}

#[derive(Serialize)]
pub struct Deleted {
    deleted_at: i64,
    purge_at: i64,
}

/// `DELETE /rooms/:room` — soft delete; restorable until `purge_at`.
pub async fn delete_room(State(state): State<AppState>, req: Authed) -> ApiResult<Json<Deleted>> {
    let room = req.room();
    let now = now_ms();
    state.check_room_write(room, now)?;
    if live_room(&state, room, now).await?.is_none() {
        return Err(ApiError::not_found("this room has no data on the server"));
    }
    let grace = state.config.retention.delete_grace.as_millis() as i64;
    match state.db.soft_delete(room, now, grace).await? {
        SoftDelete::Deleted { deleted_at, purge_at } => {
            state.hub.notify(room);
            Ok(Json(Deleted { deleted_at, purge_at }))
        }
        SoftDelete::NotFound => Err(ApiError::not_found("this room has no data on the server")),
    }
}

#[derive(Serialize)]
pub struct Empty {}

/// `POST /rooms/:room/restore` — undoes a soft delete before `purge_at`.
pub async fn restore_room(State(state): State<AppState>, req: Authed) -> ApiResult<Json<Empty>> {
    let room = req.room();
    let now = now_ms();
    state.check_room_write(room, now)?;
    if live_room(&state, room, now).await?.is_none() {
        return Err(ApiError::not_found("this room does not exist (or was already purged)"));
    }
    match state.db.restore(room, now).await? {
        Restore::Restored => {
            state.hub.notify(room);
            Ok(Json(Empty {}))
        }
        Restore::NotDeleted => Ok(Json(Empty {})),
        Restore::NotFound => Err(ApiError::not_found("this room does not exist (or was already purged)")),
    }
}

#[derive(Deserialize)]
struct TtlBody {
    msg_ttl_days: Option<i64>,
}

#[derive(Serialize)]
pub struct Ttl {
    msg_ttl_days: Option<i64>,
}

/// `PUT /rooms/:room/ttl` `{msg_ttl_days: n | null}`.
pub async fn set_ttl(State(state): State<AppState>, req: Authed) -> ApiResult<Json<Ttl>> {
    let body: TtlBody = req.json()?;
    if let Some(days) = body.msg_ttl_days
        && !(1..=MAX_TTL_DAYS).contains(&days)
    {
        return Err(ApiError::bad_request(format!("`msg_ttl_days` must be between 1 and {MAX_TTL_DAYS}, or null")));
    }
    let room = req.room();
    let now = now_ms();
    state.check_room_write(room, now)?;
    match live_room(&state, room, now).await? {
        None => return Err(ApiError::not_found("this room has no data on the server")),
        Some(r) if r.is_deleted() => return Err(ApiError::room_deleted(r.purge_at)),
        Some(_) => {}
    }
    if !state.db.set_ttl(room, body.msg_ttl_days).await? {
        return Err(ApiError::room_deleted(None));
    }
    if body.msg_ttl_days.is_some() {
        gc::apply_ttl(&state, room, now).await?;
    }
    Ok(Json(Ttl { msg_ttl_days: body.msg_ttl_days }))
}
