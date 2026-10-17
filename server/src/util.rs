use std::time::{SystemTime, UNIX_EPOCH};

/// Current Unix time in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub const DAY_MS: i64 = 86_400_000;
