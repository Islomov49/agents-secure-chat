//! Retention (PROTOCOL §6.3): purge soft-deleted rooms after their grace period, apply message TTLs,
//! delete inactive and near-empty rooms, and trim in-memory caches.

use tokio::{
    task::JoinHandle,
    time::{Instant, MissedTickBehavior, interval_at},
};

use crate::{db::PurgeReason, error::ApiResult, presence, state::AppState, util::now_ms};

const BATCH: i64 = 500;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub deleted_purged: usize,
    pub inactive_purged: usize,
    pub near_empty_purged: usize,
    pub ttl_rooms_trimmed: usize,
}

impl Report {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Hard-deletes `room` if `reason` still holds, including its blob bytes. Returns whether it did.
pub async fn purge(state: &AppState, room: &str, reason: PurgeReason, now: i64) -> ApiResult<bool> {
    let Some(blobs) = state.db.purge_room(room, reason, now).await? else {
        return Ok(false);
    };
    if let Err(e) = state.blobs.delete(room, &blobs).await {
        tracing::warn!(error = %format_args!("{e:#}"), "could not delete blob bytes of a purged room");
    }
    state.hub.notify(room);
    Ok(true)
}

/// Removes events and blobs older than the room's TTL. Returns whether anything was removed.
pub async fn apply_ttl(state: &AppState, room: &str, now: i64) -> ApiResult<bool> {
    let Some(blobs) = state.db.apply_ttl(room, now).await? else {
        return Ok(false);
    };
    if let Err(e) = state.blobs.delete(room, &blobs).await {
        tracing::warn!(error = %format_args!("{e:#}"), "could not delete expired blob bytes");
    }
    Ok(true)
}

async fn purge_all(state: &AppState, reason: PurgeReason, now: i64) -> ApiResult<usize> {
    let mut total = 0;
    loop {
        let ids = match reason {
            PurgeReason::Expired => state.db.rooms_to_purge(now, BATCH).await?,
            PurgeReason::Inactive { before } => state.db.inactive_rooms(before, BATCH).await?,
            PurgeReason::NearEmpty { before } => state.db.near_empty_rooms(before, BATCH).await?,
        };
        let mut purged = 0;
        for id in &ids {
            if purge(state, id, reason, now).await? {
                purged += 1;
            }
        }
        total += purged;
        if (ids.len() as i64) < BATCH || purged == 0 {
            return Ok(total);
        }
    }
}

async fn trim_all(state: &AppState, now: i64) -> ApiResult<usize> {
    let mut total = 0;
    loop {
        let ids = state.db.rooms_with_expired_messages(now, BATCH).await?;
        let mut trimmed = 0;
        for id in &ids {
            if apply_ttl(state, id, now).await? {
                trimmed += 1;
            }
        }
        total += trimmed;
        if (ids.len() as i64) < BATCH || trimmed == 0 {
            return Ok(total);
        }
    }
}

/// One retention sweep.
pub async fn run_once(state: &AppState) -> ApiResult<Report> {
    let now = now_ms();
    let r = &state.config.retention;
    let ago = |d: std::time::Duration| now - d.as_millis() as i64;
    let report = Report {
        deleted_purged: purge_all(state, PurgeReason::Expired, now).await?,
        inactive_purged: purge_all(state, PurgeReason::Inactive { before: ago(r.inactive_after) }, now).await?,
        near_empty_purged: purge_all(state, PurgeReason::NearEmpty { before: ago(r.empty_room_after) }, now).await?,
        ttl_rooms_trimmed: trim_all(state, now).await?,
    };

    state.nonces.sweep(now);
    state.sessions.sweep(now);
    state.ip_requests.sweep(now);
    state.ip_new_rooms.sweep(now);
    state.room_writes.sweep(now);
    state.hub.sweep();
    presence::forget_touches(state, now);
    Ok(report)
}

/// Runs [`run_once`] every `gc_interval` until shutdown.
pub fn spawn(state: AppState) -> JoinHandle<()> {
    tokio::spawn(async move {
        let period = state.config.retention.gc_interval;
        let mut tick = interval_at(Instant::now() + period, period);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                () = state.shutdown.cancelled() => return,
            }
            match run_once(&state).await {
                Ok(report) if !report.is_empty() => tracing::info!(?report, "retention sweep"),
                Ok(_) => {}
                // Already logged by the error conversion; try again next tick.
                Err(_) => {}
            }
        }
    })
}
