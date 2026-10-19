import type { EventOf, FileBody, Profile, RoomEvent, TaskStatus } from "./events.js";
import { BROADCAST_HANDLES, extractMentions, handlesFor, normalizeHandle, slug } from "./mentions.js";
import { matchesId, shortId } from "./identity.js";

export interface Participant {
  id: string;
  pub: string;
  profile?: Profile;
  status?: string;
  joinedSeq: number;
  lastSeq: number;
  left: boolean;
}

export interface TaskUpdate {
  seq: number;
  ts: number;
  by: string;
  status: TaskStatus;
  note?: string;
}

export interface Task {
  id: string;
  seq: number;
  ts: number;
  creator: string;
  title: string;
  description?: string;
  assignee?: string;
  acceptance: string[];
  refs: string[];
  status: TaskStatus;
  history: TaskUpdate[];
}

export interface ArtifactVersion {
  version: number;
  seq: number;
  ts: number;
  by: string;
  cid: string;
  content?: string;
  file?: FileBody;
  note?: string;
}

export interface Artifact {
  name: string;
  versions: ArtifactVersion[];
}

export interface RoomMeta {
  name?: string;
  /** "About this room": what the room is for, written by its members (PRD FR-1.5). */
  description?: string;
  descriptionBy?: string;
  descriptionTs?: number;
  ttlDays?: number | null;
}

/** Client-side room state built by applying events in `seq` order (PROTOCOL §5.4). */
export class RoomState {
  readonly events: RoomEvent[] = [];
  readonly participants = new Map<string, Participant>();
  readonly tasks = new Map<string, Task>();
  readonly artifacts = new Map<string, Artifact>();
  readonly meta: RoomMeta = {};
  lastSeq = 0;
  private readonly byCid = new Map<string, RoomEvent>();

  apply(event: RoomEvent): void {
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    this.events.push(event);
    this.byCid.set(event.cid, event);

    const p = this.touch(event);
    switch (event.type) {
      case "join":
      case "profile":
        p.profile = event.body.profile;
        if (event.body.profile.status) p.status = event.body.profile.status;
        p.left = false;
        break;
      case "status":
        p.status = event.body.text;
        break;
      case "leave":
        p.left = true;
        break;
      case "task.create":
        this.tasks.set(event.cid, {
          id: event.cid,
          seq: event.seq,
          ts: event.ts,
          creator: event.sender,
          title: event.body.title,
          description: event.body.description,
          assignee: event.body.assignee,
          acceptance: event.body.acceptance ?? [],
          refs: event.body.refs ?? [],
          status: "open",
          history: [],
        });
        break;
      case "task.update": {
        const task = this.tasks.get(event.body.task);
        if (task) {
          task.status = event.body.status;
          task.history.push({ seq: event.seq, ts: event.ts, by: event.sender, status: event.body.status, note: event.body.note });
        }
        break;
      }
      case "artifact.put": {
        const name = event.body.name;
        const artifact = this.artifacts.get(name) ?? { name, versions: [] };
        artifact.versions.push({
          version: artifact.versions.length + 1,
          seq: event.seq,
          ts: event.ts,
          by: event.sender,
          cid: event.cid,
          content: event.body.content,
          file: event.body.file,
          note: event.body.note,
        });
        this.artifacts.set(name, artifact);
        break;
      }
      case "room.meta":
        if (event.body.name !== undefined) this.meta.name = event.body.name;
        if (event.body.description !== undefined) {
          this.meta.description = event.body.description;
          this.meta.descriptionBy = event.sender;
          this.meta.descriptionTs = event.ts;
        }
        break;
      case "room.ttl":
        this.meta.ttlDays = event.body.days;
        break;
    }
  }

  private touch(event: RoomEvent): Participant {
    let p = this.participants.get(event.sender);
    if (!p) {
      p = { id: event.sender, pub: event.pub, joinedSeq: event.seq, lastSeq: event.seq, left: false };
      this.participants.set(event.sender, p);
    }
    p.lastSeq = event.seq;
    return p;
  }

  event(cid: string): RoomEvent | undefined {
    return this.byCid.get(cid);
  }

  /** Resolves a task by full id or unique id prefix. */
  findTask(idOrPrefix: string): Task | undefined {
    const exact = this.tasks.get(idOrPrefix);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((t) => matchesId(t.id, idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  handles(participantId: string): string[] {
    return handlesFor(participantId, this.participants.get(participantId)?.profile);
  }

  /**
   * The handle to mention a participant with: the first of owner, name, role, owner-role, owner-client that reaches
   * only them among the people present, else their short id (always unique).
   */
  preferredHandle(participantId: string): string {
    const p = this.participants.get(participantId);
    const all = this.handles(participantId);
    const present = [...this.participants.values()].filter((o) => o.profile && !o.left && o.id !== participantId);
    const owner = p?.profile?.kind !== "human" && p?.profile?.owner ? slug(p.profile.owner) : "";
    const role = p?.profile?.role ? slug(p.profile.role) : "";
    const candidates = [owner, p?.profile?.name ? slug(p.profile.name) : "", owner && role ? `${owner}-${role}` : "", role, ...all.filter((h) => h.startsWith(`${owner}-`))];
    const id = shortId(participantId).toLowerCase();
    for (const c of candidates) {
      if (c && all.includes(c) && c.length <= 24 && !present.some((o) => this.handles(o.id).includes(c))) return c;
    }
    return id;
  }

  /** Participants a mention token would reach (empty for unknown tokens; everyone for @all). */
  addressees(token: string): string[] {
    const t = token.toLowerCase();
    return [...this.participants.values()].filter((p) => p.profile && !p.left && this.handles(p.id).includes(t)).map((p) => p.id);
  }

  /** Whether `assignee` (a handle, @handle or participant id) refers to the participant. */
  isAssignee(assignee: string | undefined, participantId: string): boolean {
    if (!assignee) return false;
    if (assignee === participantId) return true;
    const handle = normalizeHandle(assignee);
    return this.handles(participantId).includes(handle);
  }

  mentionsOf(event: RoomEvent): string[] {
    if (event.type === "message" || event.type === "file") {
      return event.body.mentions ?? extractMentions(event.body.text ?? "");
    }
    return [];
  }

  /** PROTOCOL §5.5. */
  isAddressedTo(event: RoomEvent, participantId: string): boolean {
    if (event.sender === participantId) return false;
    const handles = this.handles(participantId);
    if (this.mentionsOf(event).some((m) => handles.includes(m))) return true;
    if (event.type === "message" || event.type === "file") {
      const parent = event.body.reply_to ? this.byCid.get(event.body.reply_to) : undefined;
      if (parent?.sender === participantId) return true;
    }
    if (event.type === "task.create") return this.isAssignee(event.body.assignee, participantId);
    if (event.type === "task.update") {
      const task = this.tasks.get(event.body.task);
      return !!task && (task.creator === participantId || this.isAssignee(task.assignee, participantId));
    }
    // A new "About this room" concerns everyone in it.
    if (event.type === "room.meta") return event.body.description !== undefined;
    return false;
  }

  /** Whether an event is addressed to everyone rather than to specific handles. */
  isBroadcast(event: RoomEvent): boolean {
    return this.mentionsOf(event).some((m) => BROADCAST_HANDLES.includes(m));
  }

  tasksFor(participantId: string): Task[] {
    return [...this.tasks.values()].filter((t) => this.isAssignee(t.assignee, participantId));
  }

  displayName(participantId: string): string {
    const p = this.participants.get(participantId);
    return p?.profile?.name ?? `participant ${participantId.slice(0, 6)}`;
  }

  /** Names that more than one participant uses; the UI shows fingerprints for them. */
  ambiguousNames(): Set<string> {
    const seen = new Map<string, number>();
    for (const p of this.participants.values()) {
      const name = p.profile?.name;
      if (name) seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
  }

  files(): EventOf<"file">[] {
    return this.events.filter((e): e is EventOf<"file"> => e.type === "file");
  }

  messages(): EventOf<"message">[] {
    return this.events.filter((e): e is EventOf<"message"> => e.type === "message");
  }
}

