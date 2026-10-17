//! HTTP API: authentication, lazy creation, events, blobs, limits and room management.

mod common;

use std::time::Duration;

use common::{Room, TestServer, data, id16, json_of};
use lincor_server::{gc, util::now_ms};
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn signed_request_is_accepted() {
    let s = TestServer::start().await;
    let room = Room::new();
    let res = s.signed(&room, Method::GET, &room.path("/events?after=0&limit=10"), Vec::new()).send().await.unwrap();
    assert_eq!(res.headers()["cache-control"], "no-store");
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"events": []}));
    let (status, body) = s.post_event(&room, &id16(), &id16(), &data(40)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["seq"], 1);
    assert_eq!(body["created"], true);
    assert!(body["ts"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn pub_of_another_room_is_rejected() {
    let s = TestServer::start().await;
    let (mine, other) = (Room::new(), Room::new());
    let res = s.signed(&mine, Method::GET, &other.path("/events"), Vec::new()).send().await.unwrap();
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "auth");
}

#[tokio::test]
async fn bad_signature_is_rejected() {
    let s = TestServer::start().await;
    let room = Room::new();
    let target = room.path("/events");
    let ts = now_ms().to_string();
    let nonce = id16();
    let mut sig = room.sign("GET", &target, b"", &ts, &nonce).into_bytes();
    sig[3] = if sig[3] == b'A' { b'B' } else { b'A' };
    let res = s
        .http
        .get(s.url(&target))
        .header("X-Lincor-Pub", room.pub_b64())
        .header("X-Lincor-Ts", &ts)
        .header("X-Lincor-Nonce", &nonce)
        .header("X-Lincor-Sig", String::from_utf8(sig).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // A signature over a different body, method or target does not verify either.
    let body = br#"{"cid":"AAECAwQFBgcICQoLDA0ODw","sender":"AAECAwQFBgcICQoLDA0ODw","data":"AAAA"}"#.to_vec();
    let sig = room.sign("POST", &target, b"{}", &ts, &nonce);
    let res = s
        .http
        .post(s.url(&target))
        .header("X-Lincor-Pub", room.pub_b64())
        .header("X-Lincor-Ts", &ts)
        .header("X-Lincor-Nonce", &nonce)
        .header("X-Lincor-Sig", sig)
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let sig = room.sign("GET", &room.path("/presence"), b"", &ts, &id16());
    let res = s
        .http
        .get(s.url(&target))
        .header("X-Lincor-Pub", room.pub_b64())
        .header("X-Lincor-Ts", &ts)
        .header("X-Lincor-Nonce", id16())
        .header("X-Lincor-Sig", sig)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Missing headers.
    let res = s.http.get(s.url(&target)).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stale_and_future_timestamps_are_rejected() {
    let s = TestServer::start().await;
    let room = Room::new();
    let target = room.path("/events");
    for offset in [-301_000, 301_000] {
        let res =
            s.signed_with(&room, Method::GET, &target, Vec::new(), now_ms() + offset, &id16()).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "offset {offset}");
    }
    for offset in [-200_000, 200_000] {
        let res =
            s.signed_with(&room, Method::GET, &target, Vec::new(), now_ms() + offset, &id16()).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "offset {offset}");
    }
}

#[tokio::test]
async fn replayed_nonce_is_rejected() {
    let s = TestServer::start().await;
    let room = Room::new();
    let target = room.path("/events");
    let (ts, nonce) = (now_ms(), id16());
    let first = s.signed_with(&room, Method::GET, &target, Vec::new(), ts, &nonce).send().await.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let replay = s.signed_with(&room, Method::GET, &target, Vec::new(), ts, &nonce).send().await.unwrap();
    let (status, body) = json_of(replay).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body["message"].as_str().unwrap().contains("nonce"), "{body}");
    // The same nonce in another room is independent.
    let other = Room::new();
    let res = s.signed_with(&other, Method::GET, &other.path("/events"), Vec::new(), ts, &nonce).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn bearer_tokens_are_bound_to_their_room() {
    let s = TestServer::start().await;
    let (room, other) = (Room::new(), Room::new());
    let res = s.signed(&room, Method::POST, &room.path("/session"), Vec::new()).send().await.unwrap();
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::OK);
    let token = body["token"].as_str().unwrap().to_owned();
    assert_eq!(common::b64u(&[0; 32]).len(), token.len());
    let expires = body["expires_at"].as_i64().unwrap();
    assert!((expires - now_ms() - 3_600_000).abs() < 10_000);

    let bearer = |path: String, t: &str| s.http.get(s.url(&path)).bearer_auth(t).send();
    assert_eq!(bearer(room.path("/events"), &token).await.unwrap().status(), StatusCode::OK);
    assert_eq!(bearer(room.path(""), &token).await.unwrap().status(), StatusCode::OK);
    assert_eq!(bearer(other.path("/events"), &token).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(bearer(room.path("/events"), "not-a-token").await.unwrap().status(), StatusCode::UNAUTHORIZED);

    // A token can write (the room is created with the cached auth_pub) but cannot mint new sessions.
    let post = s
        .http
        .post(s.url(&room.path("/events")))
        .bearer_auth(&token)
        .json(&json!({"cid": id16(), "sender": id16(), "data": data(32)}))
        .send()
        .await
        .unwrap();
    assert_eq!(post.status(), StatusCode::CREATED);
    let res = s.http.post(s.url(&room.path("/session"))).bearer_auth(&token).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rooms_are_created_lazily() {
    let s = TestServer::start().await;
    let room = Room::new();
    let count_rooms = format!("SELECT COUNT(*) FROM rooms WHERE id = '{}'", room.id);

    let info = s.room_info(&room).await;
    assert_eq!(info, json!({"exists": false, "usage_bytes": 0, "event_count": 0}));
    assert_eq!(s.get(&room, &room.path("/events")).await.1, json!({"events": []}));
    assert_eq!(s.get(&room, &room.path("/presence")).await.1, json!({"presence": []}));
    let blob = s.get(&room, &room.path(&format!("/blobs/{}", id16()))).await;
    assert_eq!(blob.0, StatusCode::NOT_FOUND);
    let sender = id16();
    let (status, _) =
        s.send_json(&room, Method::POST, &room.path("/presence"), &json!({"sender": sender, "state": "online"})).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let wait = s.get(&room, &room.path(&format!("/wait?timeout=1&sender={sender}"))).await;
    assert_eq!(wait.1, json!({"events": []}));
    s.token(&room).await;
    assert_eq!(s.count(&count_rooms).await, 0, "reads, presence and sessions must not create a room");
    assert_eq!(s.count("SELECT COUNT(*) FROM members").await, 0);
    let (status, _) = s.send_json(&room, Method::PUT, &room.path("/ttl"), &json!({"msg_ttl_days": 3})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let del = json_of(s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap()).await;
    assert_eq!(del.0, StatusCode::NOT_FOUND);
    assert_eq!(s.count(&count_rooms).await, 0);

    let (status, body) = s.post_event(&room, &id16(), &sender, &data(40)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["created"], true);
    assert_eq!(s.count(&count_rooms).await, 1);
    let (_, body) = s.post_event(&room, &id16(), &sender, &data(40)).await;
    assert_eq!(body["created"], false);
    let info = s.room_info(&room).await;
    assert_eq!(info["exists"], true);
    assert_eq!(info["event_count"], 2);
    assert_eq!(info["usage_bytes"], 2 * data(40).len());
    assert!(info["created_at"].as_i64().unwrap() > 0);
    assert!(info.get("deleted_at").is_none());

    // A blob upload creates a room too.
    let second = Room::new();
    let res = s
        .signed(&second, Method::PUT, &second.path(&format!("/blobs/{}", id16())), vec![1u8; 10])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    assert_eq!(s.room_info(&second).await["exists"], true);
}

#[tokio::test]
async fn cid_is_idempotent() {
    let s = TestServer::start().await;
    let room = Room::new();
    let (cid, sender, payload) = (id16(), id16(), data(50));
    let (status, first) = s.post_event(&room, &cid, &sender, &payload).await;
    assert_eq!(status, StatusCode::CREATED);
    s.post_many(&room, &sender, 2).await;
    let (status, again) = s.post_event(&room, &cid, &sender, &data(20)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["seq"], first["seq"]);
    assert_eq!(again["ts"], first["ts"]);
    assert_eq!(again["created"], false);
    let (_, page) = s.get(&room, &room.path("/events")).await;
    let events = page["events"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["data"], payload.as_str());
    assert_eq!(s.room_info(&room).await["event_count"], 3);
    // The same cid in another room is a different event.
    let other = Room::new();
    assert_eq!(s.post_event(&other, &cid, &sender, &payload).await.0, StatusCode::CREATED);
}

#[tokio::test]
async fn seq_is_gap_free_under_concurrent_writers() {
    let s = TestServer::start().await;
    let room = Room::new();
    let senders: Vec<String> = (0..5).map(|_| id16()).collect();
    let dup = id16();
    let mut tasks = Vec::new();
    for i in 0..50 {
        let cid = if i % 10 == 0 { dup.clone() } else { id16() };
        let req = s
            .signed(
                &room,
                Method::POST,
                &room.path("/events"),
                serde_json::to_vec(&json!({"cid": cid, "sender": senders[i % 5], "data": data(64)})).unwrap(),
            )
            .header("Content-Type", "application/json");
        tasks.push(tokio::spawn(async move { json_of(req.send().await.unwrap()).await }));
    }
    let mut seqs = Vec::new();
    let mut created = 0;
    for t in tasks {
        let (status, body) = t.await.unwrap();
        assert!(status == StatusCode::CREATED || status == StatusCode::OK, "{status} {body}");
        if status == StatusCode::CREATED {
            seqs.push(body["seq"].as_i64().unwrap());
            created += 1;
        }
    }
    // 45 distinct cids plus 5 posts of one shared cid → 46 events.
    assert_eq!(created, 46);
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=46).collect::<Vec<i64>>());
    let (_, page) = s.get(&room, &room.path("/events?after=0&limit=1000")).await;
    let listed: Vec<i64> = page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(listed, (1..=46).collect::<Vec<i64>>());
    let (_, page) = s.get(&room, &room.path("/events?after=40&limit=3")).await;
    let listed: Vec<i64> = page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(listed, vec![41, 42, 43]);
}

#[tokio::test]
async fn malformed_input_is_rejected() {
    let s = TestServer::with(|c| c.limits.max_event_bytes = 100).await;
    let room = Room::new();
    let sender = id16();
    let cases = [
        (json!({"cid": "short", "sender": sender, "data": "AAAA"}), StatusCode::BAD_REQUEST),
        (json!({"cid": id16(), "sender": "x", "data": "AAAA"}), StatusCode::BAD_REQUEST),
        (json!({"cid": id16(), "sender": sender, "data": "not base64!"}), StatusCode::BAD_REQUEST),
        (json!({"cid": id16(), "sender": sender, "data": ""}), StatusCode::BAD_REQUEST),
        (json!({"cid": id16(), "sender": sender}), StatusCode::BAD_REQUEST),
        (json!({"cid": id16(), "sender": sender, "data": "A".repeat(101)}), StatusCode::PAYLOAD_TOO_LARGE),
    ];
    for (body, expected) in cases {
        let (status, err) = s.send_json(&room, Method::POST, &room.path("/events"), &body).await;
        assert_eq!(status, expected, "{body} → {err}");
        assert!(err["error"].is_string() && err["message"].is_string(), "{err}");
    }
    let (status, _) = s.post_event(&room, &id16(), &sender, &"A".repeat(100)).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, err) =
        s.send_json(&room, Method::POST, &room.path("/events"), &json!({"x": "y".repeat(10_000)})).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{err}");

    let res = s.http.get(s.url("/api/v1/rooms/not-a-room/events")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let (status, _) = s.get(&room, &room.path("/events?after=-1")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = s.get(&room, &room.path("/events?after=abc")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn blobs_round_trip_with_limits_and_quota() {
    let s = TestServer::with(|c| {
        c.limits.max_blob_bytes = 1000;
        c.limits.room_quota_bytes = 2500;
    })
    .await;
    let room = Room::new();
    let blob = id16();
    let bytes: Vec<u8> = (0..900).map(|i| (i % 251) as u8).collect();
    let res = s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{blob}")), bytes.clone()).send().await.unwrap();
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body, json!({"size": 900}));

    let res = s.signed(&room, Method::GET, &room.path(&format!("/blobs/{blob}")), Vec::new()).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["content-type"], "application/octet-stream");
    assert_eq!(res.bytes().await.unwrap().to_vec(), bytes);
    assert_eq!(s.room_info(&room).await["usage_bytes"], 900);

    // Re-uploading the same id replaces it without double counting.
    let res = s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{blob}")), vec![7u8; 800]).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    assert_eq!(s.room_info(&room).await["usage_bytes"], 800);

    let res =
        s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{}", id16())), vec![0u8; 1001]).send().await.unwrap();
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"], "too_large");

    let res =
        s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{}", id16())), vec![0u8; 1000]).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let over = id16();
    let res =
        s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{over}")), vec![0u8; 1000]).send().await.unwrap();
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE);
    assert_eq!(body["error"], "quota_exceeded");
    assert_eq!(s.room_info(&room).await["usage_bytes"], 1800);
    let missing = s.get(&room, &room.path(&format!("/blobs/{over}"))).await;
    assert_eq!(missing.0, StatusCode::NOT_FOUND);

    // Events count toward the same quota (data(300) is 400 base64url characters).
    let (status, _) = s.post_event(&room, &id16(), &id16(), &data(300)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(s.room_info(&room).await["usage_bytes"], 2200);
    let (status, body) = s.post_event(&room, &id16(), &id16(), &data(300)).await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{body}");

    let bad = s.get(&room, &room.path("/blobs/..%2F..%2Fetc")).await;
    assert_eq!(bad.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn room_full_limits_distinct_senders() {
    let s = TestServer::with(|c| c.limits.max_senders = 2).await;
    let room = Room::new();
    let (a, b, c) = (id16(), id16(), id16());
    assert_eq!(s.post_event(&room, &id16(), &a, &data(10)).await.0, StatusCode::CREATED);
    assert_eq!(s.post_event(&room, &id16(), &b, &data(10)).await.0, StatusCode::CREATED);
    let (status, body) = s.post_event(&room, &id16(), &c, &data(10)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "room_full");
    let (status, _) =
        s.send_json(&room, Method::POST, &room.path("/presence"), &json!({"sender": c, "state": "online"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(s.post_event(&room, &id16(), &a, &data(10)).await.0, StatusCode::CREATED);
    assert_eq!(s.room_info(&room).await["event_count"], 3);
}

#[tokio::test]
async fn soft_delete_restore_and_purge() {
    let s = TestServer::with(|c| c.retention.delete_grace = Duration::from_millis(1500)).await;
    let room = Room::new();
    let sender = id16();
    s.post_many(&room, &sender, 2).await;
    let blob = id16();
    let res = s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{blob}")), vec![1u8; 100]).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let (status, del) =
        json_of(s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{del}");
    let purge_at = del["purge_at"].as_i64().unwrap();
    assert_eq!(purge_at - del["deleted_at"].as_i64().unwrap(), 1500);

    let (status, body) = s.post_event(&room, &id16(), &sender, &data(10)).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(body["error"], "room_deleted");
    let res =
        s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{}", id16())), vec![1u8; 10]).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::GONE);
    assert_eq!(s.get(&room, &room.path(&format!("/blobs/{blob}"))).await.0, StatusCode::GONE);
    let (status, _) = s.send_json(&room, Method::PUT, &room.path("/ttl"), &json!({"msg_ttl_days": 1})).await;
    assert_eq!(status, StatusCode::GONE);
    let (_, page) = s.get(&room, &room.path("/events")).await;
    assert_eq!(page, json!({"events": [], "deleted": {"purge_at": purge_at}}));
    let info = s.room_info(&room).await;
    assert_eq!(info["exists"], true);
    assert_eq!(info["purge_at"], purge_at);
    // Deleting again reports the same schedule.
    let (_, again) = json_of(s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap()).await;
    assert_eq!(again["purge_at"], purge_at);

    let (status, body) =
        json_of(s.signed(&room, Method::POST, &room.path("/restore"), Vec::new()).send().await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({}));
    assert_eq!(s.get(&room, &room.path("/events")).await.1["events"].as_array().unwrap().len(), 2);
    assert_eq!(s.post_event(&room, &id16(), &sender, &data(10)).await.0, StatusCode::CREATED);
    assert_eq!(s.get(&room, &room.path(&format!("/blobs/{blob}"))).await.0, StatusCode::OK);

    // Delete again and let the grace period pass: the sweep purges everything.
    s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap();
    tokio::time::sleep(Duration::from_millis(1700)).await;
    let report = gc::run_once(&s.state).await.unwrap();
    assert_eq!(report.deleted_purged, 1);
    assert_eq!(s.count("SELECT COUNT(*) FROM events").await, 0);
    assert_eq!(s.count("SELECT COUNT(*) FROM blobs").await, 0);
    assert_eq!(s.count("SELECT COUNT(*) FROM members").await, 0);
    assert!(!s.dir.path().join("blobs").join(&room.id).join(&blob).exists());
    assert_eq!(s.room_info(&room).await["exists"], false);
    let restore = s.signed(&room, Method::POST, &room.path("/restore"), Vec::new()).send().await.unwrap();
    assert_eq!(restore.status(), StatusCode::NOT_FOUND);
    // The room id can start over from seq 1.
    let (status, body) = s.post_event(&room, &id16(), &sender, &data(10)).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["seq"], 1);
    assert_eq!(body["created"], true);
}

#[tokio::test]
async fn expired_room_is_gone_before_the_sweep_runs() {
    let s = TestServer::with(|c| c.retention.delete_grace = Duration::from_millis(300)).await;
    let room = Room::new();
    s.post_many(&room, &id16(), 1).await;
    s.signed(&room, Method::DELETE, &room.path(""), Vec::new()).send().await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(s.room_info(&room).await["exists"], false);
    assert_eq!(s.count("SELECT COUNT(*) FROM rooms").await, 0);
}

#[tokio::test]
async fn message_ttl_purges_old_events_and_blobs() {
    let s = TestServer::start().await;
    let room = Room::new();
    let sender = id16();
    s.post_many(&room, &sender, 3).await;
    let (old_blob, new_blob) = (id16(), id16());
    for b in [&old_blob, &new_blob] {
        let res = s.signed(&room, Method::PUT, &room.path(&format!("/blobs/{b}")), vec![2u8; 50]).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
    }
    let three_days_ago = now_ms() - 3 * 86_400_000;
    s.sql(&format!("UPDATE events SET ts = {three_days_ago} WHERE room_id = '{}' AND seq <= 2", room.id)).await;
    s.sql(&format!("UPDATE blobs SET created_at = {three_days_ago} WHERE id = '{old_blob}'")).await;

    for bad in [json!({"msg_ttl_days": 0}), json!({"msg_ttl_days": -1}), json!({"msg_ttl_days": "x"})] {
        let (status, _) = s.send_json(&room, Method::PUT, &room.path("/ttl"), &bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (status, body) = s.send_json(&room, Method::PUT, &room.path("/ttl"), &json!({"msg_ttl_days": 5})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"msg_ttl_days": 5})));
    assert_eq!(gc::run_once(&s.state).await.unwrap().ttl_rooms_trimmed, 0, "nothing is older than 5 days");

    // Setting the TTL applies it right away.
    let (status, body) = s.send_json(&room, Method::PUT, &room.path("/ttl"), &json!({"msg_ttl_days": 2})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"msg_ttl_days": 2})));
    let (_, page) = s.get(&room, &room.path("/events")).await;
    let seqs: Vec<i64> = page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![3]);
    assert_eq!(s.get(&room, &room.path(&format!("/blobs/{old_blob}"))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(s.get(&room, &room.path(&format!("/blobs/{new_blob}"))).await.0, StatusCode::OK);
    let info = s.room_info(&room).await;
    assert_eq!(info["msg_ttl_days"], 2);
    assert_eq!(info["event_count"], 1);
    assert_eq!(info["usage_bytes"], data(64).len() + 50);

    // The sweep keeps applying it; seq keeps counting.
    s.sql(&format!("UPDATE events SET ts = {three_days_ago} WHERE room_id = '{}'", room.id)).await;
    assert_eq!(gc::run_once(&s.state).await.unwrap().ttl_rooms_trimmed, 1);
    assert_eq!(s.room_info(&room).await["event_count"], 0);
    assert_eq!(s.post_many(&room, &sender, 1).await, vec![4]);

    let (status, body) = s.send_json(&room, Method::PUT, &room.path("/ttl"), &json!({"msg_ttl_days": null})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"msg_ttl_days": null})));
    assert!(s.room_info(&room).await.get("msg_ttl_days").is_none());
}

#[tokio::test]
async fn retention_removes_near_empty_and_inactive_rooms() {
    let s = TestServer::start().await;
    let (single, busy, idle, fresh) = (Room::new(), Room::new(), Room::new(), Room::new());
    let sender = id16();
    s.post_many(&single, &sender, 1).await;
    s.post_many(&busy, &sender, 2).await;
    s.post_many(&idle, &sender, 3).await;
    s.post_many(&fresh, &sender, 1).await;
    let res = s
        .signed(&single, Method::PUT, &single.path(&format!("/blobs/{}", id16())), vec![1u8; 10])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);

    let eight_days_ago = now_ms() - 8 * 86_400_000;
    let long_ago = now_ms() - 91 * 86_400_000;
    for r in [&single, &busy] {
        s.sql(&format!("UPDATE rooms SET created_at = {eight_days_ago} WHERE id = '{}'", r.id)).await;
    }
    s.sql(&format!("UPDATE rooms SET created_at = {long_ago}, last_event_at = {long_ago} WHERE id = '{}'", idle.id))
        .await;

    let report = gc::run_once(&s.state).await.unwrap();
    assert_eq!(report.near_empty_purged, 1, "{report:?}");
    assert_eq!(report.inactive_purged, 1, "{report:?}");
    assert_eq!(s.room_info(&single).await["exists"], false);
    assert_eq!(s.room_info(&idle).await["exists"], false);
    assert_eq!(s.room_info(&busy).await["exists"], true);
    assert_eq!(s.room_info(&fresh).await["exists"], true);
    assert_eq!(s.count("SELECT COUNT(*) FROM blobs").await, 0);
    assert!(gc::run_once(&s.state).await.unwrap().is_empty());
}

#[tokio::test]
async fn empty_room_age_is_configurable() {
    let s = TestServer::with(|c| c.retention.empty_room_after = Duration::from_millis(200)).await;
    let room = Room::new();
    s.post_many(&room, &id16(), 1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(gc::run_once(&s.state).await.unwrap().near_empty_purged, 1);
    assert_eq!(s.room_info(&room).await["exists"], false);
}

#[tokio::test]
async fn room_writes_are_rate_limited() {
    let s = TestServer::with(|c| c.limits.writes_per_minute = 3).await;
    let room = Room::new();
    let sender = id16();
    s.post_many(&room, &sender, 3).await;
    let res = s
        .signed(
            &room,
            Method::POST,
            &room.path("/events"),
            serde_json::to_vec(&json!({"cid": id16(), "sender": sender, "data": data(8)})).unwrap(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry: u64 = res.headers()["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=20).contains(&retry), "retry-after {retry}");
    let (_, body) = json_of(res).await;
    assert_eq!(body["error"], "rate_limited");
    // Reads and other rooms are unaffected.
    assert_eq!(s.get(&room, &room.path("/events")).await.0, StatusCode::OK);
    assert_eq!(s.post_event(&Room::new(), &id16(), &sender, &data(8)).await.0, StatusCode::CREATED);
}

#[tokio::test]
async fn requests_per_ip_are_rate_limited() {
    let s = TestServer::with(|c| c.limits.requests_per_minute = 5).await;
    let room = Room::new();
    for _ in 0..5 {
        assert_eq!(s.get(&room, &room.path("/events")).await.0, StatusCode::OK);
    }
    let res = s.signed(&room, Method::GET, &room.path("/events"), Vec::new()).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(res.headers().contains_key("retry-after"));
    // Static pages are not API requests.
    assert_eq!(s.http.get(s.url("/healthz")).send().await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn new_rooms_are_limited_per_client_ip() {
    let s = TestServer::with(|c| {
        c.limits.new_rooms_per_hour = 2;
        c.trust_proxy_hops = 1;
    })
    .await;
    let post = |room: &Room, ip: &str| {
        let body = serde_json::to_vec(&json!({"cid": id16(), "sender": id16(), "data": data(8)})).unwrap();
        s.signed(room, Method::POST, &room.path("/events"), body)
            .header("X-Forwarded-For", format!("203.0.113.9, {ip}"))
            .send()
    };
    let rooms: Vec<Room> = (0..3).map(|_| Room::new()).collect();
    assert_eq!(post(&rooms[0], "198.51.100.1").await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(post(&rooms[1], "198.51.100.1").await.unwrap().status(), StatusCode::CREATED);
    let res = post(&rooms[2], "198.51.100.1").await.unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(res.headers().contains_key("retry-after"));
    // Writing to existing rooms is fine; another client may create rooms.
    assert_eq!(post(&rooms[0], "198.51.100.1").await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(post(&rooms[2], "198.51.100.2").await.unwrap().status(), StatusCode::CREATED);
}

#[tokio::test]
async fn info_reports_version_and_limits() {
    let s = TestServer::with(|c| c.limits.max_senders = 7).await;
    let res = s.http.get(s.url("/api/v1/info")).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (_, info) = json_of(res).await;
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(info["cli_command"], format!("npx -y @agents-secure-chat/cli@{}", env!("CARGO_PKG_VERSION")));
    let limits = &info["limits"];
    assert_eq!(limits["max_senders"], 7);
    assert_eq!(limits["max_event_bytes"], 131_072);
    assert_eq!(limits["max_blob_bytes"], 12 * 1024 * 1024);
    assert_eq!(limits["room_quota_bytes"], 200 * 1024 * 1024);
    assert_eq!(limits["delete_grace_secs"], 86_400);
    assert_eq!(limits["inactive_days"], 90.0);
    assert!(limits.as_object().unwrap().values().all(|v| v.is_number()), "{limits}");

    let res = s.http.get(s.url("/healthz")).send().await.unwrap();
    assert_eq!(res.text().await.unwrap(), "ok");
    let res = s.http.get(s.url("/api/v1/nope")).send().await.unwrap();
    let (status, body) = json_of(res).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "not_found");
}

#[tokio::test]
async fn cors_allows_cross_origin_api_calls() {
    let s = TestServer::start().await;
    let room = Room::new();
    let res = s
        .http
        .request(Method::OPTIONS, s.url(&room.path("/events")))
        .header("Origin", "http://localhost:5173")
        .header("Access-Control-Request-Method", "POST")
        .header("Access-Control-Request-Headers", "content-type,x-lincor-pub,x-lincor-ts,x-lincor-nonce,x-lincor-sig")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    assert_eq!(res.headers()["access-control-allow-origin"], "*");
    let allowed = res.headers()["access-control-allow-headers"].to_str().unwrap().to_ascii_lowercase();
    assert!(allowed.contains("x-lincor-sig"), "{allowed}");
    let res = s
        .signed(&room, Method::GET, &room.path("/events"), Vec::new())
        .header("Origin", "http://localhost:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["access-control-allow-origin"], "*");
}
