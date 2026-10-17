import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Profile, StoredEnvelope } from "@lincor/core";

export type Autonomy = "ask" | "auto";
export type ListenMode = "background" | "off";

export interface RoomRecord {
  roomId: string;
  origin: string;
  key: string;
  name?: string;
  /** About given at create; published with the first post (the room does not exist on the server before). */
  about?: string;
  createdLocally?: boolean;
  addedAt: number;
}

/** One participant identity: one per (room, project directory). */
export interface MemberRecord {
  seed: string;
  projectDir: string;
  profile?: Profile;
  /** Whether our join event has been published. */
  introduced: boolean;
  /** Highest seq the agent has been shown by read/wait/briefing. */
  readSeq: number;
  /** Highest seq a hook or watcher already announced to the agent. */
  notifiedSeq: number;
  autonomy: Autonomy;
  listen: ListenMode;
}

export interface ProjectRecord {
  projectDir: string;
  currentRoom?: string;
}

export const lincorHome = (env: NodeJS.ProcessEnv = process.env): string => env.LINCOR_HOME || join(homedir(), ".lincor");

const hash16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Local state under ~/.lincor. Secrets are stored with 0600 permissions in 0700 directories. */
export class Store {
  constructor(readonly home: string) {}

  private ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  private readJson<T>(path: string): T | undefined {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private writeJson(path: string, value: unknown): void {
    this.ensureDir(join(path, ".."));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  roomDir(roomId: string): string {
    return join(this.home, "rooms", roomId);
  }

  getRoom(roomId: string): RoomRecord | undefined {
    return this.readJson(join(this.roomDir(roomId), "room.json"));
  }

  putRoom(room: RoomRecord): void {
    this.writeJson(join(this.roomDir(room.roomId), "room.json"), room);
  }

  listRooms(): RoomRecord[] {
    const dir = join(this.home, "rooms");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((id) => this.getRoom(id))
      .filter((r): r is RoomRecord => !!r)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  removeRoom(roomId: string): void {
    rmSync(this.roomDir(roomId), { recursive: true, force: true });
  }

  private memberPath(roomId: string, projectDir: string): string {
    return join(this.roomDir(roomId), "members", `${hash16(projectDir)}.json`);
  }

  getMember(roomId: string, projectDir: string): MemberRecord | undefined {
    return this.readJson(this.memberPath(roomId, projectDir));
  }

  putMember(roomId: string, member: MemberRecord): void {
    this.writeJson(this.memberPath(roomId, member.projectDir), member);
  }

  removeMember(roomId: string, projectDir: string): void {
    rmSync(this.memberPath(roomId, projectDir), { force: true });
  }

  /** Rooms in which this project directory has an identity. */
  roomsForProject(projectDir: string): RoomRecord[] {
    return this.listRooms().filter((r) => existsSync(this.memberPath(r.roomId, projectDir)));
  }

  getProject(projectDir: string): ProjectRecord {
    return this.readJson(join(this.home, "projects", `${hash16(projectDir)}.json`)) ?? { projectDir };
  }

  putProject(project: ProjectRecord): void {
    this.writeJson(join(this.home, "projects", `${hash16(project.projectDir)}.json`), project);
  }

  /** Encrypted envelopes cached locally so commands do not refetch the whole history. */
  readEvents(roomId: string): StoredEnvelope[] {
    const path = join(this.roomDir(roomId), "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as StoredEnvelope];
        } catch {
          return [];
        }
      });
  }

  appendEvents(roomId: string, envelopes: StoredEnvelope[]): void {
    if (!envelopes.length) return;
    this.ensureDir(this.roomDir(roomId));
    const path = join(this.roomDir(roomId), "events.jsonl");
    appendFileSync(path, envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  }

  clearEvents(roomId: string): void {
    rmSync(join(this.roomDir(roomId), "events.jsonl"), { force: true });
  }

  /** Small per-session scratch state for hooks (throttling, watcher supersession). */
  hookState<T extends object>(sessionId: string): { get(): T | undefined; set(value: T): void } {
    const path = join(this.home, "hooks", `${hash16(sessionId)}.json`);
    return { get: () => this.readJson<T>(path), set: (value) => this.writeJson(path, value) };
  }
}
