import { displayId, shortId, type PresenceEntry, type RoomEvent, type RoomSession, type RoomState, type Task } from "@lincor/core";

/** Commands differ between the CLI and MCP tools; everything else is shared. */
export type Surface = "cli" | "mcp";

export const shortCid = (cid: string): string => displayId(cid);

const time = (ms: number): string => {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  const hm = d.toTimeString().slice(0, 5);
  return sameDay ? hm : `${d.toISOString().slice(0, 10)} ${hm}`;
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

export function who(state: RoomState, id: string): string {
  const p = state.participants.get(id);
  const name = state.displayName(id);
  const role = p?.profile?.role ? ` [${p.profile.role}]` : "";
  const dup = p?.profile?.name && state.ambiguousNames().has(p.profile.name) ? ` #${shortId(id)}` : "";
  return `${name}${role}${dup}`;
}

const STATUS: Record<string, string> = {
  open: "open",
  accepted: "accepted",
  in_progress: "in progress",
  done: "done",
  rejected: "rejected",
  blocked: "blocked",
};

export function formatTask(state: RoomState, task: Task, detail = false): string {
  const to = task.assignee ? ` → ${task.assignee.startsWith("@") ? task.assignee : "@" + task.assignee}` : "";
  let line = `task ${shortCid(task.id)} [${STATUS[task.status]}] "${task.title}"${to} (from ${who(state, task.creator)})`;
  if (detail) {
    if (task.description) line += `\n  ${task.description.replace(/\n/g, "\n  ")}`;
    if (task.acceptance.length) line += `\n  acceptance:${task.acceptance.map((a) => `\n   - ${a}`).join("")}`;
    if (task.refs.length) line += `\n  refs: ${task.refs.join(", ")}`;
    for (const h of task.history) line += `\n  ${time(h.ts)} ${STATUS[h.status]} by ${who(state, h.by)}${h.note ? `: ${h.note}` : ""}`;
  }
  return line;
}

/** One compact line (or a few) per event, for an agent's context. */
export function formatEvent(state: RoomState, event: RoomEvent, me?: string): string {
  const mark = me && state.isAddressedTo(event, me) ? "★ " : "";
  const head = `${mark}#${event.seq} ${time(event.ts)} ${who(state, event.sender)}`;
  switch (event.type) {
    case "join": {
      const p = event.body.profile;
      const bits = [p.client, p.project && `project ${p.project}`, p.repo && `repo ${p.repo}`, p.stack].filter(Boolean).join(", ");
      return `${head} joined${bits ? ` (${bits})` : ""}${p.status ? `: ${p.status}` : ""}`;
    }
    case "profile":
      return `${head} updated their profile`;
    case "status":
      return `${head} status: ${event.body.text}`;
    case "leave":
      return `${head} left`;
    case "message": {
      const reply = event.body.reply_to ? ` (reply to ${shortCid(event.body.reply_to)})` : "";
      return `${head}${reply} msg ${shortCid(event.cid)}: ${event.body.text}`;
    }
    case "task.create": {
      const task = state.tasks.get(event.cid);
      return `${head} created ${task ? formatTask(state, task, true) : `task ${shortCid(event.cid)} "${event.body.title}"`}`;
    }
    case "task.update": {
      const task = state.tasks.get(event.body.task);
      const title = task ? ` "${clip(task.title, 60)}"` : "";
      return `${head} moved task ${shortCid(event.body.task)}${title} to ${STATUS[event.body.status] ?? event.body.status}${event.body.note ? `: ${event.body.note}` : ""}`;
    }
    case "file":
      return `${head} shared file ${shortCid(event.cid)} "${event.body.name}" (${kb(event.body.size)})${event.body.text ? `: ${event.body.text}` : ""}`;
    case "artifact.put": {
      const artifact = state.artifacts.get(event.body.name);
      const version = artifact?.versions.find((v) => v.cid === event.cid)?.version;
      return `${head} put contract "${event.body.name}" v${version ?? "?"}${event.body.note ? `: ${event.body.note}` : ""}`;
    }
    case "room.meta":
      return `${head} renamed the room${event.body.name ? ` to "${event.body.name}"` : ""}`;
    case "room.ttl":
      return `${head} set message retention to ${event.body.days ? `${event.body.days} days` : "forever"}`;
    default:
      return `${head} ${(event as { type: string }).type}`;
  }
}

const presenceLabel = (entry?: PresenceEntry): string => {
  if (!entry) return "offline";
  if (entry.state !== "offline") return entry.state;
  const mins = Math.round((Date.now() - entry.last_seen) / 60000);
  return mins < 60 ? `offline, seen ${mins}m ago` : `offline, seen ${Math.round(mins / 60)}h ago`;
};

export function formatPeople(session: RoomSession, presence: PresenceEntry[] = []): string {
  const state = session.state;
  const people = [...state.participants.values()].filter((p) => p.profile && !p.left);
  if (!people.length) return "Nobody has introduced themselves yet.";
  return people
    .map((p) => {
      const pr = p.profile!;
      const you = p.id === session.identity.id ? " (you)" : "";
      const details = [pr.kind === "human" ? "person" : pr.client, pr.owner && pr.kind === "agent" && `for ${pr.owner}`, pr.project && `project ${pr.project}`, pr.stack]
        .filter(Boolean)
        .join(", ");
      const status = p.status ? ` — ${p.status}` : "";
      return `- ${who(state, p.id)}${you}: ${details}; ${presenceLabel(presence.find((e) => e.sender === p.id))}${status}`;
    })
    .join("\n");
}

const hints = {
  cli: {
    send: 'agents-room send "…"  (reply: agents-room send --reply <msg-id> "…")',
    task: "agents-room task accept|start|done|block <task-id> [--note \"…\"]",
    wait: "agents-room wait  (blocks until something is addressed to you; run it again after handling)",
    read: "agents-room read",
    intro: 'agents-room profile --role <role> --name "<name>" --status "<what you do>"',
    status: 'agents-room status "<what you are doing>"',
  },
  mcp: {
    send: "chat_send {text, reply_to?}",
    task: "chat_task_update {task, status, note?}",
    wait: "chat_wait (blocks until something is addressed to you; call it again after handling)",
    read: "chat_read",
    intro: "chat_profile {role, name, status}",
    status: "chat_status {text}",
  },
};

export interface BriefingOptions {
  surface: Surface;
  autonomy: string;
  presence?: PresenceEntry[];
  recent?: number;
  justJoined?: boolean;
}

/** What an agent sees when it joins or reconnects: who, what is for it, what to do next. */
export function briefing(session: RoomSession, options: BriefingOptions): string {
  const state = session.state;
  const me = session.identity.id;
  const h = hints[options.surface];
  const name = state.meta.name ? `"${state.meta.name}"` : `${session.roomId.slice(0, 8)}…`;
  const out: string[] = [];

  out.push(
    `${options.justJoined ? "You joined" : "You are in"} Agents secure chat room ${name} as ${who(state, me)} (id ${shortId(me)}). Messages are end-to-end encrypted on this machine.`,
  );
  if (session.deleted) out.push(`⚠ This room was deleted and will be purged at ${new Date(session.deleted.purge_at).toISOString()}.`);
  out.push("", `People:\n${formatPeople(session, options.presence)}`);

  const mine = state.tasksFor(me).filter((t) => t.status !== "done" && t.status !== "rejected");
  out.push("", mine.length ? `Tasks for you (${mine.length}):\n${mine.map((t) => "- " + formatTask(state, t, true)).join("\n")}` : "Tasks for you: none.");
  const others = [...state.tasks.values()].filter((t) => !mine.includes(t) && t.status !== "done" && t.status !== "rejected");
  if (others.length) out.push(`Other open tasks:\n${others.map((t) => "- " + formatTask(state, t)).join("\n")}`);

  if (state.artifacts.size) {
    out.push(`Contracts: ${[...state.artifacts.values()].map((a) => `${a.name} v${a.versions.length}`).join(", ")}`);
  }
  const chatter = state.events.filter((e) => e.type === "message" || e.type === "file");
  const recent = chatter.slice(-(options.recent ?? 10));
  if (recent.length) {
    out.push("", `Recent messages (${recent.length} of ${chatter.length}):\n${recent.map((e) => formatEvent(state, e, me)).join("\n")}`);
  }
  out.push(
    "",
    `Your autonomy here: ${options.autonomy}${options.autonomy === "ask" ? " (ask your user before changing code or taking a task)" : ""}.`,
    "Next:",
    `- Tell your user what is in the room and what is addressed to you (★).`,
    `- Reply: ${h.send}`,
    `- Tasks: ${h.task}`,
    `- Listen: ${h.wait}`,
    `- Keep your status current: ${h.status}`,
  );
  return out.join("\n");
}
