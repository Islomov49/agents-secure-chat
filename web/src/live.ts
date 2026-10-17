// Live updates for one room (PROTOCOL §6.4): a WebSocket stream when the server offers one, otherwise a
// long-poll loop. The socket is retried with backoff; polling covers the gaps and stops once the socket is ready.
import type { PresenceEntry, RoomEvent, RoomSession, StoredEnvelope } from "@lincor/core";
import { backoffDelay } from "./view";

export type LiveStatus = "connecting" | "live" | "offline";

export type EventSource = "ws" | "poll" | "sync";

export interface LiveHandlers {
  /** New events, with the path they arrived on. */
  onEvents(events: RoomEvent[], via: EventSource): void;
  onPresence(list: PresenceEntry[]): void;
  /** Connection status or the room's deleted flag changed. */
  onState(): void;
}

export interface LiveOptions {
  /** This browser's participant id once it has joined (undefined while only reading). */
  sender(): string | undefined;
  WebSocketImpl?: typeof WebSocket;
  pollTimeoutSec?: number;
  presenceEveryMs?: number;
}

type Frame =
  | { type: "event"; event: StoredEnvelope }
  | { type: "presence"; presence: PresenceEntry[] }
  | { type: "deleted"; purge_at: number }
  | { type: "ready" };

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export interface LiveStats {
  polls: number;
  pollErrors: number;
  sockets: number;
  socketFailures: number;
  lastError: string;
}

export class Live {
  status: LiveStatus = "connecting";
  /** Counters for debugging and tests. */
  readonly stats: LiveStats = { polls: 0, pollErrors: 0, sockets: 0, socketFailures: 0, lastError: "" };
  /** "socket" while the WebSocket stream is ready, "poll" while long-polling. */
  transport: "socket" | "poll" | "none" = "none";

  private stopped = false;
  private ws?: WebSocket;
  private wsReady = false;
  private wsAttempts = 0;
  private wsTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private pollAbort?: AbortController;
  private pollFailures = 0;
  private pollGen = 0;
  private presenceTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly session: RoomSession,
    private readonly handlers: LiveHandlers,
    private readonly options: LiveOptions,
  ) {}

  start(): void {
    this.stopped = false;
    void this.refreshPresence();
    this.presenceTimer = setInterval(() => {
      if (!this.wsReady) void this.refreshPresence();
    }, this.options.presenceEveryMs ?? 30_000);
    if (this.session.deleted) this.startPolling();
    else void this.connectSocket();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.wsTimer);
    clearInterval(this.presenceTimer);
    this.closeSocket();
    this.stopPolling();
  }

  /** Reconnects, e.g. after joining so the stream and polls carry this participant's id (presence). */
  restart(): void {
    if (this.stopped) return;
    clearTimeout(this.wsTimer);
    this.closeSocket();
    this.stopPolling();
    this.wsAttempts = 0;
    void this.connectSocket();
  }

  /** Wakes a sleeping poll loop and reopens the stream (after a restore, for example). */
  kick(): void {
    this.pollAbort?.abort();
    this.resumeSocket();
  }

  /** Reconnects the stream right away unless one is open or the room is deleted. */
  private resumeSocket() {
    if (this.stopped || this.ws || this.wsReady || this.session.deleted) return;
    clearTimeout(this.wsTimer);
    this.wsAttempts = 0;
    void this.connectSocket();
  }

  async refreshPresence(): Promise<void> {
    try {
      this.handlers.onPresence(await this.session.client.presence());
    } catch {
      // presence is best effort
    }
  }

  private setStatus(status: LiveStatus) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onState();
  }

  private closeSocket() {
    const ws = this.ws;
    this.ws = undefined;
    this.wsReady = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  private async connectSocket(): Promise<void> {
    if (this.stopped) return;
    const Impl = this.options.WebSocketImpl ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
    if (!Impl) return this.startPolling();
    let url: string;
    try {
      const { token } = await this.session.client.session();
      url = this.session.client.streamUrl(token, this.session.state.lastSeq, this.options.sender());
    } catch {
      return this.socketFailed();
    }
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new Impl(url);
    } catch {
      return this.socketFailed();
    }
    this.ws = ws;
    this.stats.sockets++;
    // If the socket neither becomes ready nor fails quickly, keep the room live by polling meanwhile.
    const slow = setTimeout(() => {
      if (this.ws === ws && !this.wsReady) this.startPolling();
    }, 4000);
    ws.onmessage = (message) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(message.data)) as Frame;
      } catch {
        return;
      }
      this.onFrame(frame);
    };
    ws.onclose = () => {
      clearTimeout(slow);
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.wsReady = false;
      this.socketFailed();
    };
    ws.onerror = () => {
      // a close event follows
    };
  }

  private onFrame(frame: Frame) {
    switch (frame.type) {
      case "event": {
        if (frame.event.seq > this.session.state.lastSeq + 1) {
          // A gap: fetch everything after our cursor instead of skipping events.
          void this.session.sync().then((fresh) => fresh.length && this.handlers.onEvents(fresh, "ws"), () => undefined);
          return;
        }
        const fresh = this.session.ingest([frame.event]);
        if (fresh.length) this.handlers.onEvents(fresh, "ws");
        return;
      }
      case "presence":
        this.handlers.onPresence(frame.presence ?? []);
        return;
      case "deleted":
        // The server ends the stream for a deleted room and there is no "restored" frame, so close it here too and
        // let the poll loop check for a restore; the stream is reopened once the room is back.
        this.session.deleted = { purge_at: frame.purge_at };
        clearTimeout(this.wsTimer);
        this.closeSocket();
        this.transport = "none";
        this.startPolling();
        this.handlers.onState();
        return;
      case "ready":
        this.wsReady = true;
        this.wsAttempts = 0;
        this.transport = "socket";
        this.stopPolling();
        this.setStatus("live");
        this.handlers.onState();
        return;
    }
  }

  private socketFailed() {
    if (this.stopped) return;
    this.stats.socketFailures++;
    this.startPolling();
    clearTimeout(this.wsTimer);
    if (this.session.deleted) return; // reopened by resumeSocket() after a restore
    this.wsTimer = setTimeout(() => void this.connectSocket(), backoffDelay(this.wsAttempts++, 3000, 60_000));
  }

  private stopPolling() {
    this.polling = false;
    this.pollGen++;
    this.pollAbort?.abort();
  }

  private async pollOnce(signal: AbortSignal): Promise<RoomEvent[]> {
    const timeout = this.options.pollTimeoutSec ?? 25;
    if (this.options.sender()) return this.session.waitForEvents(timeout, signal);
    // Readers who have not joined poll without a sender id, so they do not appear in presence.
    const page = await this.session.client.wait(this.session.state.lastSeq, timeout, undefined, signal);
    this.session.deleted = page.deleted;
    return this.session.ingest(page.events);
  }

  private startPolling(): void {
    if (this.polling || this.stopped || this.wsReady) return;
    this.polling = true;
    this.transport = "poll";
    void this.pollLoop(++this.pollGen);
  }

  private async pollLoop(gen: number): Promise<void> {
    const alive = () => this.polling && !this.stopped && gen === this.pollGen;
    while (alive()) {
      const controller = new AbortController();
      this.pollAbort = controller;
      const started = Date.now();
      try {
        if (this.session.deleted) {
          // A deleted room answers at once; check slowly whether someone restored it.
          await sleep(15_000, controller.signal);
          if (!alive()) break;
          const fresh = await this.session.sync();
          this.pollFailures = 0;
          this.setStatus("live");
          this.handlers.onState();
          if (fresh.length) this.handlers.onEvents(fresh, "sync");
          if (!this.session.deleted) this.resumeSocket();
          continue;
        }
        const wasDeleted = !!this.session.deleted;
        this.stats.polls++;
        const fresh = await this.pollOnce(controller.signal);
        if (fresh.length) this.handlers.onEvents(fresh, "poll");
        if (!alive()) break;
        this.pollFailures = 0;
        this.setStatus("live");
        if (wasDeleted !== !!this.session.deleted) this.handlers.onState();
        // Guard against servers that answer a long-poll early without events.
        if (!fresh.length && Date.now() - started < 1000) await sleep(1000, controller.signal);
      } catch (e) {
        if (!alive()) break;
        if (controller.signal.aborted) continue;
        this.stats.pollErrors++;
        this.stats.lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        this.setStatus("offline");
        await sleep(backoffDelay(this.pollFailures++, 1000, 30_000), controller.signal);
      }
    }
    if (gen === this.pollGen && this.transport === "poll" && !this.polling) this.transport = this.wsReady ? "socket" : "none";
  }
}
