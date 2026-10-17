//! `GET /rooms/:room/stream` WebSocket (PROTOCOL §6.4).

use std::time::Duration;

use axum::{
    extract::{
        OriginalUri, Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, Method},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, MissedTickBehavior, interval_at};

use super::{check_sender, live_room};
use crate::{
    auth,
    db::Event,
    error::{ApiError, ApiResult},
    presence::{self, Entry},
    state::AppState,
    util::now_ms,
};

const BATCH: i64 = 500;
const PING_INTERVAL: Duration = Duration::from_secs(30);
const MAX_CLIENT_FRAME: usize = 16 * 1024;

#[derive(Deserialize)]
pub struct StreamQuery {
    token: Option<String>,
    after: Option<i64>,
    sender: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Frame<'a> {
    Event { event: &'a Event },
    Presence { presence: &'a [Entry] },
    Deleted { purge_at: i64 },
    Ready,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientFrame {
    Presence { state: String },
}

pub async fn stream(
    State(state): State<AppState>,
    Path(room): Path<String>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> ApiResult<Response> {
    let Query(q) = Query::<StreamQuery>::try_from_uri(&uri).map_err(|e| ApiError::bad_request(e.body_text()))?;
    auth::authenticate_bodiless(&state, &room, &method, &uri, &headers, q.token.as_deref())?;
    let after = q.after.unwrap_or(0);
    if after < 0 {
        return Err(ApiError::bad_request("`after` must be a non-negative seq"));
    }
    if let Some(sender) = &q.sender {
        check_sender(sender)?;
    }
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return Ok(rejection.into_response()),
    };
    Ok(ws.max_message_size(MAX_CLIENT_FRAME).on_upgrade(move |socket| run(state, room, after, q.sender, socket)))
}

type Sink = SplitSink<WebSocket, Message>;

async fn send(sink: &mut Sink, frame: &Frame<'_>) -> anyhow::Result<()> {
    let text = serde_json::to_string(frame)?;
    sink.send(Message::Text(text.into())).await?;
    Ok(())
}

/// What the stream knows it has already delivered.
struct Cursor {
    after: i64,
    presence: Option<Vec<Entry>>,
}

enum Flow {
    Continue,
    Deleted,
}

/// Sends whatever changed since the last sync: deletion, presence, new events.
async fn sync(state: &AppState, room: &str, cur: &mut Cursor, sink: &mut Sink) -> anyhow::Result<Flow> {
    let now = now_ms();
    let row = live_room(state, room, now).await?;
    if let Some(r) = &row
        && r.is_deleted()
    {
        send(sink, &Frame::Deleted { purge_at: r.purge_at.unwrap_or(now) }).await?;
        return Ok(Flow::Deleted);
    }

    let entries = match &row {
        Some(_) => presence::list(state, room).await?,
        None => Vec::new(),
    };
    // `last_seen` alone moving is not a presence change worth a frame.
    let changed = cur.presence.as_ref().is_none_or(|prev| {
        prev.len() != entries.len()
            || prev.iter().zip(&entries).any(|(a, b)| a.sender != b.sender || a.state != b.state)
    });
    if changed {
        send(sink, &Frame::Presence { presence: &entries }).await?;
        cur.presence = Some(entries);
    }

    if row.is_some_and(|r| r.last_seq > cur.after) {
        loop {
            let events = state.db.events_after(room, cur.after, BATCH).await?;
            for event in &events {
                send(sink, &Frame::Event { event }).await?;
                cur.after = event.seq;
            }
            if (events.len() as i64) < BATCH {
                break;
            }
        }
    }
    Ok(Flow::Continue)
}

async fn run(state: AppState, room: String, after: i64, sender: Option<String>, socket: WebSocket) {
    let (mut sink, mut incoming) = socket.split();
    let mut changes = state.hub.subscribe(&room);
    let mut listening = match &sender {
        Some(s) => Some(presence::listen(&state, &room, s).await),
        None => None,
    };
    let period = state.config.poll_interval;
    let mut poll = interval_at(Instant::now() + period, period);
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ping = interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut cur = Cursor { after, presence: None };
    let mut ready = false;

    loop {
        changes.borrow_and_update();
        match sync(&state, &room, &mut cur, &mut sink).await {
            Ok(Flow::Continue) => {}
            Ok(Flow::Deleted) => break,
            Err(e) => {
                tracing::debug!(error = %e, "stream ended");
                break;
            }
        }
        if !ready {
            if send(&mut sink, &Frame::Ready).await.is_err() {
                break;
            }
            ready = true;
        }

        tokio::select! {
            changed = changes.changed() => {
                if changed.is_err() {
                    poll.tick().await;
                }
            }
            _ = poll.tick() => {}
            _ = ping.tick() => {
                if sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            msg = incoming.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if let (Some(sender), Ok(ClientFrame::Presence { state: reported })) =
                        (&sender, serde_json::from_str::<ClientFrame>(&text))
                        && let Some(reported) = presence::State::parse(&reported)
                    {
                        // A full room or a deletion surfaces through the next sync.
                        let _ = presence::set(&state, &room, sender, reported).await;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            () = state.shutdown.cancelled() => break,
        }
        if let Some(guard) = listening.as_mut() {
            guard.refresh().await;
        }
    }
    drop(listening.take());
    let _ = sink.send(Message::Close(None)).await;
    let _ = sink.close().await;
}
