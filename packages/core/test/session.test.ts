import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockServer, type MockServer } from "../test-support/mock-server.js";
import { fromUtf8, newIdentity, newSecret, RoomSession, utf8, type Profile } from "../src/index.js";

let server: MockServer;
beforeAll(async () => {
  server = await startMockServer();
});
afterAll(() => server.close());

const profile = (name: string, role: string): Profile => ({ name, role, client: "cli", kind: "agent" });

describe("RoomSession against the API", () => {
  it("runs the frontend → unity hand-off without the server seeing plaintext", async () => {
    const secret = newSecret();
    const fe = new RoomSession(server.url, secret, newIdentity());
    const unity = new RoomSession(server.url, secret, newIdentity());

    // Nothing exists on the server before the first event (lazy creation).
    expect(await fe.client.info()).toMatchObject({ exists: false });
    await fe.join(profile("Ali's frontend agent", "frontend"));
    expect(server.rooms.has(fe.roomId)).toBe(true);

    const task = await fe.createTask({
      title: "Emit purchase_completed SECRET-TASK-TITLE",
      assignee: "@unity",
      acceptance: ["fires once per purchase"],
    });

    // Unity joins later, sees the history and the task addressed to its role.
    await unity.sync();
    await unity.join(profile("Bobur's Unity agent", "unity"));
    expect(unity.state.tasksFor(unity.identity.id).map((t) => t.id)).toEqual([task.cid]);
    expect(unity.addressedToMe(unity.state.events).map((e) => e.cid)).toContain(task.cid);

    // fe catches up, then listens; unity asks a question that wakes the wait.
    await fe.sync();
    const waiting = fe.waitForEvents(10);
    await new Promise((r) => setTimeout(r, 50));
    const presence = await fe.client.presence();
    expect(presence.find((p) => p.sender === fe.identity.id)?.state).toBe("listening");
    const question = await unity.say("@frontend ISO 4217 code or display string? SECRET-QUESTION");
    const woke = await waiting;
    expect(woke.map((e) => e.cid)).toContain(question.cid);
    expect(fe.addressedToMe(woke).map((e) => e.cid)).toEqual([question.cid]);

    await fe.say("ISO 4217", { replyTo: question.cid.slice(0, 8) });
    await fe.putArtifact("event-schema", utf8('{"currency":"ISO 4217","marker":"SECRET-CONTRACT"}'), { note: "v2" });
    const big = new Uint8Array(150_000).map((_, i) => i & 0xff);
    await unity.shareFile(big, "payload.bin", "application/octet-stream", { text: "@frontend sample payload" });
    await unity.updateTask(task.cid.slice(0, 6), "done", "shipped SECRET-NOTE");

    await fe.sync();
    expect(fe.state.tasks.get(task.cid)?.status).toBe("done");
    const file = fe.state.files().at(-1)!;
    expect(await fe.downloadFile(file.body)).toEqual(big);
    const artifact = await unity.sync().then(() => unity.readArtifact("event-schema"));
    expect(fromUtf8(artifact.content)).toContain("ISO 4217");
    expect(fe.rejected + unity.rejected).toBe(0);

    // The server only ever received ciphertext.
    const everything = server.received.map((b) => Buffer.from(b).toString("latin1")).join("\n");
    for (const marker of ["SECRET-TASK-TITLE", "SECRET-QUESTION", "SECRET-CONTRACT", "SECRET-NOTE", "Bobur", "frontend", "purchase_completed"]) {
      expect(everything).not.toContain(marker);
    }
  });

  it("drops events forged by someone without the room key and keeps going", async () => {
    const secret = newSecret();
    const alice = new RoomSession(server.url, secret, newIdentity());
    await alice.join(profile("Alice", "backend"));
    // A different room's session cannot write here (signatures are per room), so forge at the storage level.
    server.rooms.get(alice.roomId)!.events.push({ cid: "AAAAAAAAAAAAAAAAAAAAAA", sender: "AAAAAAAAAAAAAAAAAAAAAA", data: "AAAA", seq: 2, ts: Date.now() });
    await alice.say("still works");
    const reader = new RoomSession(server.url, secret, newIdentity());
    await reader.sync();
    expect(reader.rejected).toBe(1);
    expect(reader.state.messages().map((m) => m.body.text)).toEqual(["still works"]);
  });

  it("rejects requests for a room signed with another room's key", async () => {
    const a = new RoomSession(server.url, newSecret(), newIdentity());
    const b = new RoomSession(server.url, newSecret(), newIdentity());
    const forged = new (a.client.constructor as typeof b.client.constructor)(server.url, { ...b.keys, roomId: a.roomId });
    await expect(forged.events()).rejects.toMatchObject({ status: 401, code: "auth" });
  });

  it("soft-deletes and restores a room", async () => {
    const s = new RoomSession(server.url, newSecret(), newIdentity());
    await s.join(profile("Temp", "qa"));
    await s.remove();
    await expect(s.say("hello?")).rejects.toMatchObject({ status: 410 });
    await s.sync();
    expect(s.deleted?.purge_at).toBeGreaterThan(Date.now());
    await s.restore();
    await s.say("back");
    expect(s.state.messages().at(-1)?.body.text).toBe("back");
  });
});
