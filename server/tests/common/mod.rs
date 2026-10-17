//! Test harness: starts the real server on 127.0.0.1:0 against a fresh SQLite file, or a fresh
//! Postgres database when `LINCOR_TEST_PG_URL` points at a server (e.g.
//! `postgres://postgres:test@127.0.0.1:55432/postgres`).

#![allow(dead_code)]

use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use lincor_server::{
    AppState, Config,
    config::{Limits, Retention},
    crypto,
    util::now_ms,
};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use sqlx::{Connection, Executor};
use tempfile::TempDir;
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A random 16-byte id (cid, participant id, blob id).
pub fn id16() -> String {
    b64u(&rand::random::<[u8; 16]>())
}

/// Opaque event data of `n` random bytes.
pub fn data(n: usize) -> String {
    b64u(&(0..n).map(|_| rand::random::<u8>()).collect::<Vec<_>>())
}

pub fn backend_name() -> &'static str {
    if pg_admin_url().is_some() { "postgres" } else { "sqlite" }
}

fn pg_admin_url() -> Option<String> {
    std::env::var("LINCOR_TEST_PG_URL").ok().filter(|u| !u.is_empty())
}

/// A database URL for one test: a new SQLite file in `dir`, or a new Postgres database.
pub async fn fresh_database(dir: &TempDir) -> String {
    let Some(admin) = pg_admin_url() else {
        return format!("sqlite://{}/lincor.db?mode=rwc", dir.path().display());
    };
    sqlx::any::install_default_drivers();
    let name = format!("lincor_test_{}", hex::encode(rand::random::<[u8; 8]>()));
    let mut conn = sqlx::AnyConnection::connect(&admin).await.expect("connect to LINCOR_TEST_PG_URL");
    conn.execute(format!("CREATE DATABASE {name}").as_str()).await.expect("create test database");
    conn.close().await.ok();
    let (base, query) = admin.split_once('?').map_or((admin.as_str(), None), |(b, q)| (b, Some(q)));
    let scheme_end = base.find("://").map_or(0, |i| i + 3);
    let base = match base[scheme_end..].find('/') {
        Some(i) => &base[..scheme_end + i],
        None => base,
    };
    match query {
        Some(q) => format!("{base}/{name}?{q}"),
        None => format!("{base}/{name}"),
    }
}

/// Test defaults: limits off unless a test sets them, fast re-checks, no background sweep.
pub fn test_config(dir: &TempDir, database_url: String) -> Config {
    let defaults = Config::default();
    Config {
        bind: "127.0.0.1:0".parse().unwrap(),
        database_url,
        db_max_connections: 5,
        blob_dir: dir.path().join("blobs"),
        limits: Limits {
            requests_per_minute: 0,
            writes_per_minute: 0,
            new_rooms_per_hour: 0,
            ..defaults.limits.clone()
        },
        retention: Retention { gc_interval: Duration::from_secs(3600), ..defaults.retention.clone() },
        poll_interval: Duration::from_millis(200),
        ..defaults
    }
}

pub struct TestServer {
    pub base: String,
    pub state: AppState,
    pub http: reqwest::Client,
    pub dir: TempDir,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::with(|_| {}).await
    }

    pub async fn with(adjust: impl FnOnce(&mut Config)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let url = fresh_database(&dir).await;
        let mut config = test_config(&dir, url);
        adjust(&mut config);
        Self::from_config(dir, config).await
    }

    /// Starts a server for an explicit configuration (e.g. a second instance on the same database).
    pub async fn from_config(dir: TempDir, config: Config) -> Self {
        let state = AppState::new(config).await.expect("start app");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(lincor_server::serve(listener, state.clone(), async {
            let _ = stopped.await;
        }));
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
        Self { base, state, http, dir, stop: Some(stop), task: Some(task) }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub fn ws_url(&self, path: &str) -> String {
        format!("{}{}", self.base.replacen("http", "ws", 1), path)
    }

    /// A request signed for `room` per PROTOCOL §6.1.
    pub fn signed(&self, room: &Room, method: Method, target: &str, body: impl Into<Vec<u8>>) -> RequestBuilder {
        self.signed_with(room, method, target, body.into(), now_ms(), &id16())
    }

    pub fn signed_with(
        &self,
        room: &Room,
        method: Method,
        target: &str,
        body: Vec<u8>,
        ts: i64,
        nonce: &str,
    ) -> RequestBuilder {
        let ts = ts.to_string();
        let sig = room.sign(method.as_str(), target, &body, &ts, nonce);
        let mut req = self
            .http
            .request(method, self.url(target))
            .header("X-Lincor-Pub", room.pub_b64())
            .header("X-Lincor-Ts", ts)
            .header("X-Lincor-Nonce", nonce)
            .header("X-Lincor-Sig", sig);
        if !body.is_empty() {
            req = req.body(body);
        }
        req
    }

    pub async fn get(&self, room: &Room, target: &str) -> (StatusCode, Value) {
        json_of(self.signed(room, Method::GET, target, Vec::new()).send().await.unwrap()).await
    }

    pub async fn send_json(&self, room: &Room, method: Method, target: &str, body: &Value) -> (StatusCode, Value) {
        let bytes = serde_json::to_vec(body).unwrap();
        json_of(
            self.signed(room, method, target, bytes).header("Content-Type", "application/json").send().await.unwrap(),
        )
        .await
    }

    pub async fn post_event(&self, room: &Room, cid: &str, sender: &str, data: &str) -> (StatusCode, Value) {
        self.send_json(room, Method::POST, &room.path("/events"), &json!({"cid": cid, "sender": sender, "data": data}))
            .await
    }

    /// Posts `n` events from `sender`; returns their seqs.
    pub async fn post_many(&self, room: &Room, sender: &str, n: usize) -> Vec<i64> {
        let mut seqs = Vec::new();
        for _ in 0..n {
            let (status, body) = self.post_event(room, &id16(), sender, &data(64)).await;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            seqs.push(body["seq"].as_i64().unwrap());
        }
        seqs
    }

    pub async fn room_info(&self, room: &Room) -> Value {
        let (status, body) = self.get(room, &room.path("")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    pub async fn presence(&self, room: &Room) -> Vec<(String, String)> {
        let (status, body) = self.get(room, &room.path("/presence")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["presence"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p["sender"].as_str().unwrap().to_owned(), p["state"].as_str().unwrap().to_owned()))
            .collect()
    }

    pub async fn state_of(&self, room: &Room, sender: &str) -> Option<String> {
        self.presence(room).await.into_iter().find(|(s, _)| s == sender).map(|(_, st)| st)
    }

    pub async fn token(&self, room: &Room) -> String {
        let (status, body) =
            json_of(self.signed(room, Method::POST, &room.path("/session"), Vec::new()).send().await.unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["token"].as_str().unwrap().to_owned()
    }

    /// Runs raw SQL against the server's database (to move timestamps into the past).
    pub async fn sql(&self, sql: &str) {
        sqlx::query(sql).execute(self.state.db.pool()).await.unwrap();
    }

    pub async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(sql).fetch_one(self.state.db.pool()).await.unwrap()
    }

    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
        }
        self.state.db.close().await;
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

pub async fn json_of(res: reqwest::Response) -> (StatusCode, Value) {
    let status = res.status();
    let bytes = res.bytes().await.unwrap();
    let value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
    (status, value)
}

/// A room as a client holding its key sees it: the auth keypair and the derived roomId.
pub struct Room {
    pub key: SigningKey,
    pub id: String,
}

impl Room {
    pub fn new() -> Self {
        Self::from_seed(rand::random())
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        let key = SigningKey::from_bytes(&seed);
        let id = crypto::room_id_for(key.verifying_key().as_bytes());
        Self { key, id }
    }

    pub fn pub_b64(&self) -> String {
        b64u(self.key.verifying_key().as_bytes())
    }

    pub fn path(&self, suffix: &str) -> String {
        format!("/api/v1/rooms/{}{}", self.id, suffix)
    }

    pub fn sign(&self, method: &str, target: &str, body: &[u8], ts: &str, nonce: &str) -> String {
        let message = crypto::request_message(method, target, body, ts, nonce);
        b64u(&self.key.sign(&message).to_bytes())
    }
}

/// Polls `check` until it returns true or `within` elapses.
pub async fn eventually<F, Fut>(within: Duration, mut check: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if check().await {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
