import { randomBytes, sha256, sign } from "./crypto.js";
import { b64u, hex, utf8 } from "./encoding.js";
import type { RoomKeys } from "./link.js";
import type { Envelope, StoredEnvelope } from "./events.js";

export type PresenceState = "online" | "listening" | "offline";

export interface PresenceEntry {
  sender: string;
  state: PresenceState;
  last_seen: number;
}

export interface RoomInfo {
  exists: boolean;
  created_at?: number;
  msg_ttl_days?: number | null;
  deleted_at?: number | null;
  purge_at?: number | null;
  usage_bytes: number;
  event_count: number;
}

export interface EventsPage {
  events: StoredEnvelope[];
  deleted?: { purge_at: number };
}

export interface ServerInfo {
  version: string;
  cli_command: string;
  /** Where the source code lives, when the server is configured with one. */
  source_url?: string;
  limits: Record<string, number>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Builds the signed-request headers of PROTOCOL §6.1. Exposed for test vectors. */
export function signRequest(
  room: RoomKeys,
  method: string,
  target: string,
  body: Uint8Array,
  options: { ts?: number; nonce?: string } = {},
): { headers: Record<string, string>; message: Uint8Array } {
  const ts = String(options.ts ?? Date.now());
  const nonce = options.nonce ?? b64u(randomBytes(16));
  const message = utf8(["lincor/v1/req", method.toUpperCase(), target, hex(sha256(body)), ts, nonce].join("\n"));
  return {
    message,
    headers: {
      "X-Lincor-Pub": b64u(room.auth.pub),
      "X-Lincor-Ts": ts,
      "X-Lincor-Nonce": nonce,
      "X-Lincor-Sig": b64u(sign(room.auth, message)),
    },
  };
}

/** Thin, typed client for one room's HTTP API (PROTOCOL §6). */
export class RoomClient {
  readonly base: string;
  private readonly fetcher: FetchLike;

  constructor(
    readonly origin: string,
    readonly room: RoomKeys,
    fetcher?: FetchLike,
  ) {
    this.base = `/api/v1/rooms/${room.roomId}`;
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
  }

  private async request(
    method: string,
    path: string,
    options: { json?: unknown; bytes?: Uint8Array; signal?: AbortSignal; raw?: boolean } = {},
  ): Promise<Response> {
    const target = this.base + path;
    let body: Uint8Array = new Uint8Array();
    const headers: Record<string, string> = {};
    if (options.json !== undefined) {
      body = utf8(JSON.stringify(options.json));
      headers["Content-Type"] = "application/json";
    } else if (options.bytes) {
      body = options.bytes;
      headers["Content-Type"] = "application/octet-stream";
    }
    Object.assign(headers, signRequest(this.room, method, target, body).headers);
    const response = await this.fetcher(this.origin + target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : (body as BodyInit),
      signal: options.signal,
    });
    if (!response.ok) {
      let code = "http_" + response.status;
      let message = `${method} ${path || "/"} failed with HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string; message?: string };
        if (payload.error) code = payload.error;
        if (payload.message) message = payload.message;
      } catch {
        // non-JSON error body
      }
      const retry = Number(response.headers.get("Retry-After"));
      throw new ApiError(response.status, code, message, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return response;
  }

  private async json<T>(method: string, path: string, options?: Parameters<RoomClient["request"]>[2]): Promise<T> {
    const response = await this.request(method, path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  info(): Promise<RoomInfo> {
    return this.json("GET", "");
  }

  events(after = 0, limit = 500): Promise<EventsPage> {
    return this.json("GET", `/events?after=${after}&limit=${limit}`);
  }

  post(envelope: Envelope): Promise<{ seq: number; ts: number; created: boolean }> {
    return this.json("POST", "/events", { json: envelope });
  }

  wait(after: number, timeoutSec: number, sender?: string, signal?: AbortSignal): Promise<EventsPage> {
    const q = `after=${after}&timeout=${Math.max(1, Math.min(600, Math.round(timeoutSec)))}` + (sender ? `&sender=${sender}` : "");
    return this.json("GET", `/wait?${q}`, { signal });
  }

  setPresence(sender: string, state: PresenceState): Promise<void> {
    return this.json("POST", "/presence", { json: { sender, state } });
  }

  async presence(): Promise<PresenceEntry[]> {
    return (await this.json<{ presence: PresenceEntry[] }>("GET", "/presence")).presence;
  }

  putBlob(blobId: string, bytes: Uint8Array): Promise<{ size: number }> {
    return this.json("PUT", `/blobs/${blobId}`, { bytes });
  }

  async getBlob(blobId: string): Promise<Uint8Array> {
    const response = await this.request("GET", `/blobs/${blobId}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  remove(): Promise<{ deleted_at: number; purge_at: number }> {
    return this.json("DELETE", "");
  }

  restore(): Promise<Record<string, never>> {
    return this.json("POST", "/restore");
  }

  setTtl(days: number | null): Promise<{ msg_ttl_days: number | null }> {
    return this.json("PUT", "/ttl", { json: { msg_ttl_days: days } });
  }

  session(): Promise<{ token: string; expires_at: number }> {
    return this.json("POST", "/session");
  }

  streamUrl(token: string, after: number, sender?: string): string {
    const ws = this.origin.replace(/^http/, "ws");
    return `${ws}${this.base}/stream?token=${encodeURIComponent(token)}&after=${after}` + (sender ? `&sender=${sender}` : "");
  }
}

export async function serverInfo(origin: string, fetcher: FetchLike = (i, init) => fetch(i, init)): Promise<ServerInfo> {
  const response = await fetcher(`${origin}/api/v1/info`);
  if (!response.ok) throw new ApiError(response.status, "info", `server info failed with HTTP ${response.status}`);
  return (await response.json()) as ServerInfo;
}
