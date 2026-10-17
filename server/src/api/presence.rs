use axum::{Json, extract::State, http::StatusCode};
use serde::{Deserialize, Serialize};

use super::{check_sender, live_room};
use crate::{
    auth::Authed,
    error::{ApiError, ApiResult},
    presence::{self, Entry},
    state::AppState,
    util::now_ms,
};

#[derive(Deserialize)]
struct ReportBody {
    sender: String,
    state: String,
}

/// `POST /rooms/:room/presence` `{sender, state}` → 204.
pub async fn report(State(state): State<AppState>, req: Authed) -> ApiResult<StatusCode> {
    let body: ReportBody = req.json()?;
    check_sender(&body.sender)?;
    let reported = presence::State::parse(&body.state)
        .ok_or_else(|| ApiError::bad_request("`state` must be online, listening or offline"))?;
    let room = req.room();
    match live_room(&state, room, now_ms()).await? {
        // Presence alone never creates a room.
        None => {}
        Some(r) if r.is_deleted() => return Err(ApiError::room_deleted(r.purge_at)),
        Some(_) => presence::set(&state, room, &body.sender, reported).await?,
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct PresenceList {
    presence: Vec<Entry>,
}

/// `GET /rooms/:room/presence` → `{presence: [{sender, state, last_seen}]}`.
pub async fn list(State(state): State<AppState>, req: Authed) -> ApiResult<Json<PresenceList>> {
    let room = req.room();
    let presence = match live_room(&state, room, now_ms()).await? {
        Some(r) if !r.is_deleted() => presence::list(&state, room).await?,
        _ => Vec::new(),
    };
    Ok(Json(PresenceList { presence }))
}
