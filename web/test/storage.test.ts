import { describe, expect, it } from "vitest";
import {
  CURRENT_KEY,
  MemoryStorage,
  RECORD_PREFIX,
  forgetRecord,
  getCurrent,
  loadRecord,
  probe,
  rememberedRooms,
  saveRecord,
  setCurrent,
  storageFor,
  type RoomRecord,
  type Stores,
} from "../src/storage";

const stores = (): Stores => ({ session: new MemoryStorage(), local: new MemoryStorage() });
const record = (key = "KEY", name?: string, savedAt = 1): RoomRecord => ({ v: 1, key, seed: "SEED", savedAt, ...(name ? { name } : {}) });

describe("storage selection", () => {
  it("uses sessionStorage by default and localStorage only when remembered", () => {
    const s = stores();
    expect(storageFor(false, s)).toBe(s.session);
    expect(storageFor(true, s)).toBe(s.local);
  });

  it("falls back sensibly when a storage is unavailable", () => {
    const session = new MemoryStorage();
    expect(storageFor(true, { session, local: null })).toBe(session);
    expect(storageFor(false, { session: null, local: new MemoryStorage() })).toBeNull();
  });

  it("probe returns null when access throws", () => {
    expect(
      probe(() => {
        throw new Error("SecurityError");
      }),
    ).toBeNull();
    const broken = new MemoryStorage();
    broken.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    expect(probe(() => broken)).toBeNull();
    const ok = new MemoryStorage();
    expect(probe(() => ok)).toBe(ok);
    expect(ok.length).toBe(0);
  });
});

describe("room records", () => {
  it("keeps a record in the tab only unless remembered, and moves it when the choice changes", () => {
    const s = stores();
    saveRecord(s, "room1", record(), false);
    expect(s.session!.getItem(RECORD_PREFIX + "room1")).toContain('"key":"KEY"');
    expect(s.local!.getItem(RECORD_PREFIX + "room1")).toBeNull();
    expect(loadRecord(s, "room1")).toEqual({ record: record(), remembered: false });

    saveRecord(s, "room1", record(), true);
    expect(s.session!.getItem(RECORD_PREFIX + "room1")).toBeNull();
    expect(loadRecord(s, "room1")?.remembered).toBe(true);

    saveRecord(s, "room1", record(), false);
    expect(s.local!.getItem(RECORD_PREFIX + "room1")).toBeNull();
    expect(loadRecord(s, "room1")?.remembered).toBe(false);
  });

  it("ignores malformed entries and forgets everywhere", () => {
    const s = stores();
    s.session!.setItem(RECORD_PREFIX + "bad", "{not json");
    s.local!.setItem(RECORD_PREFIX + "old", JSON.stringify({ v: 0, key: "x" }));
    expect(loadRecord(s, "bad")).toBeNull();
    expect(loadRecord(s, "old")).toBeNull();
    saveRecord(s, "r", record(), true);
    forgetRecord(s, "r");
    expect(loadRecord(s, "r")).toBeNull();
  });

  it("lists remembered rooms, newest first, and only from localStorage", () => {
    const s = stores();
    saveRecord(s, "a", record("A", "Alpha", 1), true);
    saveRecord(s, "b", record("B", "Beta", 5), true);
    saveRecord(s, "c", record("C", "Tab only", 9), false);
    s.local!.setItem("unrelated", "1");
    expect(rememberedRooms(s).map((r) => [r.roomId, r.record.name])).toEqual([
      ["b", "Beta"],
      ["a", "Alpha"],
    ]);
  });

  it("tracks the room open in this tab in sessionStorage", () => {
    const s = stores();
    expect(getCurrent(s)).toBeNull();
    setCurrent(s, "room1");
    expect(s.session!.getItem(CURRENT_KEY)).toBe("room1");
    expect(s.local!.getItem(CURRENT_KEY)).toBeNull();
    expect(getCurrent(s)).toBe("room1");
    setCurrent(s, null);
    expect(getCurrent(s)).toBeNull();
  });

  it("does not throw when the storage does", () => {
    const throwing = new MemoryStorage();
    throwing.setItem = () => {
      throw new Error("QuotaExceeded");
    };
    throwing.getItem = () => {
      throw new Error("SecurityError");
    };
    const s: Stores = { session: throwing, local: throwing };
    expect(saveRecord(s, "r", record(), false)).toBe(false);
    expect(loadRecord(s, "r")).toBeNull();
    expect(getCurrent(s)).toBeNull();
  });
});
