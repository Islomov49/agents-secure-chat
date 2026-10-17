// In-memory implementation of the lincor HTTP API (PROTOCOL §6) for client tests and web development.
// The production server is the Rust crate in /server; end-to-end tests run against that one.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { b64u, fromB64u, hex, isB64u, roomIdForAuthPub, sha256, utf8, verify, type StoredEnvelope } from "../src/index.js";

interface MockRoom {
  events: StoredEnvelope[];
  blobs: Map<string, Uint8Array>;
  createdAt: number;
  deleted?: { deleted_at: number; purge_at: number };
  ttl: number | null;
  presence: Map<string, { state: string; last_seen: number }>;
  waiters: Set<() => void>;
}

export interface MockServer {
  url: string;
  rooms: Map<string, MockRoom>;
  /** Every raw request body the server received, to assert that no plaintext ever reaches it. */
  received: Uint8Array[];
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};
const fail = (res: ServerResponse, status: number, error: string, message = error) => json(res, status, { error, message });

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

export interface MockServerOptions {
  /**
   * Optional directory with the built web app (web/dist). When set, `GET /` and browser requests for `GET /r`
   * (Accept: text/html) get `index.html`, and other files in the directory are served by name. Without it the
   * server behaves exactly as before (no static files, `/r` is always markdown).
   */
  staticDir?: string;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Serves a file from `dir` for a URL path; returns false when there is no such file (never leaves `dir`). */
async function serveStatic(res: ServerResponse, dir: string, pathname: string): Promise<boolean> {
  const root = resolve(dir);
  let file: string;
  try {
    file = resolve(join(root, decodeURIComponent(pathname)));
  } catch {
    return false;
  }
  if (file !== root && !file.startsWith(root + sep)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": STATIC_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export async function startMockServer(port = 0, options: MockServerOptions = {}): Promise<MockServer> {
  const rooms = new Map<string, MockRoom>();
  const received: Uint8Array[] = [];
  const tokens = new Map<string, string>();
  const nonces = new Set<string>();

  const authorized = (req: IncomingMessage, roomId: string, target: string, body: Uint8Array): boolean => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "") ?? new URL(target, "http://x").searchParams.get("token");
    if (bearer && tokens.get(bearer) === roomId) return true;
    const pub = req.headers["x-lincor-pub"] as string | undefined;
    const ts = req.headers["x-lincor-ts"] as string | undefined;
    const nonce = req.headers["x-lincor-nonce"] as string | undefined;
    const sig = req.headers["x-lincor-sig"] as string | undefined;
    if (!pub || !ts || !nonce || !sig || !isB64u(pub, 32)) return false;
    if (roomIdForAuthPub(fromB64u(pub)) !== roomId) return false;
    if (Math.abs(Date.now() - Number(ts)) > 300_000) return false;
    if (nonces.has(roomId + nonce)) return false;
    const message = utf8(["lincor/v1/req", req.method ?? "", target, hex(sha256(body)), ts, nonce].join("\n"));
    if (!verify(fromB64u(pub), message, fromB64u(sig))) return false;
    nonces.add(roomId + nonce);
    return true;
  };

  const room = (id: string, create: boolean): MockRoom | undefined => {
    let r = rooms.get(id);
    if (!r && create) {
      r = { events: [], blobs: new Map(), createdAt: Date.now(), ttl: null, presence: new Map(), waiters: new Set() };
      rooms.set(id, r);
    }
    return r;
  };

  const seen = (r: MockRoom | undefined, sender: string | null | undefined, state = "online") => {
    if (r && sender) r.presence.set(sender, { state, last_seen: Date.now() });
  };

  const presenceList = (r: MockRoom) =>
    [...r.presence].map(([sender, p]) => ({
      sender,
      state: p.state === "offline" || Date.now() - p.last_seen > 90_000 ? "offline" : p.state,
      last_seen: p.last_seen,
    }));

  const page = (r: MockRoom | undefined, after: number, limit: number) => {
    if (!r) return { events: [] };
    if (r.deleted) return { events: [], deleted: { purge_at: r.deleted.purge_at } };
    return { events: r.events.filter((e) => e.seq > after).slice(0, limit) };
  };

  const server: Server = createServer(async (req, res) => {
    const target = req.url ?? "/";
    const url = new URL(target, "http://mock");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      return res.end();
    }
    if (url.pathname === "/api/v1/info") {
      return json(res, 200, { version: "mock", cli_command: "npx -y agents-room@0.0.0-mock", limits: { max_event_bytes: 131072, max_blob_bytes: 12582912 } });
    }
    if (options.staticDir && req.method === "GET") {
      const wantsHtml = /text\/html/.test(req.headers.accept ?? "");
      if (url.pathname === "/" || (url.pathname === "/r" && wantsHtml)) {
        if (await serveStatic(res, options.staticDir, "/index.html")) return;
      } else if (!url.pathname.startsWith("/api/") && url.pathname !== "/r" && url.pathname !== "/llms.txt") {
        if (await serveStatic(res, options.staticDir, url.pathname)) return;
      }
    }
    if (url.pathname === "/r" || url.pathname === "/llms.txt") {
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      return res.end("# Agents secure chat: room link\n\nRun: npx -y agents-room@0.0.0-mock join '<the full link>'\n");
    }
    const m = url.pathname.match(/^\/api\/v1\/rooms\/([A-Za-z0-9_-]{43})(\/[a-z]+)?(?:\/([A-Za-z0-9_-]{22}))?$/);
    if (!m) return fail(res, 404, "not_found");
    const [, roomId, sub = "", blobId] = m;
    const body = await readBody(req);
    received.push(body);
    if (!authorized(req, roomId, target, body)) return fail(res, 401, "auth", "request signature or token is invalid");

    const method = req.method ?? "GET";
    const r = room(roomId, false);
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 500));

    if (sub === "" && method === "GET") {
      return json(res, 200, r
        ? { exists: true, created_at: r.createdAt, msg_ttl_days: r.ttl, deleted_at: r.deleted?.deleted_at ?? null, purge_at: r.deleted?.purge_at ?? null, usage_bytes: 0, event_count: r.events.length }
        : { exists: false, usage_bytes: 0, event_count: 0 });
    }
    if (sub === "" && method === "DELETE") {
      if (!r) return fail(res, 404, "not_found");
      r.deleted = { deleted_at: Date.now(), purge_at: Date.now() + 86_400_000 };
      r.waiters.forEach((w) => w());
      return json(res, 200, r.deleted);
    }
    if (sub === "/restore" && method === "POST") {
      if (r) delete r.deleted;
      return json(res, 200, {});
    }
    if (sub === "/ttl" && method === "PUT") {
      const days = JSON.parse(Buffer.from(body).toString()).msg_ttl_days ?? null;
      room(roomId, true)!.ttl = days;
      return json(res, 200, { msg_ttl_days: days });
    }
    if (sub === "/session" && method === "POST") {
      const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
      tokens.set(token, roomId);
      return json(res, 200, { token, expires_at: Date.now() + 3_600_000 });
    }
    if (sub === "/events" && method === "GET") return json(res, 200, page(r, after, limit));
    if (sub === "/events" && method === "POST") {
      if (r?.deleted) return fail(res, 410, "room_deleted");
      const env = JSON.parse(Buffer.from(body).toString()) as { cid: string; sender: string; data: string };
      if (!isB64u(env.cid, 16) || !isB64u(env.sender, 16) || typeof env.data !== "string") return fail(res, 400, "bad_request");
      const target = room(roomId, true)!;
      const existing = target.events.find((e) => e.cid === env.cid);
      if (existing) return json(res, 200, { seq: existing.seq, ts: existing.ts, created: false });
      const stored = { ...env, seq: target.events.length + 1, ts: Date.now() };
      const created = target.events.length === 0;
      target.events.push(stored);
      seen(target, env.sender);
      target.waiters.forEach((w) => w());
      return json(res, 201, { seq: stored.seq, ts: stored.ts, created });
    }
    if (sub === "/wait" && method === "GET") {
      const sender = url.searchParams.get("sender");
      const timeout = Math.min(600, Math.max(1, Number(url.searchParams.get("timeout") ?? 30))) * 1000;
      const ready = () => page(rooms.get(roomId), after, limit);
      let current = ready();
      if (current.events.length || current.deleted) return json(res, 200, current);
      const target = room(roomId, true)!;
      seen(target, sender, "listening");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeout);
        function done() {
          clearTimeout(timer);
          target.waiters.delete(done);
          resolve();
        }
        target.waiters.add(done);
        req.on("close", done);
      });
      seen(target, sender, "online");
      current = ready();
      return json(res, 200, current);
    }
    if (sub === "/presence" && method === "POST") {
      const p = JSON.parse(Buffer.from(body).toString());
      seen(room(roomId, true), p.sender, p.state);
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      return res.end();
    }
    if (sub === "/presence" && method === "GET") return json(res, 200, { presence: r ? presenceList(r) : [] });
    if (sub === "/blobs" && blobId && method === "PUT") {
      if (r?.deleted) return fail(res, 410, "room_deleted");
      room(roomId, true)!.blobs.set(blobId, body);
      return json(res, 201, { size: body.length });
    }
    if (sub === "/blobs" && blobId && method === "GET") {
      const blob = r?.blobs.get(blobId);
      if (!blob) return fail(res, 404, "not_found");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      return res.end(blob);
    }
    return fail(res, 404, "not_found");
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    rooms,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const r of rooms.values()) r.waiters.forEach((w) => w());
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8787;
  const staticAt = process.argv.indexOf("--static");
  const staticDir = staticAt > 0 ? process.argv[staticAt + 1] : undefined;
  startMockServer(port, { staticDir }).then((s) => console.log(`mock lincor server on ${s.url}`));
}
