-- lincor schema. Portable SQL: the same migration runs on SQLite and Postgres.
-- Times are Unix milliseconds. The server stores no plaintext: `data` is an opaque base64url envelope.

CREATE TABLE rooms (
    id            TEXT PRIMARY KEY NOT NULL,  -- roomId = b64u(SHA256("lincor/v1/room" || auth_pub))
    auth_pub      TEXT NOT NULL,              -- cached; re-checked against id on every request
    created_at    BIGINT NOT NULL,
    last_seq      BIGINT NOT NULL DEFAULT 0,  -- per-room counter; also the row lock that orders writes
    last_event_at BIGINT NOT NULL,
    event_count   BIGINT NOT NULL DEFAULT 0,
    usage_bytes   BIGINT NOT NULL DEFAULT 0,  -- event data + blobs
    msg_ttl_days  BIGINT,
    deleted_at    BIGINT,
    purge_at      BIGINT
);

CREATE INDEX rooms_purge_at ON rooms (purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX rooms_last_event_at ON rooms (last_event_at);
CREATE INDEX rooms_created_at ON rooms (created_at);

CREATE TABLE events (
    room_id TEXT NOT NULL,
    seq     BIGINT NOT NULL,
    cid     TEXT NOT NULL,
    sender  TEXT NOT NULL,
    ts      BIGINT NOT NULL,
    data    TEXT NOT NULL,
    PRIMARY KEY (room_id, seq)
);

CREATE UNIQUE INDEX events_room_cid ON events (room_id, cid);
CREATE INDEX events_room_ts ON events (room_id, ts);

CREATE TABLE blobs (
    room_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    size       BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (room_id, id)
);

CREATE INDEX blobs_room_created ON blobs (room_id, created_at);

-- Participants as the server sees them: opaque ids with presence.
CREATE TABLE members (
    room_id      TEXT NOT NULL,
    sender       TEXT NOT NULL,
    joined_at    BIGINT NOT NULL,
    state        TEXT NOT NULL,   -- online | listening | offline (as last reported)
    last_seen    BIGINT NOT NULL,
    listen_until BIGINT,          -- lease while a wait/stream is open on some server instance
    PRIMARY KEY (room_id, sender)
);
