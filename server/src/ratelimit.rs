//! In-memory rate limiting (GCRA) and client IP detection.

use std::{
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::Mutex,
    time::Duration,
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::HeaderMap,
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{error::ApiError, state::AppState, util::now_ms};

/// Generic cell rate algorithm: allows `limit` requests per `period`, with a burst of up to `limit`.
pub struct RateLimiter<K> {
    limit: u32,
    period_ms: i64,
    tat: Mutex<HashMap<K, i64>>,
}

impl<K: Hash + Eq> RateLimiter<K> {
    /// `limit == 0` disables the limiter.
    pub fn new(limit: u32, period: Duration) -> Self {
        Self { limit, period_ms: period.as_millis() as i64, tat: Mutex::new(HashMap::new()) }
    }

    /// Records one request for `key`. On rejection returns the number of seconds to wait.
    pub fn check(&self, key: K, now: i64) -> Result<(), u64> {
        if self.limit == 0 {
            return Ok(());
        }
        let interval = (self.period_ms / i64::from(self.limit)).max(1);
        let tolerance = self.period_ms - interval;
        let mut map = self.tat.lock().unwrap();
        let tat = map.get(&key).copied().unwrap_or(now).max(now);
        let excess = tat - now - tolerance;
        if excess > 0 {
            return Err((excess as u64).div_ceil(1000).max(1));
        }
        map.insert(key, tat + interval);
        Ok(())
    }

    /// Forgets keys whose budget is fully restored.
    pub fn sweep(&self, now: i64) {
        self.tat.lock().unwrap().retain(|_, tat| *tat > now);
    }
}

/// The client address used for rate limiting, stored in request extensions by [`limit_requests`].
#[derive(Clone, Copy, Debug)]
pub struct ClientIp(pub IpAddr);

/// Client IP: the socket peer, or the `trusted_hops`-th `X-Forwarded-For` entry from the right
/// when the server runs behind that many trusted proxies.
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>, trusted_hops: usize) -> IpAddr {
    let socket_ip = peer.map(|a| a.ip()).unwrap_or(IpAddr::from([0, 0, 0, 0]));
    if trusted_hops == 0 {
        return socket_ip;
    }
    let forwarded: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .collect();
    if forwarded.is_empty() {
        return socket_ip;
    }
    let idx = forwarded.len().saturating_sub(trusted_hops);
    forwarded[idx].parse::<IpAddr>().unwrap_or(socket_ip)
}

/// Rate-limit key for an address: IPv4 as is, IPv6 by its /64 network.
pub fn limiter_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// Middleware for `/api/v1`: resolves the client IP and enforces the per-IP request limit.
pub async fn limit_requests(State(state): State<AppState>, mut req: Request, next: Next) -> Response {
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    let ip = limiter_key(client_ip(req.headers(), peer, state.config.trust_proxy_hops));
    req.extensions_mut().insert(ClientIp(ip));
    if let Err(retry) = state.ip_requests.check(ip, now_ms()) {
        return ApiError::rate_limited(retry).into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcra_allows_burst_then_throttles() {
        let rl = RateLimiter::new(3, Duration::from_secs(60));
        let t = 1_000_000;
        assert!(rl.check("a", t).is_ok());
        assert!(rl.check("a", t).is_ok());
        assert!(rl.check("a", t).is_ok());
        let wait = rl.check("a", t).unwrap_err();
        assert_eq!(wait, 20);
        assert!(rl.check("b", t).is_ok());
        assert!(rl.check("a", t + 20_000).is_ok());
        assert!(rl.check("a", t + 20_000).is_err());
        rl.sweep(t + 120_000);
        assert!(rl.tat.lock().unwrap().is_empty());
    }

    #[test]
    fn zero_disables() {
        let rl = RateLimiter::new(0, Duration::from_secs(60));
        for _ in 0..1000 {
            assert!(rl.check(1, 0).is_ok());
        }
    }

    #[test]
    fn forwarded_for() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2, 3.3.3.3".parse().unwrap());
        let peer = Some(SocketAddr::from(([10, 0, 0, 1], 5000)));
        assert_eq!(client_ip(&h, peer, 0).to_string(), "10.0.0.1");
        assert_eq!(client_ip(&h, peer, 1).to_string(), "3.3.3.3");
        assert_eq!(client_ip(&h, peer, 2).to_string(), "2.2.2.2");
        assert_eq!(client_ip(&h, peer, 9).to_string(), "1.1.1.1");
        assert_eq!(client_ip(&HeaderMap::new(), peer, 1).to_string(), "10.0.0.1");
    }

    #[test]
    fn ipv6_prefix() {
        let ip: IpAddr = "2001:db8:1:2:3:4:5:6".parse().unwrap();
        assert_eq!(limiter_key(ip).to_string(), "2001:db8:1:2::");
        let mapped: IpAddr = "::ffff:1.2.3.4".parse().unwrap();
        assert_eq!(limiter_key(mapped).to_string(), "1.2.3.4");
    }
}
