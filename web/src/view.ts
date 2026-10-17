// Pure view-model helpers: no DOM, no network. Everything here is unit-tested (web/test/view.test.ts).
import { BROADCAST_HANDLES, shortId, slug, type ClientKind, type Profile, type RoomEvent, type RoomState, type TaskStatus } from "@lincor/core";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for use in HTML element content and quoted attribute values. */
export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/* ---------- Message text: a small, XSS-safe markdown subset with @mentions ---------- */

export interface TextOptions {
  /** Returns true for mention tokens (lowercase, without @) that address the viewer. */
  isMine?: (handle: string) => boolean;
}

// One alternation, scanned left to right over raw text. Only matched pieces become markup; everything else is escaped.
const INLINE =
  /(`[^`\n]+`)|(\*\*(?=\S)[^*\n]*?\S\*\*)|\[([^\]\n]{1,300})\]\((https?:\/\/[^\s()<>]+)\)|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])|(?<![A-Za-z0-9_.-])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;

function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const link = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;

function mention(token: string, options: TextOptions): string {
  const handle = token.replace(/[.]+$/, "");
  const trailing = token.slice(handle.length);
  const mine = options.isMine?.(handle.toLowerCase()) ?? false;
  return `<span class="mention${mine ? " mention--me" : ""}">@${escapeHtml(handle)}</span>${escapeHtml(trailing)}`;
}

function renderInline(text: string, options: TextOptions): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    out += escapeHtml(text.slice(last, at));
    last = at + m[0].length;
    if (m[1]) out += `<code>${escapeHtml(m[1].slice(1, -1))}</code>`;
    else if (m[2]) out += `<strong>${escapeHtml(m[2].slice(2, -2))}</strong>`;
    else if (m[3] !== undefined && m[4]) {
      const href = safeUrl(m[4]);
      out += href ? link(href, escapeHtml(m[3])) : escapeHtml(m[0]);
    } else if (m[5]) {
      const href = safeUrl(m[5]);
      out += href ? link(href, escapeHtml(m[5])) : escapeHtml(m[0]);
    } else if (m[6]) out += mention(m[6], options);
  }
  return out + escapeHtml(text.slice(last));
}

function renderBlocks(text: string, options: TextOptions): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.replace(/^\n+|\n+$/g, ""))
    .filter((para) => para.trim() !== "")
    .map((para) => `<p>${para.split("\n").map((line) => renderInline(line, options)).join("<br>")}</p>`)
    .join("");
}

/**
 * Renders message text (markdown subset: paragraphs, line breaks, fenced and inline code, **bold**, http(s) links)
 * with @mentions highlighted. All other characters are escaped, so the result is safe to assign to innerHTML.
 */
export function renderText(text: string, options: TextOptions = {}): string {
  // Split keeps the fence lines: [prose, fence, body, fence, body, ...]; fences alternate opening and closing.
  const seg = text.replace(/\r\n?/g, "\n").split(/^(```[^\n]*(?:\n|$))/m);
  let out = renderBlocks(seg[0], options);
  for (let i = 1, k = 1; i < seg.length; i += 2, k++) {
    const fence = seg[i];
    const body = seg[i + 1] ?? "";
    if (k % 2 === 0) out += renderBlocks(body, options);
    else if (i + 2 < seg.length) out += `<pre><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`;
    else out += renderBlocks(fence + body, options); // unterminated fence: plain text
  }
  return out;
}

/** The first line of a text, trimmed and shortened, for previews and announcements. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/* ---------- Composer ---------- */

export interface ComposedTask {
  title: string;
  description?: string;
  assignee?: string;
}

const HANDLE = /(?<![A-Za-z0-9_.-])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/;

/**
 * Task mode of the composer: the first line is the title, the rest is the description, and the first @handle
 * anywhere is the assignee (kept as "@handle"). The assignee mention is removed from the title.
 */
export function parseTaskInput(input: string): ComposedTask | null {
  const text = input.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  const [first, ...rest] = text.split("\n");
  const found = text.match(HANDLE);
  const handle = found ? found[1].replace(/[.]+$/, "") : undefined;
  let title = first.trim();
  if (handle) {
    const stripped = title
      .replace(new RegExp(`(^|\\s)@${handle.replace(/[.]/g, "\\.")}(?![A-Za-z0-9_-])`), "$1")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .replace(/^[\s,:;.-]+|[\s,:;.-]+$/g, "")
      .trim();
    if (stripped) title = stripped;
  }
  const description = rest.join("\n").trim();
  return {
    title,
    ...(description ? { description } : {}),
    ...(handle ? { assignee: "@" + handle } : {}),
  };
}

/* ---------- @mention suggestions ---------- */

/** The `@word` being typed at the caret: where its `@` is and what follows it so far. Null when not in a mention. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let i = caret;
  while (i > 0 && /[A-Za-z0-9_.-]/.test(text[i - 1])) i--;
  const at = i - 1;
  if (at < 0 || text[at] !== "@") return null;
  if (at > 0 && /[A-Za-z0-9_.-]/.test(text[at - 1])) return null; // an e-mail address, not a mention
  const query = text.slice(i, caret);
  if (query.startsWith(".") || query.startsWith("-")) return null;
  return { start: at, query };
}

export interface MentionOption {
  /** What gets inserted after `@`; always a handle that addresses someone (PROTOCOL §5.5). */
  handle: string;
  kind: "person" | "role" | "all";
  label: string;
  detail: string;
  /** For people: the avatar letter and whether they are a human. */
  initial?: string;
  human?: boolean;
}

/**
 * Who `@<query>` can address, best match first: people other than the viewer (by name, or by fingerprint when two
 * share a name), roles that several people share or that differ from a name, and `@all`.
 */
export function mentionOptions(state: RoomState, me: string | undefined, query: string, limit = 8): MentionOption[] {
  const q = query.toLowerCase();
  const people = [...state.participants.values()].filter((p) => p.profile && !p.left && p.id !== me);
  const ambiguous = state.ambiguousNames();
  const ranked: { option: MentionOption; score: number; order: number }[] = [];
  const add = (option: MentionOption, keys: string[], order: number) => {
    const exact = option.handle.startsWith(q);
    if (!exact && !keys.some((k) => k.startsWith(q))) return;
    ranked.push({ option, score: exact ? 0 : 1, order });
  };

  const taken = new Set<string>();
  people.forEach((p, i) => {
    const profile = p.profile!;
    const name = slug(profile.name);
    const id = shortId(p.id).toLowerCase();
    const handle = name && !ambiguous.has(state.displayName(p.id)) ? name : id;
    taken.add(handle);
    const detail = [profile.role, clientLabel(profile.client)].filter(Boolean).join(" · ");
    add(
      { handle, kind: "person", label: ambiguous.has(state.displayName(p.id)) ? `${profile.name} · ${shortId(p.id)}` : profile.name, detail, initial: initialOf(profile.name), human: profile.kind === "human" },
      [...name.split("-"), slug(profile.role ?? ""), id],
      i,
    );
  });

  const roles = new Map<string, { label: string; names: string[] }>();
  for (const p of people) {
    const role = slug(p.profile!.role ?? "");
    if (!role) continue;
    const entry = roles.get(role) ?? { label: p.profile!.role!, names: [] };
    entry.names.push(p.profile!.name);
    roles.set(role, entry);
  }
  [...roles].forEach(([role, { label, names }], i) => {
    if (taken.has(role) || BROADCAST_HANDLES.includes(role)) return;
    const who = names.length === 1 ? names[0] : `${names.length} people`;
    add({ handle: role, kind: "role", label, detail: `role · ${who}` }, [], 1000 + i);
  });

  for (const handle of q ? BROADCAST_HANDLES : ["all"]) {
    add({ handle, kind: "all", label: handle, detail: "everyone in the room" }, [], 2000);
  }
  return ranked
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((r) => r.option);
}

/** The composer text with the mention at `start..caret` replaced by `@handle `, and where the caret goes. */
export function insertMention(text: string, start: number, caret: number, handle: string): { text: string; caret: number } {
  const after = text.slice(caret).replace(/^[A-Za-z0-9_.-]*/, "");
  const space = after.startsWith(" ") ? "" : " ";
  const inserted = `@${handle}${space}`;
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length + (space ? 0 : 1) };
}

/* ---------- Labels and formatting ---------- */

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  in_progress: "In progress",
  done: "Done",
  rejected: "Rejected",
  blocked: "Blocked",
};

/** The status buttons offered for a task in a given status (most likely next step first). */
export function taskActions(status: TaskStatus): { status: TaskStatus; label: string }[] {
  switch (status) {
    case "open":
      return [
        { status: "accepted", label: "Accept" },
        { status: "in_progress", label: "Start" },
        { status: "done", label: "Done" },
        { status: "rejected", label: "Reject" },
      ];
    case "accepted":
      return [
        { status: "in_progress", label: "Start" },
        { status: "done", label: "Done" },
        { status: "rejected", label: "Reject" },
      ];
    case "in_progress":
      return [
        { status: "done", label: "Done" },
        { status: "blocked", label: "Blocked" },
      ];
    case "blocked":
      return [
        { status: "in_progress", label: "Resume" },
        { status: "rejected", label: "Reject" },
      ];
    case "done":
    case "rejected":
      return [{ status: "open", label: "Reopen" }];
  }
}

const CLIENT_LABEL: Record<ClientKind, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  browser: "Browser",
  cli: "CLI",
  other: "Other",
};

export const clientLabel = (client: string | undefined): string =>
  client ? (CLIENT_LABEL[client as ClientKind] ?? client) : "";

/** One letter for the avatar. */
export function initialOf(name: string): string {
  const ch = [...name.trim()].find((c) => /[\p{L}\p{N}]/u.test(c));
  return (ch ?? "?").toUpperCase();
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${units[u]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday" or a short date for a feed day separator. */
export function dayLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ts);
  return d.toLocaleDateString("en", {
    weekday: days < 7 ? "short" : undefined,
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

/** "just now", "5m ago", "2h ago", "3d ago". */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** When something happened, short: "14:09" today, otherwise "yesterday" or a date. */
export function whenLabel(ts: number, now = Date.now()): string {
  const day = dayLabel(ts, now);
  if (day === "Today") return formatTime(ts);
  return day === "Yesterday" ? "yesterday" : day;
}

/** "today at 14:09", "tomorrow at 09:30" or "Oct 19 at 14:09", for deadlines such as a deleted room's purge time. */
export function untilLabel(ts: number, now = Date.now()): string {
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / 86_400_000);
  const time = formatTime(ts);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${new Date(ts).toLocaleDateString("en", { month: "short", day: "numeric" })} at ${time}`;
}

export interface PresenceView {
  state: "online" | "listening" | "offline";
  label: string;
  live: boolean;
}

/** How a participant's presence is shown; humans are "online" rather than "listening". */
export function presenceView(
  entry: { state: string; last_seen: number } | undefined,
  kind: Profile["kind"] | undefined,
  now = Date.now(),
): PresenceView {
  if (!entry) return { state: "offline", label: "offline", live: false };
  const stale = now - entry.last_seen > 90_000;
  if (entry.state === "offline" || (stale && entry.state !== "listening")) {
    return { state: "offline", label: entry.last_seen ? `seen ${ago(entry.last_seen, now)}` : "offline", live: false };
  }
  if (entry.state === "listening" && kind !== "human") return { state: "listening", label: "listening", live: true };
  return { state: "online", label: "online", live: true };
}

export function ttlLabel(days: number | null | undefined): string {
  if (!days) return "Messages are kept until the room is deleted";
  return `Messages disappear after ${days} ${days === 1 ? "day" : "days"}`;
}

/** Retry delay with exponential growth, a cap and up to 25 % jitter. */
export function backoffDelay(attempt: number, base = 1000, max = 30_000, random = Math.random): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(exp * (0.75 + random() * 0.25));
}

/** A file name that is safe to offer as a download name. */
export function safeFileName(name: string, fallback = "download"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/** The download name of an artifact version: keeps an extension in the name, else guesses one from the content. */
export function artifactFileName(name: string, version: number, content?: string): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return safeFileName(`${name.slice(0, dot)}.v${version}${name.slice(dot)}`);
  let ext = ".txt";
  if (content !== undefined) {
    try {
      JSON.parse(content);
      ext = ".json";
    } catch {
      if (/^\s*(#|openapi:|asyncapi:)/m.test(content)) ext = /^\s*#/.test(content) ? ".md" : ".yaml";
    }
  } else ext = "";
  return safeFileName(`${name}.v${version}${ext}`);
}

/* ---------- Feed model ---------- */

export type FeedItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "event"; key: string; event: RoomEvent; forMe: boolean; mine: boolean }
  | { kind: "activity"; key: string; event: RoomEvent; text: string; ts: number };

const FEED_TYPES = new Set(["message", "file", "task.create", "artifact.put"]);

/** Human sentence for events that show as a compact activity line in the feed (null = not shown). */
export function activityText(state: RoomState, event: RoomEvent): string | null {
  const who = state.displayName(event.sender);
  switch (event.type) {
    case "join": {
      const p = event.body.profile;
      const what = [p.role, clientLabel(p.client)].filter(Boolean).join(", ");
      return `${who} joined${what ? ` (${what})` : ""}`;
    }
    case "leave":
      return `${who} left`;
    case "task.update": {
      const task = state.tasks.get(event.body.task);
      const title = task ? `“${task.title}”` : "a task";
      const label = STATUS_LABEL[event.body.status] ?? event.body.status;
      return `${who} moved ${title} to ${label}${event.body.note ? `: ${event.body.note}` : ""}`;
    }
    case "room.meta": {
      const changes: string[] = [];
      if (event.body.name !== undefined) changes.push(event.body.name ? `renamed the room to “${event.body.name}”` : "cleared the room name");
      if (event.body.description !== undefined) {
        changes.push(event.body.description.trim() ? `updated About this room: ${firstLine(event.body.description, 140)}` : "cleared About this room");
      }
      return changes.length ? `${who} ${changes.join(" and ")}` : null;
    }
    case "room.ttl":
      return event.body.days ? `${who} set messages to disappear after ${event.body.days} ${event.body.days === 1 ? "day" : "days"}` : `${who} turned off message expiry`;
    default:
      return null;
  }
}

/** The feed in display order with day separators. Unknown and silent event types (profile, status) are skipped. */
export function feedItems(state: RoomState, me: string | undefined, now = Date.now()): FeedItem[] {
  const items: FeedItem[] = [];
  let day = "";
  for (const event of state.events) {
    let item: FeedItem | null = null;
    if (FEED_TYPES.has(event.type)) {
      item = {
        kind: "event",
        key: event.cid,
        event,
        mine: event.sender === me,
        forMe: !!me && state.isAddressedTo(event, me) && !state.isBroadcast(event),
      };
    } else {
      const text = activityText(state, event);
      if (text) item = { kind: "activity", key: event.cid, event, text, ts: event.ts };
    }
    if (!item) continue;
    const label = dayLabel(event.ts, now);
    if (label !== day) {
      day = label;
      items.push({ kind: "day", key: `day-${startOfDay(event.ts)}`, label });
    }
    items.push(item);
  }
  return items;
}

/** Whether the room has anything worth showing besides the empty state. */
export const hasConversation = (items: FeedItem[]): boolean => items.some((i) => i.kind !== "day");

/** "Untitled room" unless the room has a name. */
export const roomTitle = (state: RoomState): string => state.meta.name?.trim() || "Untitled room";
