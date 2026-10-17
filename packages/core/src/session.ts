import { RoomClient, type FetchLike } from "./client.js";
import { fromUtf8, utf8 } from "./encoding.js";
import { openEvent, sealEvent, type EventBodies, type EventType, type FileBody, type Profile, type RoomEvent, type StoredEnvelope, type TaskStatus } from "./events.js";
import { decryptFile, encryptFile, newBlobId } from "./files.js";
import { RoomState } from "./fold.js";
import { matchesId, type Identity } from "./identity.js";
import { deriveRoom, encodeKey, linkFor, type RoomKeys } from "./link.js";
import { extractMentions } from "./mentions.js";

export const MAX_MESSAGE_CHARS = 32 * 1024;
export const MAX_INLINE_ARTIFACT_BYTES = 48 * 1024;

/**
 * One participant's view of one room: keys, identity, API client and folded state.
 * Shared by the CLI, the MCP server and the web app.
 */
export class RoomSession {
  readonly keys: RoomKeys;
  readonly client: RoomClient;
  readonly state = new RoomState();
  /** Events that failed decryption or verification (never applied). */
  rejected = 0;
  /** Called with every batch of new envelopes (e.g. to cache them, still encrypted, on disk). */
  onEnvelopes?: (envelopes: StoredEnvelope[]) => void;
  deleted?: { purge_at: number };

  constructor(
    readonly origin: string,
    secret: Uint8Array,
    readonly identity: Identity,
    fetcher?: FetchLike,
  ) {
    this.keys = deriveRoom(secret);
    this.client = new RoomClient(origin, this.keys, fetcher);
  }

  get roomId(): string {
    return this.keys.roomId;
  }

  get link(): string {
    return linkFor(this.origin, encodeKey(this.keys.secret));
  }

  get me() {
    return this.state.participants.get(this.identity.id);
  }

  get joined(): boolean {
    return !!this.me?.profile && !this.me.left;
  }

  /** Opens and applies envelopes in order; returns the newly applied events. */
  ingest(envelopes: StoredEnvelope[]): RoomEvent[] {
    const fresh: RoomEvent[] = [];
    const accepted: StoredEnvelope[] = [];
    for (const envelope of [...envelopes].sort((a, b) => a.seq - b.seq)) {
      if (envelope.seq <= this.state.lastSeq) continue;
      accepted.push(envelope);
      const result = openEvent(this.keys, envelope);
      if (!result.ok) {
        this.rejected++;
        this.state.lastSeq = envelope.seq;
        continue;
      }
      this.state.apply(result.event);
      fresh.push(result.event);
    }
    if (accepted.length) this.onEnvelopes?.(accepted);
    return fresh;
  }

  /** Fetches everything after the current cursor. */
  async sync(): Promise<RoomEvent[]> {
    const fresh: RoomEvent[] = [];
    for (;;) {
      const page = await this.client.events(this.state.lastSeq, 500);
      this.deleted = page.deleted;
      fresh.push(...this.ingest(page.events));
      if (page.events.length < 500) return fresh;
    }
  }

  /** Long-polls for new events (the server shows this participant as listening meanwhile). */
  async waitForEvents(timeoutSec: number, signal?: AbortSignal): Promise<RoomEvent[]> {
    const page = await this.client.wait(this.state.lastSeq, timeoutSec, this.identity.id, signal);
    this.deleted = page.deleted;
    return this.ingest(page.events);
  }

  addressedToMe(events: RoomEvent[]): RoomEvent[] {
    return events.filter((e) => this.state.isAddressedTo(e, this.identity.id));
  }

  async publish<T extends EventType>(type: T, body: EventBodies[T]): Promise<RoomEvent> {
    const envelope = sealEvent(this.keys, this.identity, type, body);
    await this.client.post(envelope);
    await this.sync();
    const event = this.state.event(envelope.cid);
    if (!event) throw new Error("the server accepted the event but it could not be read back");
    return event;
  }

  join(profile: Profile) {
    return this.publish("join", { profile });
  }

  setProfile(profile: Profile) {
    return this.publish("profile", { profile });
  }

  setStatus(text: string) {
    return this.publish("status", { text: text.slice(0, 200) });
  }

  leave() {
    return this.publish("leave", {});
  }

  say(text: string, options: { replyTo?: string } = {}) {
    if (!text.trim()) throw new Error("message is empty");
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`messages are limited to ${MAX_MESSAGE_CHARS} characters`);
    return this.publish("message", {
      text,
      ...(options.replyTo ? { reply_to: this.resolveCid(options.replyTo) } : {}),
      mentions: extractMentions(text),
    });
  }

  createTask(task: EventBodies["task.create"]) {
    if (!task.title.trim()) throw new Error("task title is empty");
    return this.publish("task.create", task);
  }

  updateTask(taskIdOrPrefix: string, status: TaskStatus, note?: string) {
    const task = this.state.findTask(taskIdOrPrefix);
    if (!task) throw new Error(`no task matches "${taskIdOrPrefix}"`);
    return this.publish("task.update", { task: task.id, status, ...(note ? { note } : {}) });
  }

  async uploadFile(bytes: Uint8Array, name: string, mime: string): Promise<FileBody> {
    const encrypted = encryptFile(bytes);
    const blob = newBlobId();
    await this.client.putBlob(blob, encrypted.blob);
    return { blob, name, mime, ...encrypted.meta };
  }

  async shareFile(bytes: Uint8Array, name: string, mime: string, options: { text?: string; replyTo?: string } = {}) {
    const file = await this.uploadFile(bytes, name, mime);
    const text = options.text ?? "";
    return this.publish("file", {
      ...file,
      ...(text ? { text, mentions: extractMentions(text) } : {}),
      ...(options.replyTo ? { reply_to: this.resolveCid(options.replyTo) } : {}),
    });
  }

  async downloadFile(file: FileBody): Promise<Uint8Array> {
    return decryptFile(await this.client.getBlob(file.blob), file);
  }

  async putArtifact(name: string, content: Uint8Array, options: { note?: string; mime?: string } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      throw new Error("artifact names use letters, digits, '.', '_' or '-' (max 64)");
    }
    let text: string | undefined;
    try {
      text = fromUtf8(content);
    } catch {
      text = undefined;
    }
    if (text !== undefined && content.length <= MAX_INLINE_ARTIFACT_BYTES) {
      return this.publish("artifact.put", { name, content: text, ...(options.note ? { note: options.note } : {}) });
    }
    const file = await this.uploadFile(content, name, options.mime ?? "application/octet-stream");
    return this.publish("artifact.put", { name, file, ...(options.note ? { note: options.note } : {}) });
  }

  async readArtifact(name: string, version?: number): Promise<{ version: number; content: Uint8Array }> {
    const artifact = this.state.artifacts.get(name);
    if (!artifact) throw new Error(`no artifact named "${name}"`);
    const v = version ? artifact.versions[version - 1] : artifact.versions.at(-1);
    if (!v) throw new Error(`artifact "${name}" has no version ${version}`);
    if (v.content !== undefined) return { version: v.version, content: utf8(v.content) };
    if (v.file) return { version: v.version, content: await this.downloadFile(v.file) };
    throw new Error(`artifact "${name}" version ${v.version} is empty`);
  }

  setMeta(meta: EventBodies["room.meta"]) {
    return this.publish("room.meta", meta);
  }

  async setTtl(days: number | null) {
    await this.client.setTtl(days);
    return this.publish("room.ttl", { days });
  }

  remove() {
    return this.client.remove();
  }

  restore() {
    return this.client.restore();
  }

  /** Accepts a full cid or a unique prefix of one. */
  resolveCid(idOrPrefix: string): string {
    if (this.state.event(idOrPrefix)) return idOrPrefix;
    const matches = this.state.events.filter((e) => matchesId(e.cid, idOrPrefix));
    if (matches.length !== 1) throw new Error(`no single event matches "${idOrPrefix}"`);
    return matches[0].cid;
  }
}
