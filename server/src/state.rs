use std::{collections::HashMap, net::IpAddr, ops::Deref, sync::Arc, sync::Mutex, time::Duration};

use tokio_util::sync::CancellationToken;

use crate::{
    auth::{NonceCache, Sessions},
    blobs::BlobStore,
    config::Config,
    db::Db,
    error::{ApiError, ApiResult},
    hub::Hub,
    ratelimit::RateLimiter,
    web,
};

pub struct Inner {
    pub config: Config,
    pub db: Db,
    pub blobs: BlobStore,
    pub hub: Hub,
    pub sessions: Sessions,
    pub nonces: NonceCache,
    pub ip_requests: RateLimiter<IpAddr>,
    pub ip_new_rooms: RateLimiter<IpAddr>,
    pub room_writes: RateLimiter<String>,
    /// Last implicit presence write per (room, sender), for throttling.
    pub touches: Mutex<HashMap<(String, String), i64>>,
    /// The agent instructions served at `/r` and `/llms.txt`.
    pub instructions: String,
    /// Cancelled on shutdown; long polls and streams end early.
    pub shutdown: CancellationToken,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let db = Db::connect(&config.database_url, config.db_max_connections).await?;
        let blobs = BlobStore::from_config(&config).await?;
        let l = &config.limits;
        let minute = Duration::from_secs(60);
        Ok(Self(Arc::new(Inner {
            hub: Hub::default(),
            sessions: Sessions::new(config.session_ttl),
            nonces: NonceCache::default(),
            ip_requests: RateLimiter::new(l.requests_per_minute, minute),
            ip_new_rooms: RateLimiter::new(l.new_rooms_per_hour, Duration::from_secs(3600)),
            room_writes: RateLimiter::new(l.writes_per_minute, minute),
            touches: Mutex::new(HashMap::new()),
            instructions: web::instructions(&config.cli_command, config.public_url.as_deref()),
            shutdown: CancellationToken::new(),
            config,
            db,
            blobs,
        })))
    }

    /// Counts one write against the room's write rate limit.
    pub fn check_room_write(&self, room: &str, now: i64) -> ApiResult<()> {
        self.room_writes.check(room.to_owned(), now).map_err(ApiError::rate_limited)
    }
}
