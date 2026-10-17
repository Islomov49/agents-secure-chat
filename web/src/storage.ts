// Where the browser keeps a room's key and this browser's identity seed (PRD FR-10.5).
// Default: sessionStorage (the tab only). "Remember this room in this browser": localStorage.
// Pure functions over injected Storage objects so they can be unit-tested.

export interface RoomRecord {
  v: 1;
  /** The room key (the part after # in the link). */
  key: string;
  /** b64u Ed25519 seed of this browser's participant identity in the room. */
  seed: string;
  /** Last known room name, for the "Your rooms" list. Local only. */
  name?: string;
  savedAt: number;
}

export interface Stores {
  session: Storage | null;
  local: Storage | null;
}

export const RECORD_PREFIX = "lincor:room:";
export const CURRENT_KEY = "lincor:current";

/** A Storage that lives in memory, used when the browser blocks web storage. */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

/** Returns the storage if it is usable (access can throw in some privacy modes). */
export function probe(get: () => Storage | undefined): Storage | null {
  try {
    const s = get();
    if (!s) return null;
    const k = "lincor:probe";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

/** The storage a room record goes to: localStorage only when the person chose to remember the room. */
export function storageFor(remember: boolean, stores: Stores): Storage | null {
  return remember ? (stores.local ?? stores.session) : (stores.session ?? null);
}

function parse(raw: string | null): RoomRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<RoomRecord>;
    if (r && r.v === 1 && typeof r.key === "string" && typeof r.seed === "string") return r as RoomRecord;
  } catch {
    // ignore malformed entries
  }
  return null;
}

const safeGet = (s: Storage | null, key: string) => {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const safeSet = (s: Storage | null, key: string, value: string) => {
  try {
    s?.setItem(key, value);
    return !!s;
  } catch {
    return false;
  }
};
const safeRemove = (s: Storage | null, key: string) => {
  try {
    s?.removeItem(key);
  } catch {
    // ignore
  }
};

/** Loads a room record; `remembered` says whether it lives in localStorage. */
export function loadRecord(stores: Stores, roomId: string): { record: RoomRecord; remembered: boolean } | null {
  const local = stores.local !== stores.session ? parse(safeGet(stores.local, RECORD_PREFIX + roomId)) : null;
  if (local) return { record: local, remembered: true };
  const session = parse(safeGet(stores.session, RECORD_PREFIX + roomId));
  return session ? { record: session, remembered: false } : null;
}

/** Saves a record in the storage chosen by `remember` and removes it from the other one. */
export function saveRecord(stores: Stores, roomId: string, record: RoomRecord, remember: boolean): boolean {
  const target = storageFor(remember, stores);
  const other = target === stores.local ? stores.session : stores.local;
  const ok = safeSet(target, RECORD_PREFIX + roomId, JSON.stringify(record));
  if (ok && other && other !== target) safeRemove(other, RECORD_PREFIX + roomId);
  return ok;
}

export function forgetRecord(stores: Stores, roomId: string): void {
  safeRemove(stores.session, RECORD_PREFIX + roomId);
  safeRemove(stores.local, RECORD_PREFIX + roomId);
}

/** Rooms remembered in this browser (localStorage), most recently saved first. */
export function rememberedRooms(stores: Stores): { roomId: string; record: RoomRecord }[] {
  const s = stores.local;
  if (!s || s === stores.session) return [];
  const out: { roomId: string; record: RoomRecord }[] = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k?.startsWith(RECORD_PREFIX)) continue;
      const record = parse(s.getItem(k));
      if (record) out.push({ roomId: k.slice(RECORD_PREFIX.length), record });
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.record.savedAt - a.record.savedAt);
}

/** The room open in this tab survives reloads through sessionStorage (the URL no longer carries the key). */
export const setCurrent = (stores: Stores, roomId: string | null): void =>
  roomId ? void safeSet(stores.session, CURRENT_KEY, roomId) : safeRemove(stores.session, CURRENT_KEY);

export const getCurrent = (stores: Stores): string | null => safeGet(stores.session, CURRENT_KEY);
