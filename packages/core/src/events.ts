import { open, randomBytes, seal, sign, verify } from "./crypto.js";
import { b64u, concat, fromB64u, fromUtf8, isB64u, joinZero, utf8 } from "./encoding.js";
import { participantIdFor, type Identity } from "./identity.js";
import type { RoomKeys } from "./link.js";

export type ClientKind = "claude-code" | "codex" | "browser" | "cli" | "other";

export interface Profile {
  name: string;
  role: string;
  owner?: string;
  project?: string;
  repo?: string;
  stack?: string;
  client: ClientKind;
  kind: "agent" | "human";
  status?: string;
}

export type TaskStatus = "open" | "accepted" | "in_progress" | "done" | "rejected" | "blocked";
export const TASK_STATUSES: readonly TaskStatus[] = ["open", "accepted", "in_progress", "done", "rejected", "blocked"];

export interface FileBody {
  blob: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  key: string;
  np: string;
  cs: number;
  text?: string;
  reply_to?: string;
  mentions?: string[];
}

export interface EventBodies {
  join: { profile: Profile };
  profile: { profile: Profile };
  status: { text: string };
  leave: Record<string, never>;
  message: { text: string; reply_to?: string; mentions?: string[] };
  "task.create": { title: string; description?: string; assignee?: string; acceptance?: string[]; refs?: string[] };
  "task.update": { task: string; status: TaskStatus; note?: string };
  file: FileBody;
  "artifact.put": { name: string; content?: string; file?: FileBody; note?: string };
  "room.meta": { name?: string; description?: string };
  "room.ttl": { days: number | null };
}

export type EventType = keyof EventBodies;

/** What the server stores and returns. */
export interface Envelope {
  cid: string;
  sender: string;
  data: string;
}

export interface StoredEnvelope extends Envelope {
  seq: number;
  ts: number;
}

/** A decrypted, verified event. `body` is typed by `type` for known types. */
export type RoomEvent = {
  [T in EventType]: {
    seq: number;
    ts: number;
    cid: string;
    sender: string;
    pub: string;
    clientTs: number;
    type: T;
    body: EventBodies[T];
  };
}[EventType];

export type EventOf<T extends EventType> = Extract<RoomEvent, { type: T }>;

export const newCid = (): string => b64u(randomBytes(16));

const sigMessage = (roomId: string, cid: string, payload: string) =>
  joinZero(utf8("lincor/v1/sig"), utf8(roomId), utf8(cid), utf8(payload));

const eventAad = (roomId: string, cid: string, sender: string) =>
  joinZero(utf8("lincor/v1/event"), utf8(roomId), utf8(cid), utf8(sender));

export interface SealOptions {
  cid?: string;
  ts?: number;
  /** Only for deterministic test vectors. */
  nonce?: Uint8Array;
}

export function sealEvent<T extends EventType>(
  room: RoomKeys,
  identity: Identity,
  type: T,
  body: EventBodies[T],
  options: SealOptions = {},
): Envelope {
  const cid = options.cid ?? newCid();
  const payload = JSON.stringify({ v: 1, type, ts: options.ts ?? Date.now(), body });
  const signature = sign(identity, sigMessage(room.roomId, cid, payload));
  const plaintext = utf8(JSON.stringify({ p: payload, pub: b64u(identity.pub), sig: b64u(signature) }));
  const nonce = options.nonce ?? randomBytes(24);
  const ciphertext = seal(room.kEnc, nonce, plaintext, eventAad(room.roomId, cid, identity.id));
  return { cid, sender: identity.id, data: b64u(concat(nonce, ciphertext)) };
}

export type OpenFailure = "envelope" | "decrypt" | "format" | "sender" | "signature" | "version";

export type OpenResult = { ok: true; event: RoomEvent } | { ok: false; reason: OpenFailure };

export function openEvent(room: RoomKeys, envelope: StoredEnvelope): OpenResult {
  if (!isB64u(envelope.cid, 16) || !isB64u(envelope.sender, 16) || typeof envelope.data !== "string") {
    return { ok: false, reason: "envelope" };
  }
  let raw: Uint8Array;
  try {
    raw = fromB64u(envelope.data);
  } catch {
    return { ok: false, reason: "envelope" };
  }
  if (raw.length < 24 + 16) return { ok: false, reason: "envelope" };
  const plaintext = open(room.kEnc, raw.subarray(0, 24), raw.subarray(24), eventAad(room.roomId, envelope.cid, envelope.sender));
  if (!plaintext) return { ok: false, reason: "decrypt" };

  let outer: { p?: unknown; pub?: unknown; sig?: unknown };
  let pub: Uint8Array;
  let signature: Uint8Array;
  try {
    outer = JSON.parse(fromUtf8(plaintext));
    if (typeof outer.p !== "string" || typeof outer.pub !== "string" || typeof outer.sig !== "string") {
      return { ok: false, reason: "format" };
    }
    pub = fromB64u(outer.pub);
    signature = fromB64u(outer.sig);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (pub.length !== 32 || participantIdFor(pub) !== envelope.sender) return { ok: false, reason: "sender" };
  if (!verify(pub, sigMessage(room.roomId, envelope.cid, outer.p), signature)) return { ok: false, reason: "signature" };

  let inner: { v?: unknown; type?: unknown; ts?: unknown; body?: unknown };
  try {
    inner = JSON.parse(outer.p);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (inner.v !== 1) return { ok: false, reason: "version" };
  if (typeof inner.type !== "string" || typeof inner.body !== "object" || inner.body === null) {
    return { ok: false, reason: "format" };
  }
  return {
    ok: true,
    event: {
      seq: envelope.seq,
      ts: envelope.ts,
      cid: envelope.cid,
      sender: envelope.sender,
      pub: outer.pub,
      clientTs: typeof inner.ts === "number" ? inner.ts : envelope.ts,
      type: inner.type,
      body: inner.body,
    } as RoomEvent,
  };
}
