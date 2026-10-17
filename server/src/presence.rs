//! Presence (PROTOCOL §6.2): `online`, `listening` or `offline` per participant.
//!
//! The reported state and `last_seen` live in the `members` table. A participant is `listening`
//! while a `wait` or stream is open for it: locally that is tracked by the hub, across instances by a
//! short lease (`listen_until`) that open listeners keep renewing.

use serde::Serialize;

use crate::{db::Member, error::ApiResult, state::AppState, util::now_ms};

/// Implicit presence refreshes are written at most this often per participant and instance.
const TOUCH_INTERVAL_MS: i64 = 10_000;
/// Lifetime of the cross-instance listening lease; renewed every third of it.
const LISTEN_LEASE_MS: i64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Online,
    Listening,
    Offline,
}

impl State {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "online" => Some(Self::Online),
            "listening" => Some(Self::Listening),
            "offline" => Some(Self::Offline),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Listening => "listening",
            Self::Offline => "offline",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub sender: String,
    pub state: State,
    pub last_seen: i64,
}

/// The state shown to others.
pub fn effective(m: &Member, listening_here: bool, now: i64, timeout_ms: i64) -> State {
    if listening_here || m.listen_until.is_some_and(|until| until > now) {
        return State::Listening;
    }
    match State::parse(&m.state).unwrap_or(State::Online) {
        State::Offline => State::Offline,
        _ if now - m.last_seen > timeout_ms => State::Offline,
        reported => reported,
    }
}

pub async fn list(state: &AppState, room: &str) -> ApiResult<Vec<Entry>> {
    let now = now_ms();
    let timeout = state.config.presence_timeout.as_millis() as i64;
    Ok(state
        .db
        .members(room)
        .await?
        .into_iter()
        .map(|m| {
            let s = effective(&m, state.hub.is_listening(room, &m.sender), now, timeout);
            Entry { sender: m.sender, state: s, last_seen: m.last_seen }
        })
        .collect())
}

/// Implicit refresh for a request that names `sender` (best effort, throttled).
pub async fn touch(state: &AppState, room: &str, sender: &str) {
    let now = now_ms();
    {
        let mut touches = state.touches.lock().unwrap();
        let key = (room.to_owned(), sender.to_owned());
        if touches.get(&key).is_some_and(|at| now - at < TOUCH_INTERVAL_MS) {
            return;
        }
        touches.insert(key, now);
    }
    // A failure is logged by the error conversion; presence is not worth failing the request for.
    if let Ok(true) = state.db.touch_member(room, sender, now).await {
        state.hub.notify(room);
    }
}

/// Explicit presence report (`POST presence` or a stream frame).
pub async fn set(state: &AppState, room: &str, sender: &str, reported: State) -> ApiResult<()> {
    let stored =
        state.db.set_presence(room, sender, reported.as_str(), now_ms(), state.config.limits.max_senders).await?;
    if stored {
        state.hub.notify(room);
    }
    Ok(())
}

pub fn forget_touches(state: &AppState, now: i64) {
    state.touches.lock().unwrap().retain(|_, at| now - *at < TOUCH_INTERVAL_MS);
}

/// Shows `sender` as listening while held. Call [`ListenGuard::refresh`] periodically.
pub struct ListenGuard {
    state: AppState,
    room: String,
    sender: String,
    renewed_at: i64,
}

pub async fn listen(state: &AppState, room: &str, sender: &str) -> ListenGuard {
    state.hub.listen_start(room, sender);
    let mut guard =
        ListenGuard { state: state.clone(), room: room.to_owned(), sender: sender.to_owned(), renewed_at: 0 };
    guard.renew(now_ms()).await;
    state.hub.notify(room);
    guard
}

impl ListenGuard {
    pub async fn refresh(&mut self) {
        let now = now_ms();
        if now - self.renewed_at >= LISTEN_LEASE_MS / 3 {
            self.renew(now).await;
        }
    }

    async fn renew(&mut self, now: i64) {
        self.renewed_at = now;
        // Errors are logged by the conversion; the local listener registry still applies.
        let _ = self.state.db.listen_lease(&self.room, &self.sender, Some(now + LISTEN_LEASE_MS), now).await;
    }
}

impl Drop for ListenGuard {
    fn drop(&mut self) {
        if !self.state.hub.listen_end(&self.room, &self.sender) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let state = self.state.clone();
        let room = std::mem::take(&mut self.room);
        let sender = std::mem::take(&mut self.sender);
        runtime.spawn(async move {
            if !state.hub.is_listening(&room, &sender) {
                let _ = state.db.listen_lease(&room, &sender, None, now_ms()).await;
            }
            state.hub.notify(&room);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(state: &str, last_seen: i64, listen_until: Option<i64>) -> Member {
        Member { sender: "s".into(), state: state.into(), last_seen, listen_until }
    }

    #[test]
    fn effective_state() {
        let now = 1_000_000;
        let t = 90_000;
        assert_eq!(effective(&member("online", now - 1000, None), false, now, t), State::Online);
        assert_eq!(effective(&member("online", now - 91_000, None), false, now, t), State::Offline);
        assert_eq!(effective(&member("offline", now, None), false, now, t), State::Offline);
        assert_eq!(effective(&member("listening", now, None), false, now, t), State::Listening);
        assert_eq!(effective(&member("offline", now - 500_000, None), true, now, t), State::Listening);
        assert_eq!(effective(&member("online", now, Some(now + 1)), false, now, t), State::Listening);
        assert_eq!(effective(&member("online", now, Some(now)), false, now, t), State::Online);
    }
}
