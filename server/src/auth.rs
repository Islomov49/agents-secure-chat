//! Request authentication (PROTOCOL §6.1): Ed25519-signed requests bound to the roomId, and bearer
//! session tokens issued by `POST /rooms/:room/session`.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::IpAddr,
    sync::Mutex,
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{FromRequest, FromRequestParts, OriginalUri, Path, Query, Request},
    http::{HeaderMap, Method, Uri, header, request::Parts},
};
use ed25519_dalek::VerifyingKey;
use http_body_util::LengthLimitError;
use serde::{Deserialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::{
    crypto,
    error::{ApiError, ApiResult},
    presence,
    ratelimit::ClientIp,
    state::AppState,
    util::now_ms,
};

pub const HEADER_PUB: &str = "x-lincor-pub";
pub const HEADER_TS: &str = "x-lincor-ts";
pub const HEADER_NONCE: &str = "x-lincor-nonce";
pub const HEADER_SIG: &str = "x-lincor-sig";

const TS_WINDOW_MS: i64 = 5 * 60 * 1000;
const NONCE_TTL_MS: i64 = 10 * 60 * 1000;
/// Room endpoints other than blob uploads carry small JSON bodies: an event plus envelope overhead.
const JSON_OVERHEAD_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Credential {
    Signed,
    Bearer,
}

/// A request proven to come from a holder of the room key.
#[derive(Clone, Debug)]
pub struct RoomAuth {
    pub room: String,
    /// The room's `auth_pub` (b64u), cached on the room row when the room is created.
    pub auth_pub: String,
    pub credential: Credential,
}

/// Credentials parsed from the headers; everything except the body-dependent signature is checked.
enum Pending {
    Signed(Box<SignedHeaders>),
    Bearer { auth_pub: String },
}

struct SignedHeaders {
    auth_pub: String,
    key: VerifyingKey,
    ts: String,
    nonce: String,
    sig: [u8; 64],
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn precheck(
    state: &AppState,
    room: &str,
    headers: &HeaderMap,
    query_token: Option<&str>,
    now: i64,
) -> ApiResult<Pending> {
    let bearer = match header(headers, header::AUTHORIZATION.as_str()) {
        Some(value) => Some(
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .ok_or_else(|| ApiError::auth("unsupported Authorization scheme; use Bearer"))?
                .trim(),
        ),
        None => query_token,
    };
    if let Some(token) = bearer {
        return state
            .sessions
            .validate(token, room, now)
            .map(|auth_pub| Pending::Bearer { auth_pub })
            .ok_or_else(|| ApiError::auth("session token is invalid, expired or for another room"));
    }

    let (Some(pub_b64), Some(ts), Some(nonce), Some(sig)) = (
        header(headers, HEADER_PUB),
        header(headers, HEADER_TS),
        header(headers, HEADER_NONCE),
        header(headers, HEADER_SIG),
    ) else {
        return Err(ApiError::auth(
            "missing credentials: sign the request (X-Lincor-Pub/Ts/Nonce/Sig) or send a bearer token",
        ));
    };
    let pub_bytes = crypto::b64u_decode_array::<32>(pub_b64).ok_or_else(|| ApiError::auth("malformed X-Lincor-Pub"))?;
    if crypto::room_id_for(&pub_bytes) != room {
        return Err(ApiError::auth("X-Lincor-Pub does not belong to this room"));
    }
    let ts_ms = Some(ts)
        .filter(|t| !t.is_empty() && t.len() <= 16 && t.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|t| t.parse::<i64>().ok())
        .ok_or_else(|| ApiError::auth("malformed X-Lincor-Ts"))?;
    if (now - ts_ms).abs() > TS_WINDOW_MS {
        return Err(ApiError::auth("X-Lincor-Ts is more than 5 minutes off the server clock"));
    }
    if !crypto::is_id16(nonce) {
        return Err(ApiError::auth("malformed X-Lincor-Nonce"));
    }
    let sig = crypto::b64u_decode_array::<64>(sig).ok_or_else(|| ApiError::auth("malformed X-Lincor-Sig"))?;
    let key = VerifyingKey::from_bytes(&pub_bytes).map_err(|_| ApiError::auth("invalid X-Lincor-Pub"))?;
    Ok(Pending::Signed(Box::new(SignedHeaders {
        auth_pub: pub_b64.to_owned(),
        key,
        ts: ts.to_owned(),
        nonce: nonce.to_owned(),
        sig,
    })))
}

fn complete(
    state: &AppState,
    room: &str,
    pending: Pending,
    method: &str,
    target: &str,
    body: &[u8],
    now: i64,
) -> ApiResult<RoomAuth> {
    match pending {
        Pending::Bearer { auth_pub } => {
            Ok(RoomAuth { room: room.to_owned(), auth_pub, credential: Credential::Bearer })
        }
        Pending::Signed(signed) => {
            let SignedHeaders { auth_pub, key, ts, nonce, sig } = *signed;
            let message = crypto::request_message(method, target, body, &ts, &nonce);
            if !crypto::verify(&key, &message, &sig) {
                return Err(ApiError::auth("signature does not verify"));
            }
            if !state.nonces.insert(room, &nonce, now) {
                return Err(ApiError::auth("nonce was already used (replayed request)"));
            }
            Ok(RoomAuth { room: room.to_owned(), auth_pub, credential: Credential::Signed })
        }
    }
}

/// The exact path and query the client sent (and signed).
fn signed_target(uri: &Uri) -> String {
    uri.path_and_query().map(|pq| pq.as_str().to_owned()).unwrap_or_else(|| uri.path().to_owned())
}

fn original_uri(parts: &Parts) -> &Uri {
    parts.extensions.get::<OriginalUri>().map(|u| &u.0).unwrap_or(&parts.uri)
}

/// Validated `:room` path segment.
pub fn parse_room(room: &str) -> ApiResult<()> {
    if crypto::is_room_id(room) { Ok(()) } else { Err(ApiError::bad_request("malformed room id")) }
}

/// Authenticates a bodiless request (the WebSocket upgrade), which may carry `?token=`.
pub fn authenticate_bodiless(
    state: &AppState,
    room: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> ApiResult<RoomAuth> {
    parse_room(room)?;
    let now = now_ms();
    let pending = precheck(state, room, headers, query_token, now)?;
    complete(state, room, pending, method.as_str(), &signed_target(uri), &[], now)
}

/// Extractor for authenticated room requests. Buffers the body (it is part of the signature), so it
/// must be the last handler argument.
pub struct Authed {
    pub auth: RoomAuth,
    pub ip: IpAddr,
    pub body: Bytes,
    uri: Uri,
}

#[derive(Deserialize)]
struct SenderParam {
    sender: Option<String>,
}

impl Authed {
    pub fn room(&self) -> &str {
        &self.auth.room
    }

    pub fn query<T: DeserializeOwned>(&self) -> ApiResult<T> {
        Query::<T>::try_from_uri(&self.uri).map(|q| q.0).map_err(|e| ApiError::bad_request(e.body_text()))
    }

    pub fn json<T: DeserializeOwned>(&self) -> ApiResult<T> {
        serde_json::from_slice(&self.body).map_err(|e| ApiError::bad_request(format!("invalid JSON body: {e}")))
    }
}

impl FromRequest<AppState> for Authed {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &AppState) -> ApiResult<Self> {
        let (mut parts, body) = req.into_parts();
        let Path(params) = Path::<HashMap<String, String>>::from_request_parts(&mut parts, state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        let room = params.get("room").cloned().unwrap_or_default();
        parse_room(&room)?;

        let now = now_ms();
        let pending = precheck(state, &room, &parts.headers, None, now)?;

        let limits = &state.config.limits;
        let limit = if parts.method == Method::PUT && parts.uri.path().contains("/blobs/") {
            limits.max_blob_bytes
        } else {
            limits.max_event_bytes + JSON_OVERHEAD_BYTES
        };
        let declared = header(&parts.headers, header::CONTENT_LENGTH.as_str()).and_then(|v| v.parse::<u64>().ok());
        if declared.is_some_and(|len| len > limit as u64) {
            return Err(ApiError::too_large(format!("request body exceeds {limit} bytes")));
        }
        let body = axum::body::to_bytes(body, limit).await.map_err(|e| {
            if e.into_inner().downcast_ref::<LengthLimitError>().is_some() {
                ApiError::too_large(format!("request body exceeds {limit} bytes"))
            } else {
                ApiError::bad_request("could not read the request body")
            }
        })?;

        let target = signed_target(original_uri(&parts));
        let auth = complete(state, &room, pending, parts.method.as_str(), &target, &body, now)?;
        let ip = parts.extensions.get::<ClientIp>().map(|c| c.0).unwrap_or(IpAddr::from([0, 0, 0, 0]));

        // Any authenticated request naming a sender refreshes that participant's presence.
        if let Ok(Query(SenderParam { sender: Some(sender) })) = Query::try_from_uri(&parts.uri)
            && crypto::is_id16(&sender)
        {
            presence::touch(state, &room, &sender).await;
        }

        Ok(Authed { auth, ip, body, uri: parts.uri })
    }
}

/// Nonces seen per room in the last 10 minutes (replay protection).
#[derive(Default)]
pub struct NonceCache {
    inner: Mutex<NonceInner>,
}

#[derive(Default)]
struct NonceInner {
    seen: HashSet<String>,
    expiry: VecDeque<(i64, String)>,
}

impl NonceInner {
    fn expire(&mut self, now: i64) {
        while let Some((at, _)) = self.expiry.front() {
            if *at > now {
                break;
            }
            let (_, key) = self.expiry.pop_front().unwrap();
            self.seen.remove(&key);
        }
    }
}

impl NonceCache {
    /// Records `nonce` for `room`; false if it was already seen.
    pub fn insert(&self, room: &str, nonce: &str, now: i64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        inner.expire(now);
        let key = format!("{room}/{nonce}");
        if !inner.seen.insert(key.clone()) {
            return false;
        }
        inner.expiry.push_back((now + NONCE_TTL_MS, key));
        true
    }

    pub fn sweep(&self, now: i64) {
        self.inner.lock().unwrap().expire(now);
    }
}

/// Bearer session tokens (in memory, keyed by the token's SHA-256).
pub struct Sessions {
    ttl_ms: i64,
    map: Mutex<HashMap<[u8; 32], Session>>,
}

struct Session {
    room: String,
    auth_pub: String,
    expires_at: i64,
}

impl Sessions {
    pub fn new(ttl: Duration) -> Self {
        Self { ttl_ms: ttl.as_millis() as i64, map: Mutex::new(HashMap::new()) }
    }

    fn key(token: &str) -> [u8; 32] {
        Sha256::digest(token.as_bytes()).into()
    }

    /// Issues a token bound to `room`; returns `(token, expires_at)`.
    pub fn issue(&self, room: &str, auth_pub: &str, now: i64) -> (String, i64) {
        let token = crypto::b64u(&rand::random::<[u8; 32]>());
        let expires_at = now + self.ttl_ms;
        let session = Session { room: room.to_owned(), auth_pub: auth_pub.to_owned(), expires_at };
        self.map.lock().unwrap().insert(Self::key(&token), session);
        (token, expires_at)
    }

    /// The room's `auth_pub` if `token` is valid for `room`.
    pub fn validate(&self, token: &str, room: &str, now: i64) -> Option<String> {
        let map = self.map.lock().unwrap();
        let s = map.get(&Self::key(token))?;
        (s.room == room && s.expires_at > now).then(|| s.auth_pub.clone())
    }

    pub fn sweep(&self, now: i64) {
        self.map.lock().unwrap().retain(|_, s| s.expires_at > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_replay_window() {
        let c = NonceCache::default();
        assert!(c.insert("r", "n", 0));
        assert!(!c.insert("r", "n", 1000));
        assert!(c.insert("other", "n", 1000));
        assert!(c.insert("r", "n", NONCE_TTL_MS + 1));
    }

    #[test]
    fn sessions_bound_to_room() {
        let s = Sessions::new(Duration::from_secs(10));
        let (token, exp) = s.issue("room-a", "pub", 1000);
        assert_eq!(exp, 11_000);
        assert_eq!(s.validate(&token, "room-a", 2000).as_deref(), Some("pub"));
        assert!(s.validate(&token, "room-b", 2000).is_none());
        assert!(s.validate(&token, "room-a", 11_000).is_none());
        assert!(s.validate("nope", "room-a", 2000).is_none());
        s.sweep(20_000);
        assert!(s.map.lock().unwrap().is_empty());
    }
}
