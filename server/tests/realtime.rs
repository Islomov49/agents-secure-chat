//! Long polling, presence and the WebSocket stream.

mod common;

use std::time::{Duration, Instant};

use common::{Room, TestServer, data, eventually, id16};
use futures_util::{SinkExt, StreamExt};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::test]
async fn wait_returns_backlog_immediately() {
    let s = TestServer::start().await;
    let room = Room::new();
    s.post_many(&room, &id16(), 3).await;
    let started = Instant::now();
    let (status, page) = s.get(&room, &room.path("/wait?after=1&timeout=30")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(started.elapsed() < Duration::from_secs(2));
    let seqs: Vec<i64> = page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![2, 3]);
    let (_, page) = s.get(&room, &room.path("/wait?after=0&timeout=30&limit=1")).await;
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn wait_wakes_when_another_client_posts() {
    let s = TestServer::start().await;
    let room = Room::new();
    let sender = id16();
    s.post_many(&room, &sender, 1).await;
    let waiter = s.signed(&room, Method::GET, &room.path("/wait?after=1&timeout=20"), Vec::new()).send();
    let started = Instant::now();
    let waiting = tokio::spawn(async move { common::json_of(waiter.await.unwrap()).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!waiting.is_finished());
    let (_, posted) = s.post_event(&room, &id16(), &id16(), &data(30)).await;
    let (status, page) = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(page["events"][0]["seq"], posted["seq"]);
}

#[tokio::test]
async fn wait_wakes_for_the_first_event_of_a_new_room() {
    let s = TestServer::start().await;
    let room = Room::new();
    let waiter = s.signed(&room, Method::GET, &room.path("/wait?timeout=20"), Vec::new()).send();
    let waiting = tokio::spawn(async move { common::json_of(waiter.await.unwrap()).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    s.post_many(&room, &id16(), 1).await;
    let (_, page) = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    assert_eq!(page["events"][0]["seq"], 1);
}

#[tokio::test]
async fn wait_times_out_empty() {
    let s = TestServer::start().await;
    let room = Room::new();
    s.post_many(&room, &id16(), 1).await;
    let started = Instant::now();
    let (status, page) = s.get(&room, &room.path("/wait?after=1&timeout=1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page, json!({"events": []}));
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(900) && elapsed < Duration::from_secs(4), "{elapsed:?}");
}

#[tokio::test]
async fn wait_reports_deletion() {
    let s = TestServer::start().await;
    let room = Room::new();
    s.post_many(&room, &id16(), 1).await;
    let waiter = s.signed(&room, Method::GET, &room.path("/wait?after=1&timeout=20"), Vec::new()).send();
    let waiting = tokio::spawn(async move { common::json_of(waiter.await.unwrap()).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (_, del) =
        common::json_of(s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap()).await;
    let (_, page) = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    assert_eq!(page, json!({"events": [], "deleted": {"purge_at": del["purge_at"]}}));
}

/// Two server instances on one database: a wait on B sees a post on A through the periodic re-check.
#[tokio::test]
async fn wait_works_across_instances() {
    let a = TestServer::start().await;
    let config = a.state.config.clone();
    let b = TestServer::from_config(tempfile::tempdir().unwrap(), config).await;
    let room = Room::new();
    a.post_many(&room, &id16(), 1).await;
    let waiter = b.signed(&room, Method::GET, &room.path("/wait?after=1&timeout=20"), Vec::new()).send();
    let waiting = tokio::spawn(async move { common::json_of(waiter.await.unwrap()).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.post_many(&room, &id16(), 1).await;
    let (_, page) = tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
    assert_eq!(page["events"][0]["seq"], 2);
    b.stop().await;
}

#[tokio::test]
async fn presence_states() {
    let s = TestServer::start().await;
    let room = Room::new();
    let (alice, bob) = (id16(), id16());
    s.post_many(&room, &alice, 1).await;
    assert_eq!(s.state_of(&room, &alice).await.as_deref(), Some("online"));

    let report = |sender: String, state: &'static str| {
        let (s, room) = (&s, &room);
        async move {
            s.send_json(room, Method::POST, &room.path("/presence"), &json!({"sender": sender, "state": state})).await
        }
    };
    assert_eq!(report(alice.clone(), "offline").await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.state_of(&room, &alice).await.as_deref(), Some("offline"));
    assert_eq!(report(bob.clone(), "listening").await.0, StatusCode::NO_CONTENT);
    assert_eq!(s.state_of(&room, &bob).await.as_deref(), Some("listening"));
    assert_eq!(report(bob.clone(), "sleeping").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(report("nope".into(), "online").await.0, StatusCode::BAD_REQUEST);

    // An open wait shows its sender as listening, whatever it reported before.
    let waiter =
        s.signed(&room, Method::GET, &room.path(&format!("/wait?after=1&timeout=3&sender={alice}")), Vec::new()).send();
    let waiting = tokio::spawn(waiter);
    assert!(
        eventually(Duration::from_secs(3), || async {
            s.state_of(&room, &alice).await.as_deref() == Some("listening")
        })
        .await
    );
    let res = tokio::time::timeout(Duration::from_secs(6), waiting).await.unwrap().unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        eventually(Duration::from_secs(3), || async { s.state_of(&room, &alice).await.as_deref() == Some("online") })
            .await
    );

    // Silence for longer than 90 s means offline.
    let stale = lincor_server::util::now_ms() - 120_000;
    s.sql(&format!("UPDATE members SET last_seen = {stale}, state = 'online' WHERE sender = '{alice}'")).await;
    let entries = s.get(&room, &room.path("/presence")).await.1;
    let entry = entries["presence"].as_array().unwrap().iter().find(|p| p["sender"] == alice.as_str()).unwrap().clone();
    assert_eq!(entry["state"], "offline");
    assert_eq!(entry["last_seen"], stale);

    // Any request naming the sender refreshes it (forget the per-instance write throttle first:
    // in real life the 90 s of silence have long expired it).
    lincor_server::presence::forget_touches(&s.state, i64::MAX / 2);
    s.get(&room, &room.path(&format!("/events?sender={alice}"))).await;
    assert_eq!(s.state_of(&room, &alice).await.as_deref(), Some("online"));
}

async fn next_frame<S>(ws: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("frame within 5 s")
            .expect("stream open")
            .expect("frame");
        match msg {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Close(_) => return json!({"type": "closed"}),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn websocket_streams_backlog_live_events_and_presence() {
    let s = TestServer::start().await;
    let room = Room::new();
    let (me, peer) = (id16(), id16());
    s.post_many(&room, &peer, 3).await;
    let token = s.token(&room).await;

    let url = s.ws_url(&room.path(&format!("/stream?token={token}&after=1&sender={me}")));
    let (mut ws, _) = connect_async(url).await.expect("websocket upgrade");

    let first = next_frame(&mut ws).await;
    assert_eq!(first["type"], "presence");
    assert_eq!(first["presence"][0]["sender"], peer.as_str());
    let e2 = next_frame(&mut ws).await;
    let e3 = next_frame(&mut ws).await;
    assert_eq!((e2["type"].as_str(), e2["event"]["seq"].as_i64()), (Some("event"), Some(2)));
    assert_eq!(e3["event"]["seq"], 3);
    assert_eq!(e3["event"]["sender"], peer.as_str());
    assert!(e3["event"]["cid"].is_string() && e3["event"]["data"].is_string() && e3["event"]["ts"].is_number());
    assert_eq!(next_frame(&mut ws).await, json!({"type": "ready"}));

    // Live event.
    let (_, posted) = s.post_event(&room, &id16(), &me, &data(20)).await;
    let mut saw_event = false;
    let mut saw_me = false;
    for _ in 0..5 {
        let f = next_frame(&mut ws).await;
        match f["type"].as_str() {
            Some("event") => {
                assert_eq!(f["event"]["seq"], posted["seq"]);
                saw_event = true;
            }
            Some("presence") => {
                saw_me |= f["presence"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["sender"] == me.as_str() && p["state"] == "listening");
            }
            other => panic!("unexpected frame {other:?}"),
        }
        if saw_event && saw_me {
            break;
        }
    }
    assert!(saw_event && saw_me, "event {saw_event}, own presence {saw_me}");

    // Presence frames follow changes, including the ones sent over the socket.
    let (status, _) =
        s.send_json(&room, Method::POST, &room.path("/presence"), &json!({"sender": peer, "state": "offline"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let f = next_frame(&mut ws).await;
    assert_eq!(f["type"], "presence");
    let peer_state =
        f["presence"].as_array().unwrap().iter().find(|p| p["sender"] == peer.as_str()).unwrap()["state"].clone();
    assert_eq!(peer_state, "offline");
    ws.send(Message::Text(r#"{"type":"presence","state":"offline"}"#.into())).await.unwrap();
    assert!(
        eventually(Duration::from_secs(3), || async {
            let rows =
                s.count(&format!("SELECT COUNT(*) FROM members WHERE sender = '{me}' AND state = 'offline'")).await;
            rows == 1
        })
        .await
    );
    assert_eq!(s.state_of(&room, &me).await.as_deref(), Some("listening"), "an open stream still means listening");

    // Deletion.
    let (_, del) =
        common::json_of(s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap()).await;
    loop {
        let f = next_frame(&mut ws).await;
        if f["type"] == "deleted" {
            assert_eq!(f["purge_at"], del["purge_at"]);
            break;
        }
        assert_eq!(f["type"], "presence");
    }
    assert_eq!(next_frame(&mut ws).await["type"], "closed");
    assert!(
        eventually(Duration::from_secs(3), || async {
            s.count(&format!("SELECT COUNT(*) FROM members WHERE sender = '{me}' AND listen_until IS NULL")).await == 1
        })
        .await,
        "closing the stream ends listening"
    );
}

#[tokio::test]
async fn websocket_on_an_empty_room_gets_the_first_event() {
    let s = TestServer::start().await;
    let room = Room::new();
    let token = s.token(&room).await;
    let (mut ws, _) = connect_async(s.ws_url(&room.path(&format!("/stream?token={token}")))).await.unwrap();
    assert_eq!(next_frame(&mut ws).await, json!({"type": "presence", "presence": []}));
    assert_eq!(next_frame(&mut ws).await, json!({"type": "ready"}));
    s.post_many(&room, &id16(), 1).await;
    loop {
        let f = next_frame(&mut ws).await;
        if f["type"] == "event" {
            assert_eq!(f["event"]["seq"], 1);
            break;
        }
    }
}

#[tokio::test]
async fn websocket_requires_a_valid_token() {
    let s = TestServer::start().await;
    let (room, other) = (Room::new(), Room::new());
    let token = s.token(&other).await;
    for url in [
        s.ws_url(&room.path("/stream")),
        s.ws_url(&room.path("/stream?token=garbage")),
        s.ws_url(&room.path(&format!("/stream?token={token}"))),
    ] {
        match connect_async(url).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => assert_eq!(res.status(), 401),
            other => panic!("expected 401, got {:?}", other.map(|(_, r)| r.status())),
        }
    }
}

#[tokio::test]
async fn websocket_sees_events_from_another_instance() {
    let dir = tempfile::tempdir().unwrap();
    let a = TestServer::start().await;
    let b = TestServer::from_config(dir, a.state.config.clone()).await;
    let room = Room::new();
    let token = b.token(&room).await;
    let (mut ws, _) = connect_async(b.ws_url(&room.path(&format!("/stream?token={token}")))).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["type"], "presence");
    assert_eq!(next_frame(&mut ws).await["type"], "ready");
    a.post_many(&room, &id16(), 1).await;
    loop {
        let f = next_frame(&mut ws).await;
        if f["type"] == "event" {
            assert_eq!(f["event"]["seq"], 1);
            break;
        }
    }
}
