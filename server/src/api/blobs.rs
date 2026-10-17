use axum::{
    Json,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;

use super::{admit_write, live_room};
use crate::{
    auth::Authed,
    crypto,
    error::{ApiError, ApiResult},
    state::AppState,
    util::now_ms,
};

fn check_blob_id(id: &str) -> ApiResult<()> {
    if crypto::is_id16(id) { Ok(()) } else { Err(ApiError::bad_request("blob id must be base64url of 16 bytes")) }
}

#[derive(Serialize)]
pub struct Uploaded {
    size: usize,
}

/// `PUT /rooms/:room/blobs/:blob` (raw bytes) → `201 {size}`. Creates the room on first write.
pub async fn upload(
    State(state): State<AppState>,
    Path((_, blob)): Path<(String, String)>,
    req: Authed,
) -> ApiResult<(StatusCode, Json<Uploaded>)> {
    check_blob_id(&blob)?;
    let room = req.room();
    let size = req.body.len();
    let now = now_ms();
    state.check_room_write(room, now)?;
    admit_write(&state, room, req.ip, now).await?;
    let quota = state.config.limits.room_quota_bytes;
    state.db.put_blob(room, &req.auth.auth_pub, &blob, size as i64, now, quota).await?;
    if let Err(e) = state.blobs.put(room, &blob, req.body.clone()).await {
        // Undo the accounting so the quota and listing stay truthful.
        let _ = state.db.remove_blob(room, &blob).await;
        return Err(ApiError::internal(format_args!("storing blob: {e:#}")));
    }
    Ok((StatusCode::CREATED, Json(Uploaded { size })))
}

/// `GET /rooms/:room/blobs/:blob` → raw bytes.
pub async fn download(
    State(state): State<AppState>,
    Path((_, blob)): Path<(String, String)>,
    req: Authed,
) -> ApiResult<Response> {
    check_blob_id(&blob)?;
    let room = req.room();
    let not_found = || ApiError::not_found("no such blob");
    match live_room(&state, room, now_ms()).await? {
        None => return Err(not_found()),
        Some(r) if r.is_deleted() => return Err(ApiError::room_deleted(r.purge_at)),
        Some(_) => {}
    }
    if !state.db.blob_exists(room, &blob).await? {
        return Err(not_found());
    }
    let bytes = state.blobs.get(room, &blob).await?.ok_or_else(not_found)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "private, no-store")], bytes)
        .into_response())
}
