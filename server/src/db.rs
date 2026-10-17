//! Rooms, events, blob metadata and presence rows.
//!
//! One code path serves SQLite and Postgres through sqlx's `Any` driver. The SQL is kept portable:
//! only BIGINT and TEXT columns, `$n` placeholders, `ON CONFLICT` and `RETURNING`.
//!
//! Writes that touch a room start by updating its row (`UPDATE rooms … WHERE id = $1`), which takes
//! the row lock on Postgres; this serializes writers per room, so `seq` is assigned gap-free and in
//! commit order. SQLite allows one writer at a time anyway; an in-process mutex queues our writers
//! so they never hit `SQLITE_BUSY`.

use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{Context, bail};
use serde::Serialize;
use sqlx::{
    Any, AnyConnection, AnyPool, Transaction,
    any::{AnyArguments, AnyPoolOptions},
    query::Query,
};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    error::{ApiError, ApiResult},
    util::DAY_MS,
};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Sqlite,
    Postgres,
}

#[derive(Clone)]
pub struct Db {
    pool: AnyPool,
    backend: Backend,
    write_lock: Option<Arc<Mutex<()>>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Room {
    pub id: String,
    pub created_at: i64,
    pub last_seq: i64,
    pub last_event_at: i64,
    pub event_count: i64,
    pub usage_bytes: i64,
    pub msg_ttl_days: Option<i64>,
    pub deleted_at: Option<i64>,
    pub purge_at: Option<i64>,
}

impl Room {
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// Soft-deleted and past its grace period: logically gone, awaiting the purge.
    pub fn is_expired(&self, now: i64) -> bool {
        self.is_deleted() && self.purge_at.is_some_and(|at| at <= now)
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Event {
    pub seq: i64,
    pub cid: String,
    pub sender: String,
    pub ts: i64,
    pub data: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Member {
    pub sender: String,
    pub state: String,
    pub last_seen: i64,
    pub listen_until: Option<i64>,
}

pub struct NewEvent<'a> {
    pub room: &'a str,
    pub auth_pub: &'a str,
    pub cid: &'a str,
    pub sender: &'a str,
    pub data: &'a str,
}

#[derive(Debug)]
pub struct Appended {
    pub seq: i64,
    pub ts: i64,
    /// This write created the room.
    pub room_created: bool,
    /// The cid already existed; `seq`/`ts` are the original event's.
    pub duplicate: bool,
}

#[derive(Debug)]
pub enum SoftDelete {
    Deleted { deleted_at: i64, purge_at: i64 },
    NotFound,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Restore {
    Restored,
    NotDeleted,
    /// Unknown room, or its grace period is over.
    NotFound,
}

#[derive(Debug, Clone, Copy)]
pub enum PurgeReason {
    /// Soft-deleted and `purge_at` has passed.
    Expired,
    /// No events since `before`.
    Inactive { before: i64 },
    /// At most one event ever and created before `before`.
    NearEmpty { before: i64 },
}

enum TxEnd<T> {
    Commit(T),
    Rollback(T),
}

struct WriteTx {
    tx: Transaction<'static, Any>,
    _guard: Option<OwnedMutexGuard<()>>,
}

impl WriteTx {
    /// Commits or rolls back according to `result`; errors always roll back.
    async fn finish<T>(self, result: ApiResult<TxEnd<T>>) -> ApiResult<T> {
        match result {
            Ok(TxEnd::Commit(v)) => {
                self.tx.commit().await?;
                Ok(v)
            }
            Ok(TxEnd::Rollback(v)) => {
                self.tx.rollback().await?;
                Ok(v)
            }
            Err(e) => {
                if let Err(re) = self.tx.rollback().await {
                    tracing::warn!(error = %re, "rollback failed");
                }
                Err(e)
            }
        }
    }
}

type AnyQuery<'q> = Query<'q, Any, AnyArguments<'q>>;

const ROOM_COLUMNS: &str =
    "id, created_at, last_seq, last_event_at, event_count, usage_bytes, msg_ttl_days, deleted_at, purge_at";

impl Db {
    pub async fn connect(url: &str, max_connections: u32) -> anyhow::Result<Self> {
        sqlx::any::install_default_drivers();
        let backend = if url.starts_with("sqlite:") {
            Backend::Sqlite
        } else if url.starts_with("postgres:") || url.starts_with("postgresql:") {
            Backend::Postgres
        } else {
            bail!("LINCOR_DATABASE_URL must start with sqlite:// or postgres://");
        };
        let (url, max_connections) = match backend {
            Backend::Sqlite => prepare_sqlite_url(url, max_connections)?,
            Backend::Postgres => (url.to_owned(), max_connections),
        };
        let pool = AnyPoolOptions::new()
            .max_connections(max_connections.max(1))
            .acquire_timeout(Duration::from_secs(30))
            .after_connect(move |conn, _meta| {
                Box::pin(async move {
                    if backend == Backend::Sqlite {
                        for pragma in
                            ["PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL", "PRAGMA busy_timeout = 10000"]
                        {
                            sqlx::query(pragma).execute(&mut *conn).await?;
                        }
                    }
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .context("connecting to the database")?;
        MIGRATOR.run(&pool).await.context("running database migrations")?;
        let write_lock = (backend == Backend::Sqlite).then(|| Arc::new(Mutex::new(())));
        Ok(Self { pool, backend, write_lock })
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// The underlying pool (for maintenance tooling and tests).
    pub fn pool(&self) -> &AnyPool {
        &self.pool
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    async fn write_guard(&self) -> Option<OwnedMutexGuard<()>> {
        match &self.write_lock {
            Some(lock) => Some(lock.clone().lock_owned().await),
            None => None,
        }
    }

    async fn begin(&self) -> ApiResult<WriteTx> {
        let guard = self.write_guard().await;
        let tx = self.pool.begin().await?;
        Ok(WriteTx { tx, _guard: guard })
    }

    /// Runs a single write statement; returns the affected row count.
    async fn exec(&self, q: AnyQuery<'_>) -> ApiResult<u64> {
        let _guard = self.write_guard().await;
        Ok(q.execute(&self.pool).await?.rows_affected())
    }

    // ---- reads -------------------------------------------------------------------------------

    pub async fn room(&self, id: &str) -> ApiResult<Option<Room>> {
        let sql = format!("SELECT {ROOM_COLUMNS} FROM rooms WHERE id = $1");
        Ok(sqlx::query_as::<_, Room>(&sql).bind(id).fetch_optional(&self.pool).await?)
    }

    pub async fn events_after(&self, room: &str, after: i64, limit: i64) -> ApiResult<Vec<Event>> {
        Ok(sqlx::query_as::<_, Event>(
            "SELECT seq, cid, sender, ts, data FROM events WHERE room_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
        )
        .bind(room)
        .bind(after)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn members(&self, room: &str) -> ApiResult<Vec<Member>> {
        Ok(sqlx::query_as::<_, Member>(
            "SELECT sender, state, last_seen, listen_until FROM members WHERE room_id = $1 ORDER BY joined_at, sender",
        )
        .bind(room)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn blob_exists(&self, room: &str, id: &str) -> ApiResult<bool> {
        Ok(sqlx::query("SELECT size FROM blobs WHERE room_id = $1 AND id = $2")
            .bind(room)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .is_some())
    }

    // ---- events ------------------------------------------------------------------------------

    /// Appends an event, creating the room on first write. Idempotent per `(room, cid)`.
    pub async fn append_event(&self, ev: &NewEvent<'_>, now: i64, quota: i64, max_senders: i64) -> ApiResult<Appended> {
        let mut w = self.begin().await?;
        let result = append_tx(&mut w.tx, ev, now, quota, max_senders).await;
        w.finish(result).await
    }

    // ---- presence ----------------------------------------------------------------------------

    /// Explicit presence report. Returns false if the room does not exist (nothing is stored).
    pub async fn set_presence(
        &self,
        room: &str,
        sender: &str,
        state: &str,
        now: i64,
        max_senders: i64,
    ) -> ApiResult<bool> {
        let mut w = self.begin().await?;
        let result = presence_tx(&mut w.tx, room, sender, state, now, max_senders).await;
        w.finish(result).await
    }

    /// Implicit presence refresh: updates `last_seen` of an existing participant.
    pub async fn touch_member(&self, room: &str, sender: &str, now: i64) -> ApiResult<bool> {
        let q = sqlx::query(
            "UPDATE members SET last_seen = $3, state = CASE WHEN state = 'offline' THEN 'online' ELSE state END \
             WHERE room_id = $1 AND sender = $2",
        )
        .bind(room)
        .bind(sender)
        .bind(now);
        Ok(self.exec(q).await? > 0)
    }

    /// Marks a participant as listening (on some instance) until `until`.
    pub async fn listen_lease(&self, room: &str, sender: &str, until: Option<i64>, now: i64) -> ApiResult<()> {
        let q = sqlx::query(
            "UPDATE members SET listen_until = $3, last_seen = $4, \
             state = CASE WHEN state = 'offline' THEN 'online' ELSE state END \
             WHERE room_id = $1 AND sender = $2",
        )
        .bind(room)
        .bind(sender)
        .bind(until)
        .bind(now);
        self.exec(q).await?;
        Ok(())
    }

    // ---- blobs -------------------------------------------------------------------------------

    /// Accounts for a blob upload, creating the room on first write.
    pub async fn put_blob(
        &self,
        room: &str,
        auth_pub: &str,
        id: &str,
        size: i64,
        now: i64,
        quota: i64,
    ) -> ApiResult<()> {
        let mut w = self.begin().await?;
        let result = put_blob_tx(&mut w.tx, room, auth_pub, id, size, now, quota).await;
        w.finish(result).await
    }

    /// Removes a blob row and its usage (used when storing the bytes failed).
    pub async fn remove_blob(&self, room: &str, id: &str) -> ApiResult<()> {
        let mut w = self.begin().await?;
        let result = remove_blob_tx(&mut w.tx, room, id).await;
        w.finish(result).await
    }

    // ---- room management ---------------------------------------------------------------------

    pub async fn soft_delete(&self, room: &str, now: i64, grace_ms: i64) -> ApiResult<SoftDelete> {
        let q = sqlx::query("UPDATE rooms SET deleted_at = $2, purge_at = $3 WHERE id = $1 AND deleted_at IS NULL")
            .bind(room)
            .bind(now)
            .bind(now + grace_ms);
        if self.exec(q).await? > 0 {
            return Ok(SoftDelete::Deleted { deleted_at: now, purge_at: now + grace_ms });
        }
        Ok(match self.room(room).await? {
            Some(Room { deleted_at: Some(deleted_at), purge_at: Some(purge_at), .. }) if purge_at > now => {
                SoftDelete::Deleted { deleted_at, purge_at }
            }
            _ => SoftDelete::NotFound,
        })
    }

    pub async fn restore(&self, room: &str, now: i64) -> ApiResult<Restore> {
        let q = sqlx::query(
            "UPDATE rooms SET deleted_at = NULL, purge_at = NULL \
             WHERE id = $1 AND deleted_at IS NOT NULL AND purge_at > $2",
        )
        .bind(room)
        .bind(now);
        if self.exec(q).await? > 0 {
            return Ok(Restore::Restored);
        }
        Ok(match self.room(room).await? {
            Some(r) if !r.is_deleted() => Restore::NotDeleted,
            _ => Restore::NotFound,
        })
    }

    /// Sets the message TTL of a live room; false if no live room has this id.
    pub async fn set_ttl(&self, room: &str, days: Option<i64>) -> ApiResult<bool> {
        let q = sqlx::query("UPDATE rooms SET msg_ttl_days = $2 WHERE id = $1 AND deleted_at IS NULL")
            .bind(room)
            .bind(days);
        Ok(self.exec(q).await? > 0)
    }

    // ---- retention ---------------------------------------------------------------------------

    /// Hard-deletes a room and everything in it if `reason` still applies. Returns the ids of the
    /// blobs whose bytes must now be removed from blob storage.
    pub async fn purge_room(&self, room: &str, reason: PurgeReason, now: i64) -> ApiResult<Option<Vec<String>>> {
        let mut w = self.begin().await?;
        let result = purge_tx(&mut w.tx, room, reason, now).await;
        w.finish(result).await
    }

    /// Deletes events and blobs older than the room's message TTL. Returns the removed blob ids, or
    /// `None` if nothing had expired.
    pub async fn apply_ttl(&self, room: &str, now: i64) -> ApiResult<Option<Vec<String>>> {
        let mut w = self.begin().await?;
        let result = ttl_tx(&mut w.tx, room, now).await;
        w.finish(result).await
    }

    pub async fn rooms_to_purge(&self, now: i64, limit: i64) -> ApiResult<Vec<String>> {
        self.room_ids("SELECT id FROM rooms WHERE purge_at IS NOT NULL AND purge_at <= $1 LIMIT $2", now, limit).await
    }

    pub async fn inactive_rooms(&self, before: i64, limit: i64) -> ApiResult<Vec<String>> {
        self.room_ids("SELECT id FROM rooms WHERE deleted_at IS NULL AND last_event_at < $1 LIMIT $2", before, limit)
            .await
    }

    pub async fn near_empty_rooms(&self, before: i64, limit: i64) -> ApiResult<Vec<String>> {
        self.room_ids(
            "SELECT id FROM rooms WHERE deleted_at IS NULL AND last_seq <= 1 AND created_at < $1 LIMIT $2",
            before,
            limit,
        )
        .await
    }

    /// Live rooms with a TTL that hold events or blobs older than it.
    pub async fn rooms_with_expired_messages(&self, now: i64, limit: i64) -> ApiResult<Vec<String>> {
        self.room_ids(
            "SELECT r.id FROM rooms r WHERE r.deleted_at IS NULL AND r.msg_ttl_days IS NOT NULL AND (\
               EXISTS (SELECT 1 FROM events e WHERE e.room_id = r.id AND e.ts < $1 - r.msg_ttl_days * 86400000) \
               OR EXISTS (SELECT 1 FROM blobs b WHERE b.room_id = r.id AND b.created_at < $1 - r.msg_ttl_days * 86400000)\
             ) LIMIT $2",
            now,
            limit,
        )
        .await
    }

    async fn room_ids(&self, sql: &str, t: i64, limit: i64) -> ApiResult<Vec<String>> {
        Ok(sqlx::query_scalar::<_, String>(sql).bind(t).bind(limit).fetch_all(&self.pool).await?)
    }
}

/// Creates the room row if missing; returns whether it was created.
async fn create_room(c: &mut AnyConnection, room: &str, auth_pub: &str, now: i64) -> ApiResult<bool> {
    let n = sqlx::query(
        "INSERT INTO rooms (id, auth_pub, created_at, last_event_at) VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(room)
    .bind(auth_pub)
    .bind(now)
    .execute(&mut *c)
    .await?
    .rows_affected();
    Ok(n == 1)
}

async fn deleted_error(c: &mut AnyConnection, room: &str) -> ApiError {
    match sqlx::query_scalar::<_, Option<i64>>("SELECT purge_at FROM rooms WHERE id = $1")
        .bind(room)
        .fetch_optional(&mut *c)
        .await
    {
        Ok(purge_at) => ApiError::room_deleted(purge_at.flatten()),
        Err(e) => e.into(),
    }
}

/// Registers `sender` as a participant (or refreshes it). Fails with `room_full` for a new sender
/// once the room has `max` participants. Callers hold the room row lock.
async fn ensure_member(
    c: &mut AnyConnection,
    room: &str,
    sender: &str,
    state: Option<&str>,
    now: i64,
    max: i64,
) -> ApiResult<()> {
    let updated = match state {
        Some(state) => sqlx::query("UPDATE members SET state = $3, last_seen = $4 WHERE room_id = $1 AND sender = $2")
            .bind(room)
            .bind(sender)
            .bind(state)
            .bind(now),
        None => sqlx::query(
            "UPDATE members SET last_seen = $3, state = CASE WHEN state = 'offline' THEN 'online' ELSE state END \
             WHERE room_id = $1 AND sender = $2",
        )
        .bind(room)
        .bind(sender)
        .bind(now),
    }
    .execute(&mut *c)
    .await?
    .rows_affected();
    if updated > 0 {
        return Ok(());
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE room_id = $1").bind(room).fetch_one(&mut *c).await?;
    if count >= max {
        return Err(ApiError::room_full(max));
    }
    sqlx::query("INSERT INTO members (room_id, sender, joined_at, state, last_seen) VALUES ($1, $2, $3, $4, $3)")
        .bind(room)
        .bind(sender)
        .bind(now)
        .bind(state.unwrap_or("online"))
        .execute(&mut *c)
        .await?;
    Ok(())
}

async fn append_tx(
    c: &mut AnyConnection,
    ev: &NewEvent<'_>,
    now: i64,
    quota: i64,
    max_senders: i64,
) -> ApiResult<TxEnd<Appended>> {
    let room = ev.room;
    let room_created = create_room(c, room, ev.auth_pub, now).await?;
    let size = ev.data.len() as i64;
    let Some((seq, usage)) = sqlx::query_as::<_, (i64, i64)>(
        "UPDATE rooms SET last_seq = last_seq + 1, event_count = event_count + 1, \
           usage_bytes = usage_bytes + $2, last_event_at = $3 \
         WHERE id = $1 AND deleted_at IS NULL RETURNING last_seq, usage_bytes",
    )
    .bind(room)
    .bind(size)
    .bind(now)
    .fetch_optional(&mut *c)
    .await?
    else {
        return Err(deleted_error(c, room).await);
    };

    // The row lock is held, so a concurrent post of the same cid has either committed or not started.
    if let Some((seq, ts)) =
        sqlx::query_as::<_, (i64, i64)>("SELECT seq, ts FROM events WHERE room_id = $1 AND cid = $2")
            .bind(room)
            .bind(ev.cid)
            .fetch_optional(&mut *c)
            .await?
    {
        return Ok(TxEnd::Rollback(Appended { seq, ts, room_created: false, duplicate: true }));
    }
    if usage > quota {
        return Err(ApiError::quota_exceeded(quota));
    }
    ensure_member(c, room, ev.sender, None, now, max_senders).await?;
    sqlx::query("INSERT INTO events (room_id, seq, cid, sender, ts, data) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(room)
        .bind(seq)
        .bind(ev.cid)
        .bind(ev.sender)
        .bind(now)
        .bind(ev.data)
        .execute(&mut *c)
        .await?;
    Ok(TxEnd::Commit(Appended { seq, ts: now, room_created, duplicate: false }))
}

/// Takes the room row lock; false if there is no live room.
async fn lock_room(c: &mut AnyConnection, room: &str) -> ApiResult<bool> {
    Ok(sqlx::query("UPDATE rooms SET last_seq = last_seq WHERE id = $1 AND deleted_at IS NULL")
        .bind(room)
        .execute(&mut *c)
        .await?
        .rows_affected()
        > 0)
}

async fn presence_tx(
    c: &mut AnyConnection,
    room: &str,
    sender: &str,
    state: &str,
    now: i64,
    max_senders: i64,
) -> ApiResult<TxEnd<bool>> {
    if !lock_room(c, room).await? {
        let exists = sqlx::query("SELECT id FROM rooms WHERE id = $1").bind(room).fetch_optional(&mut *c).await?;
        return match exists {
            Some(_) => Err(deleted_error(c, room).await),
            None => Ok(TxEnd::Rollback(false)),
        };
    }
    ensure_member(c, room, sender, Some(state), now, max_senders).await?;
    Ok(TxEnd::Commit(true))
}

async fn put_blob_tx(
    c: &mut AnyConnection,
    room: &str,
    auth_pub: &str,
    id: &str,
    size: i64,
    now: i64,
    quota: i64,
) -> ApiResult<TxEnd<()>> {
    create_room(c, room, auth_pub, now).await?;
    let Some(mut usage) = sqlx::query_scalar::<_, i64>(
        "UPDATE rooms SET usage_bytes = usage_bytes + $2 WHERE id = $1 AND deleted_at IS NULL RETURNING usage_bytes",
    )
    .bind(room)
    .bind(size)
    .fetch_optional(&mut *c)
    .await?
    else {
        return Err(deleted_error(c, room).await);
    };
    let previous: Option<i64> = sqlx::query_scalar("SELECT size FROM blobs WHERE room_id = $1 AND id = $2")
        .bind(room)
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    if let Some(previous) = previous {
        sqlx::query("UPDATE rooms SET usage_bytes = usage_bytes - $2 WHERE id = $1")
            .bind(room)
            .bind(previous)
            .execute(&mut *c)
            .await?;
        usage -= previous;
    }
    if usage > quota {
        return Err(ApiError::quota_exceeded(quota));
    }
    sqlx::query(
        "INSERT INTO blobs (room_id, id, size, created_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (room_id, id) DO UPDATE SET size = excluded.size, created_at = excluded.created_at",
    )
    .bind(room)
    .bind(id)
    .bind(size)
    .bind(now)
    .execute(&mut *c)
    .await?;
    Ok(TxEnd::Commit(()))
}

async fn remove_blob_tx(c: &mut AnyConnection, room: &str, id: &str) -> ApiResult<TxEnd<()>> {
    let size: Option<i64> = sqlx::query_scalar("DELETE FROM blobs WHERE room_id = $1 AND id = $2 RETURNING size")
        .bind(room)
        .bind(id)
        .fetch_optional(&mut *c)
        .await?;
    if let Some(size) = size {
        sqlx::query("UPDATE rooms SET usage_bytes = usage_bytes - $2 WHERE id = $1")
            .bind(room)
            .bind(size)
            .execute(&mut *c)
            .await?;
    }
    Ok(TxEnd::Commit(()))
}

async fn purge_tx(
    c: &mut AnyConnection,
    room: &str,
    reason: PurgeReason,
    now: i64,
) -> ApiResult<TxEnd<Option<Vec<String>>>> {
    let q = match reason {
        PurgeReason::Expired => {
            sqlx::query("DELETE FROM rooms WHERE id = $1 AND purge_at IS NOT NULL AND purge_at <= $2")
                .bind(room)
                .bind(now)
        }
        PurgeReason::Inactive { before } => {
            sqlx::query("DELETE FROM rooms WHERE id = $1 AND deleted_at IS NULL AND last_event_at < $2")
                .bind(room)
                .bind(before)
        }
        PurgeReason::NearEmpty { before } => {
            sqlx::query("DELETE FROM rooms WHERE id = $1 AND deleted_at IS NULL AND last_seq <= 1 AND created_at < $2")
                .bind(room)
                .bind(before)
        }
    };
    if q.execute(&mut *c).await?.rows_affected() == 0 {
        return Ok(TxEnd::Rollback(None));
    }
    let blobs: Vec<String> =
        sqlx::query_scalar("SELECT id FROM blobs WHERE room_id = $1").bind(room).fetch_all(&mut *c).await?;
    for table in ["events", "blobs", "members"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE room_id = $1")).bind(room).execute(&mut *c).await?;
    }
    Ok(TxEnd::Commit(Some(blobs)))
}

async fn ttl_tx(c: &mut AnyConnection, room: &str, now: i64) -> ApiResult<TxEnd<Option<Vec<String>>>> {
    let Some(Some(days)) = sqlx::query_scalar::<_, Option<i64>>(
        "UPDATE rooms SET last_seq = last_seq WHERE id = $1 AND deleted_at IS NULL RETURNING msg_ttl_days",
    )
    .bind(room)
    .fetch_optional(&mut *c)
    .await?
    else {
        return Ok(TxEnd::Rollback(None));
    };
    let cutoff = now - days * DAY_MS;
    let events = sqlx::query("DELETE FROM events WHERE room_id = $1 AND ts < $2")
        .bind(room)
        .bind(cutoff)
        .execute(&mut *c)
        .await?
        .rows_affected();
    let blobs: Vec<String> =
        sqlx::query_scalar("DELETE FROM blobs WHERE room_id = $1 AND created_at < $2 RETURNING id")
            .bind(room)
            .bind(cutoff)
            .fetch_all(&mut *c)
            .await?;
    if events == 0 && blobs.is_empty() {
        return Ok(TxEnd::Rollback(None));
    }
    sqlx::query(
        "UPDATE rooms SET \
           event_count = (SELECT COUNT(*) FROM events WHERE room_id = $1), \
           usage_bytes = (SELECT CAST(COALESCE(SUM(LENGTH(data)), 0) AS BIGINT) FROM events WHERE room_id = $1) \
                       + (SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) FROM blobs WHERE room_id = $1) \
         WHERE id = $1",
    )
    .bind(room)
    .execute(&mut *c)
    .await?;
    Ok(TxEnd::Commit(Some(blobs)))
}

/// Ensures the database directory exists and the file is created on first start.
fn prepare_sqlite_url(url: &str, max_connections: u32) -> anyhow::Result<(String, u32)> {
    let rest = url.strip_prefix("sqlite://").or_else(|| url.strip_prefix("sqlite:")).unwrap_or(url);
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    if path.is_empty() || path == ":memory:" {
        // Every pooled connection would get its own private in-memory database.
        return Ok((url.to_owned(), 1));
    }
    if let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let url = if query.split('&').any(|kv| kv.starts_with("mode=")) {
        url.to_owned()
    } else if query.is_empty() {
        format!("{url}?mode=rwc")
    } else {
        format!("{url}&mode=rwc")
    };
    Ok((url, max_connections))
}
