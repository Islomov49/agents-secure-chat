// HTML for the room panes. Every value that comes from the room (names, texts, file names) goes through
// escapeHtml or renderText, so the output is safe to assign to innerHTML.
import { shortId, type EventOf, type Participant, type PresenceEntry, type RoomEvent, type RoomState, type Task } from "@lincor/core";
import {
  STATUS_LABEL,
  clientLabel,
  escapeHtml as esc,
  firstLine,
  formatBytes,
  formatTime,
  initialOf,
  presenceView,
  renderText,
  taskActions,
  whenLabel,
  type FeedItem,
} from "./view";

export interface RenderContext {
  state: RoomState;
  me?: string;
  /** The viewer's own handles (without broadcast ones), for highlighting mentions of them. */
  myHandles: string[];
  presence: Map<string, PresenceEntry>;
  now: number;
}

const FILE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`;
const DOC_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3h8l4 4v14H4V3z"/><path d="M8 12h8M8 16h5M8 8h4"/></svg>`;

/** Adds a Copy button to code blocks. renderText escapes the room's text, so every `<pre><code>` here is its own. */
const withCodeCopy = (html: string) =>
  html.replaceAll("<pre><code>", `<pre><button class="pre__copy" type="button" data-copy-code data-done="Copied" aria-label="Copy code">Copy</button><code>`);

/** Display name, with the fingerprint when two participants use the same name. */
export function nameOf(ctx: Pick<RenderContext, "state">, id: string, ambiguous = ctx.state.ambiguousNames()): string {
  const name = ctx.state.displayName(id);
  return ambiguous.has(name) ? `${name} · ${shortId(id)}` : name;
}

const isHuman = (p?: Participant) => p?.profile?.kind === "human";

function avatar(p: Participant | undefined, name: string, presence?: string): string {
  return `<div class="avatar${isHuman(p) ? " avatar--human" : ""}"${presence ? ` data-presence="${esc(presence)}"` : ""} aria-hidden="true">${esc(initialOf(name))}</div>`;
}

/* ---------- About this room ---------- */

/** What the room is for, who wrote it and when; or an invitation to write it (PRD FR-1.5). */
export function aboutHtml(ctx: RenderContext): string {
  const meta = ctx.state.meta;
  const text = meta.description?.trim();
  if (!text) {
    return `<p class="about__empty">No About yet. Write what this room is for: the goal, who is expected, where the contracts are.</p>
      <button class="btn btn--small" type="button" data-about-edit>Write About</button>`;
  }
  const by = meta.descriptionBy ? nameOf(ctx, meta.descriptionBy) : "a member";
  const when = meta.descriptionTs ? whenLabel(meta.descriptionTs, ctx.now) : "";
  return `<p class="about__text" tabindex="0">${esc(text)}</p><p class="about__meta">by ${esc(by)}${when ? ` · ${esc(when)}` : ""}</p>`;
}

/* ---------- People ---------- */

export function peopleHtml(ctx: RenderContext): string {
  const ambiguous = ctx.state.ambiguousNames();
  const people = [...ctx.state.participants.values()]
    .filter((p) => p.profile)
    .sort((a, b) => Number(b.id === ctx.me) - Number(a.id === ctx.me) || Number(a.left) - Number(b.left) || a.joinedSeq - b.joinedSeq);
  if (!people.length) {
    return `<div class="empty empty--small"><p>No one has joined yet. Agents and people show up here when they introduce themselves.</p></div>`;
  }
  return people
    .map((p) => {
      const profile = p.profile!;
      const name = nameOf(ctx, p.id, ambiguous);
      const pv = p.left
        ? { state: "offline", label: "left", live: false }
        : p.id === ctx.me
          ? { state: "online", label: "online", live: true }
          : presenceView(ctx.presence.get(p.id), profile.kind, ctx.now);
      const details = [
        `Fingerprint ${shortId(p.id)}`,
        profile.owner && `owner ${profile.owner}`,
        profile.project && `project ${profile.project}`,
        profile.repo && `repo ${profile.repo}`,
        profile.stack && `stack ${profile.stack}`,
      ].filter(Boolean);
      const status = p.status ?? profile.status;
      return `
      <div class="person${p.left ? " person--left" : ""}" title="${esc(details.join(" · "))}">
        ${avatar(p, profile.name, pv.state)}
        <div class="person__main">
          <div class="person__name">${esc(name)}${p.id === ctx.me ? ` <span class="person__you">(you)</span>` : ""}</div>
          <div class="person__meta">
            ${profile.role ? `<span class="pill">${esc(profile.role)}</span>` : ""}
            <span>${esc(clientLabel(profile.client))}</span>
            <span class="presence${pv.live ? " presence--live" : ""}">${esc(pv.label)}</span>
          </div>
          ${status ? `<div class="person__status">${esc(status)}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

/* ---------- Feed ---------- */

function taskCard(ctx: RenderContext, task: Task | undefined, fallback: EventOf<"task.create">["body"]): string {
  const t = task ?? { title: fallback.title, description: fallback.description, assignee: fallback.assignee, acceptance: fallback.acceptance ?? [], refs: fallback.refs ?? [], status: "open" as const };
  const textOptions = { isMine: (h: string) => ctx.myHandles.includes(h) };
  const refs = t.refs
    .map((cid) => ctx.state.event(cid))
    .filter((e): e is EventOf<"file"> => e?.type === "file")
    .map((e) => fileChip(e))
    .join("");
  return `
    <article class="task-card"${task ? ` data-task="${esc(task.id)}"` : ""}>
      <div class="task-card__top"><span class="status status--${esc(t.status)}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span>${t.assignee ? `<span class="pill">${esc(t.assignee)}</span>` : ""}</div>
      <h3>${esc(t.title)}</h3>
      ${t.description ? `<div class="task-card__desc">${withCodeCopy(renderText(t.description, textOptions))}</div>` : ""}
      ${t.acceptance.length ? `<ul>${t.acceptance.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
      ${refs}
    </article>`;
}

function fileChip(event: EventOf<"file">): string {
  const f = event.body;
  return `<div class="chip chip--file">${FILE_ICON}<span class="chip__name" title="${esc(f.name)}">${esc(f.name)}</span><small>${esc(formatBytes(f.size))}</small>
    <button class="btn btn--small" type="button" data-download="${esc(event.cid)}" data-focus="dl:${esc(event.cid)}" aria-label="Download ${esc(f.name)}">Download</button></div>`;
}

function replyLine(ctx: RenderContext, replyTo: string | undefined, ambiguous: Set<string>): string {
  if (!replyTo) return "";
  const parent = ctx.state.event(replyTo);
  if (!parent) return `<div class="msg__reply">Reply to an earlier message</div>`;
  let excerpt = "";
  if (parent.type === "message") excerpt = firstLine(parent.body.text, 80);
  else if (parent.type === "file") excerpt = parent.body.text ? firstLine(parent.body.text, 80) : parent.body.name;
  else if (parent.type === "task.create") excerpt = parent.body.title;
  return `<button class="msg__reply" type="button" data-goto="${esc(parent.cid)}">Reply to <b>${esc(nameOf(ctx, parent.sender, ambiguous))}</b>${excerpt ? `<span>${esc(excerpt)}</span>` : ""}</button>`;
}

function eventHtml(ctx: RenderContext, item: Extract<FeedItem, { kind: "event" }>, ambiguous: Set<string>): string {
  const e = item.event;
  const p = ctx.state.participants.get(e.sender);
  const name = nameOf(ctx, e.sender, ambiguous);
  const textOptions = { isMine: (h: string) => ctx.myHandles.includes(h) };
  let body = "";
  let extra = "";
  let replyTo: string | undefined;
  let what = "";
  let canReply = false;
  switch (e.type) {
    case "message":
      body = e.body.text;
      replyTo = e.body.reply_to;
      canReply = true;
      break;
    case "file":
      body = e.body.text ?? "";
      replyTo = e.body.reply_to;
      extra = fileChip(e);
      canReply = true;
      break;
    case "task.create":
      what = "created a task";
      extra = taskCard(ctx, ctx.state.tasks.get(e.cid), e.body);
      canReply = true;
      break;
    case "artifact.put": {
      const versions = ctx.state.artifacts.get(e.body.name)?.versions ?? [];
      const v = versions.find((x) => x.cid === e.cid)?.version ?? versions.length;
      what = v > 1 ? "updated a contract" : "pinned a contract";
      body = e.body.note ?? "";
      extra = `<button class="chip chip--btn" type="button" data-artifact="${esc(e.body.name)}" data-version="${v}" data-focus="art:${esc(e.cid)}">${DOC_ICON}<span>Contract <b>${esc(e.body.name)}</b></span><small>version ${v}</small></button>`;
      break;
    }
    default:
      return "";
  }
  const classes = ["msg", item.mine ? "msg--mine" : "", item.forMe ? "msg--for-me" : ""].filter(Boolean).join(" ");
  return `
    <article class="${classes}" data-cid="${esc(e.cid)}" aria-label="${esc(name)} at ${esc(formatTime(e.ts))}">
      ${avatar(p, p?.profile?.name ?? name)}
      <div class="msg__main">
        ${replyLine(ctx, replyTo, ambiguous)}
        <div class="msg__head">
          <span class="msg__name">${esc(name)}</span>
          ${p?.profile?.role ? `<span class="pill">${esc(p.profile.role)}</span>` : ""}
          ${what ? `<span class="msg__what">${esc(what)}</span>` : ""}
          <time class="msg__time" datetime="${new Date(e.ts).toISOString()}" title="${esc(new Date(e.ts).toLocaleString("en"))}">${esc(formatTime(e.ts))}</time>
          ${canReply ? `<span class="msg__actions"><button class="link-btn" type="button" data-reply="${esc(e.cid)}" data-focus="reply:${esc(e.cid)}" aria-label="Reply to ${esc(name)}">Reply</button></span>` : ""}
        </div>
        ${body ? `<div class="msg__body">${withCodeCopy(renderText(body, textOptions))}</div>` : ""}
        ${extra}
      </div>
    </article>`;
}

export function feedHtml(ctx: RenderContext, items: FeedItem[]): string {
  const ambiguous = ctx.state.ambiguousNames();
  return items
    .map((item) => {
      if (item.kind === "day") return `<div class="day" role="separator">${esc(item.label)}</div>`;
      if (item.kind === "activity") {
        return `<div class="activity" data-cid="${esc(item.key)}"><span>${esc(item.text)}</span><time datetime="${new Date(item.ts).toISOString()}">${esc(formatTime(item.ts))}</time></div>`;
      }
      return eventHtml(ctx, item, ambiguous);
    })
    .join("");
}

const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;

/** An empty room. The [agents] line is for AI agents that opened the link in a browser: the CLI is their way in. */
export const emptyFeedHtml = (cli: string): string => `
  <div class="empty">
    <div class="log">
      <div class="log__head" aria-hidden="true">room.log</div>
      <div class="log__body">
        <p><span class="log__tag">[room]</span> created</p>
        <p><span class="log__tag">[key]</span> <span class="log__ok">never sent to the server</span></p>
        <p><span class="log__tag">[agents]</span> <span class="log__cmd">${esc(cli)} join '&lt;link&gt;'</span></p>
        <p><span class="log__tag">[wait]</span> <span class="log__wait">no one's here yet</span><span class="cursor" aria-hidden="true"></span></p>
      </div>
    </div>
    <p>Send the invite to your teammates. Their agents open the link and join on their own.</p>
    <button class="btn" type="button" data-copy-invite data-done="Invite copied" data-focus="empty-invite">${COPY_ICON}<span data-text>Copy invite</span></button>
  </div>`;

/* ---------- Side: tasks, contracts, files ---------- */

const ACTIVE_ORDER: Record<string, number> = { in_progress: 0, blocked: 1, accepted: 2, open: 3, done: 4, rejected: 5 };

export function tasksHtml(ctx: RenderContext): string {
  const tasks = [...ctx.state.tasks.values()].sort(
    (a, b) => (ACTIVE_ORDER[a.status] ?? 9) - (ACTIVE_ORDER[b.status] ?? 9) || b.seq - a.seq,
  );
  if (!tasks.length) return emptySide("tasks");
  const ambiguous = ctx.state.ambiguousNames();
  return tasks
    .map((t) => {
      const last = t.history.at(-1);
      const by = last ? `${STATUS_LABEL[last.status]} by ${nameOf(ctx, last.by, ambiguous)}, ${whenLabel(last.ts, ctx.now)}` : `by ${nameOf(ctx, t.creator, ambiguous)}, ${whenLabel(t.ts, ctx.now)}`;
      return `
      <div class="item" data-task="${esc(t.id)}">
        <div class="item__title">${esc(t.title)}</div>
        <div class="item__meta"><span class="status status--${esc(t.status)}">${esc(STATUS_LABEL[t.status] ?? t.status)}</span>${t.assignee ? `<span class="pill">${esc(t.assignee)}</span>` : ""}<span>${esc(by)}</span></div>
        ${t.description ? `<p class="item__desc">${esc(firstLine(t.description, 160))}</p>` : ""}
        <div class="item__actions" role="group" aria-label="Change status of ${esc(t.title)}">
          ${taskActions(t.status)
            .map((a) => `<button class="btn btn--small" type="button" data-task-id="${esc(t.id)}" data-task-status="${a.status}" data-focus="task:${esc(t.id)}:${a.status}">${esc(a.label)}</button>`)
            .join("")}
        </div>
      </div>`;
    })
    .join("");
}

export function contractsHtml(ctx: RenderContext): string {
  const artifacts = [...ctx.state.artifacts.values()].sort((a, b) => (b.versions.at(-1)?.seq ?? 0) - (a.versions.at(-1)?.seq ?? 0));
  const add = `<div class="item item--add"><button class="btn btn--small" type="button" data-new-contract data-focus="contract:new">New contract</button></div>`;
  if (!artifacts.length) return add + emptySide("contracts");
  const ambiguous = ctx.state.ambiguousNames();
  return add + artifacts
    .map((a) => {
      const v = a.versions.at(-1)!;
      return `
      <button class="item item--btn" type="button" data-artifact="${esc(a.name)}" data-focus="contract:${esc(a.name)}">
        <span class="item__title">${esc(a.name)}</span>
        <span class="item__meta"><span class="pill">version ${v.version}</span><span>${esc(nameOf(ctx, v.by, ambiguous))}, ${esc(whenLabel(v.ts, ctx.now))}</span></span>
      </button>`;
    })
    .join("");
}

export function filesHtml(ctx: RenderContext): string {
  const files = ctx.state.files().slice().reverse();
  if (!files.length) return emptySide("files");
  const ambiguous = ctx.state.ambiguousNames();
  return files
    .map(
      (f) => `
      <div class="item item--file">
        <div class="item__title" title="${esc(f.body.name)}">${esc(f.body.name)}</div>
        <div class="item__meta"><span class="pill">${esc(formatBytes(f.body.size))}</span><span>${esc(nameOf(ctx, f.sender, ambiguous))}, ${esc(whenLabel(f.ts, ctx.now))}</span>
          <button class="btn btn--small item__dl" type="button" data-download="${esc(f.cid)}" data-focus="side-dl:${esc(f.cid)}" aria-label="Download ${esc(f.body.name)}">Download</button></div>
      </div>`,
    )
    .join("");
}

const EMPTY_SIDE = {
  tasks: "No tasks yet. Switch the composer to Task to create one, or ask an agent to.",
  contracts: "No contracts yet. Agents pin API and event schemas here so everyone works from the same version.",
  files: "No files yet. Files you attach are encrypted on your device before they leave it.",
};

export const emptySide = (tab: keyof typeof EMPTY_SIDE) => `<div class="empty empty--small"><p>${esc(EMPTY_SIDE[tab])}</p></div>`;

/** Short announcement for a new event from someone else ("Kamola: hello"). */
export function announcementFor(ctx: Pick<RenderContext, "state">, e: RoomEvent): string | null {
  const who = ctx.state.displayName(e.sender);
  switch (e.type) {
    case "message":
      return `${who}: ${firstLine(e.body.text)}`;
    case "file":
      return `${who} shared ${e.body.name}`;
    case "task.create":
      return `${who} created a task: ${e.body.title}`;
    case "task.update": {
      const t = ctx.state.tasks.get(e.body.task);
      return `${who} moved ${t ? t.title : "a task"} to ${STATUS_LABEL[e.body.status] ?? e.body.status}`;
    }
    case "artifact.put":
      return `${who} updated contract ${e.body.name}`;
    case "join":
      return `${who} joined`;
    default:
      return null;
  }
}
