//! Server configuration, read from `LINCOR_*` environment variables.

use std::{net::SocketAddr, path::PathBuf, str::FromStr, time::Duration};

use anyhow::{Context, bail};
use serde::Serialize;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The project's source repository, linked from the web app unless `LINCOR_SOURCE_URL` says otherwise.
pub const DEFAULT_SOURCE_URL: &str = "https://github.com/Islomov49/agents-secure-chat";

const DAY_SECS: f64 = 86_400.0;

/// Abuse limits from PROTOCOL §6.3. A rate limit of `0` disables that limiter.
#[derive(Clone, Debug, Serialize)]
pub struct Limits {
    /// Maximum length of an event's `data` field, in base64url characters.
    pub max_event_bytes: usize,
    /// Maximum size of one blob, in bytes.
    pub max_blob_bytes: usize,
    /// Maximum storage per room (event data + blobs), in bytes.
    pub room_quota_bytes: i64,
    /// Maximum number of distinct senders (participants) per room.
    pub max_senders: i64,
    /// New rooms a single client IP may create per hour.
    pub new_rooms_per_hour: u32,
    /// Writes (events, blobs, room management) per room per minute.
    pub writes_per_minute: u32,
    /// API requests per client IP per minute.
    pub requests_per_minute: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_event_bytes: 128 * 1024,
            max_blob_bytes: 12 * 1024 * 1024,
            room_quota_bytes: 200 * 1024 * 1024,
            max_senders: 20,
            new_rooms_per_hour: 20,
            writes_per_minute: 120,
            requests_per_minute: 600,
        }
    }
}

/// Retention rules from PROTOCOL §6.3.
#[derive(Clone, Debug)]
pub struct Retention {
    /// Rooms without new events for this long are deleted.
    pub inactive_after: Duration,
    /// Rooms with at most one event that are older than this are deleted.
    pub empty_room_after: Duration,
    /// Time between a soft delete and the purge.
    pub delete_grace: Duration,
    /// How often the retention sweep runs.
    pub gc_interval: Duration,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            inactive_after: Duration::from_secs(90 * 86_400),
            empty_room_after: Duration::from_secs(7 * 86_400),
            delete_grace: Duration::from_secs(86_400),
            gc_interval: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub db_max_connections: u32,
    /// Local blob directory, used unless `blob_url` points elsewhere.
    pub blob_dir: PathBuf,
    /// `s3://bucket/prefix` (or `file:///path`) blob storage location.
    pub blob_url: Option<String>,
    pub public_url: Option<String>,
    /// Where the source code lives (shown on the web app), e.g. a GitHub repository URL.
    pub source_url: Option<String>,
    pub cli_command: String,
    /// Serve web assets from this directory instead of the embedded build.
    pub web_dir: Option<PathBuf>,
    /// Number of trusted reverse proxies in front of the server (`X-Forwarded-For` hops); 0 = use the socket.
    pub trust_proxy_hops: usize,
    pub limits: Limits,
    pub retention: Retention,
    /// How often `wait` and streams re-check the database (for multi-instance deployments).
    pub poll_interval: Duration,
    /// A participant whose `last_seen` is older than this is shown offline.
    pub presence_timeout: Duration,
    /// Lifetime of bearer tokens issued by `POST /session`.
    pub session_ttl: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([0, 0, 0, 0], 8080)),
            database_url: "sqlite://./data/lincor.db?mode=rwc".into(),
            db_max_connections: 10,
            blob_dir: PathBuf::from("./data/blobs"),
            blob_url: None,
            public_url: None,
            source_url: Some(DEFAULT_SOURCE_URL.into()),
            cli_command: default_cli_command(),
            web_dir: None,
            trust_proxy_hops: 0,
            limits: Limits::default(),
            retention: Retention::default(),
            poll_interval: Duration::from_secs(2),
            presence_timeout: Duration::from_secs(90),
            session_ttl: Duration::from_secs(3600),
        }
    }
}

pub fn default_cli_command() -> String {
    format!("npx -y agents-room@{VERSION}")
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Builds a configuration from an arbitrary variable source (used by `from_env` and tests).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Self> {
        let get = |name: &str| get(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let num = |name: &str| -> anyhow::Result<Option<f64>> {
            get(name)
                .map(|v| parse::<f64>(name, &v))
                .transpose()?
                .map(|v| if v.is_finite() && v >= 0.0 { Ok(v) } else { bail!("{name} must be a non-negative number") })
                .transpose()
        };
        let int = |name: &str| -> anyhow::Result<Option<u64>> { get(name).map(|v| parse::<u64>(name, &v)).transpose() };
        let secs = |name: &str, scale: f64| -> anyhow::Result<Option<Duration>> {
            Ok(num(name)?.map(|v| Duration::from_secs_f64(v * scale)))
        };

        let mut c = Config::default();
        if let Some(v) = get("LINCOR_BIND") {
            c.bind = parse("LINCOR_BIND", &v)?;
        }
        if let Some(v) = get("LINCOR_DATABASE_URL") {
            c.database_url = v;
        }
        if let Some(v) = int("LINCOR_DB_MAX_CONNECTIONS")? {
            c.db_max_connections = u32::try_from(v.max(1)).context("LINCOR_DB_MAX_CONNECTIONS")?;
        }
        if let Some(v) = get("LINCOR_BLOB_DIR") {
            c.blob_dir = PathBuf::from(v);
        }
        c.blob_url = get("LINCOR_BLOB_URL");
        c.public_url = get("LINCOR_PUBLIC_URL").map(|v| v.trim_end_matches('/').to_owned());
        // Set to a URL to link elsewhere, or to "off" to hide the link.
        if let Some(v) = get("LINCOR_SOURCE_URL") {
            c.source_url = (v.starts_with("https://") || v.starts_with("http://")).then_some(v);
        }
        if let Some(v) = get("LINCOR_CLI_COMMAND") {
            c.cli_command = v;
        }
        c.web_dir = get("LINCOR_WEB_DIR").map(PathBuf::from);
        if let Some(v) = get("LINCOR_TRUST_PROXY") {
            c.trust_proxy_hops = match v.to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" => 1,
                "false" | "no" | "off" => 0,
                n => parse("LINCOR_TRUST_PROXY", n)?,
            };
        }

        let l = &mut c.limits;
        if let Some(v) = int("LINCOR_MAX_EVENT_BYTES")? {
            l.max_event_bytes = usize::try_from(v)?;
        }
        if let Some(v) = int("LINCOR_MAX_BLOB_BYTES")? {
            l.max_blob_bytes = usize::try_from(v)?;
        }
        if let Some(v) = int("LINCOR_ROOM_QUOTA_BYTES")? {
            l.room_quota_bytes = i64::try_from(v)?;
        }
        if let Some(v) = int("LINCOR_MAX_SENDERS")? {
            l.max_senders = i64::try_from(v)?;
        }
        if let Some(v) = int("LINCOR_NEW_ROOMS_PER_HOUR")? {
            l.new_rooms_per_hour = u32::try_from(v)?;
        }
        if let Some(v) = int("LINCOR_WRITES_PER_MINUTE")? {
            l.writes_per_minute = u32::try_from(v)?;
        }
        if let Some(v) = int("LINCOR_REQUESTS_PER_MINUTE")? {
            l.requests_per_minute = u32::try_from(v)?;
        }

        let r = &mut c.retention;
        if let Some(v) = secs("LINCOR_INACTIVE_DAYS", DAY_SECS)? {
            r.inactive_after = v;
        }
        if let Some(v) = secs("LINCOR_EMPTY_ROOM_DAYS", DAY_SECS)? {
            r.empty_room_after = v;
        }
        if let Some(v) = secs("LINCOR_DELETE_GRACE_SECS", 1.0)? {
            r.delete_grace = v;
        }
        if let Some(v) = secs("LINCOR_GC_INTERVAL_SECS", 1.0)? {
            r.gc_interval = v.max(Duration::from_millis(10));
        }
        if let Some(v) = int("LINCOR_POLL_INTERVAL_MS")? {
            c.poll_interval = Duration::from_millis(v.max(10));
        }
        Ok(c)
    }
}

fn parse<T: FromStr>(name: &str, value: &str) -> anyhow::Result<T>
where
    T::Err: std::fmt::Display,
{
    value.parse::<T>().map_err(|e| anyhow::anyhow!("invalid {name}={value:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn from(vars: &[(&str, &str)]) -> anyhow::Result<Config> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults() {
        let c = from(&[]).unwrap();
        assert_eq!(c.bind.to_string(), "0.0.0.0:8080");
        assert_eq!(c.cli_command, format!("npx -y agents-room@{VERSION}"));
        assert_eq!(c.limits.max_event_bytes, 131_072);
        assert_eq!(c.retention.delete_grace, Duration::from_secs(86_400));
        assert_eq!(c.trust_proxy_hops, 0);
    }

    #[test]
    fn overrides() {
        let c = from(&[
            ("LINCOR_BIND", "127.0.0.1:9000"),
            ("LINCOR_MAX_SENDERS", "3"),
            ("LINCOR_EMPTY_ROOM_DAYS", "0.5"),
            ("LINCOR_DELETE_GRACE_SECS", "2"),
            ("LINCOR_TRUST_PROXY", "1"),
            ("LINCOR_PUBLIC_URL", "https://agents-room.cc/"),
            ("LINCOR_SOURCE_URL", "https://github.com/example/agents-room"),
        ])
        .unwrap();
        assert_eq!(c.source_url.as_deref(), Some("https://github.com/example/agents-room"));
        assert_eq!(from(&[("LINCOR_SOURCE_URL", "javascript:alert(1)")]).unwrap().source_url, None);
        assert_eq!(from(&[("LINCOR_SOURCE_URL", "off")]).unwrap().source_url, None);
        assert_eq!(from(&[]).unwrap().source_url.as_deref(), Some(DEFAULT_SOURCE_URL));
        assert_eq!(c.bind.port(), 9000);
        assert_eq!(c.limits.max_senders, 3);
        assert_eq!(c.retention.empty_room_after, Duration::from_secs(43_200));
        assert_eq!(c.retention.delete_grace, Duration::from_secs(2));
        assert_eq!(c.trust_proxy_hops, 1);
        assert_eq!(c.public_url.as_deref(), Some("https://agents-room.cc"));
        assert!(from(&[("LINCOR_MAX_SENDERS", "many")]).is_err());
        assert!(from(&[("LINCOR_INACTIVE_DAYS", "-1")]).is_err());
    }
}
