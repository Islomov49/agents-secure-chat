import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentPrompt,
  inviteText,
  b64u,
  base58,
  decodeKey,
  displayId,
  matchesId,
  decryptFile,
  deriveRoom,
  encodeKey,
  encryptFile,
  extractMentions,
  FileIntegrityError,
  fromB64u,
  fromBase58,
  hex,
  identityFromSeed,
  LinkError,
  linkFor,
  newIdentity,
  newSecret,
  openEvent,
  padme,
  parseLink,
  RoomState,
  roomIdForAuthPub,
  sealEvent,
  signRequest,
  utf8,
  verify,
  type RoomEvent,
} from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../test-vectors/vectors.json", import.meta.url), "utf8"));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe("encoding", () => {
  it("round-trips base64url and base58 for every length", () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(fromB64u(b64u(bytes))).toEqual(bytes);
      expect(fromBase58(base58(bytes))).toEqual(bytes);
    }
    const zeros = new Uint8Array([0, 0, 7]);
    expect(base58(zeros).startsWith("11")).toBe(true);
    expect(fromBase58(base58(zeros))).toEqual(zeros);
  });

  it("rejects characters outside base58", () => {
    expect(fromBase58("0OIl")).toBeNull();
  });
});

describe("room links", () => {
  it("encodes a 32-byte secret into a ~50-char key and back", () => {
    const secret = newSecret();
    const key = encodeKey(secret);
    expect(key.length).toBeGreaterThanOrEqual(48);
    expect(key.length).toBeLessThanOrEqual(51);
    expect(decodeKey(key)).toEqual(secret);
  });

  it("parses full links and bare keys", () => {
    const secret = newSecret();
    const key = encodeKey(secret);
    const parsed = parseLink(`  ${linkFor("http://127.0.0.1:8080/", key)} `);
    expect(parsed.origin).toBe("http://127.0.0.1:8080");
    expect(parsed.secret).toEqual(secret);
    expect(parseLink(key, "https://self.example").origin).toBe("https://self.example");
    expect(parseLink(`'${linkFor("https://agents-room.cc", key)}'`).key).toBe(key);
  });

  it("detects damaged, truncated and keyless links", () => {
    const key = encodeKey(newSecret());
    const flipped = key.slice(0, 10) + (key[10] === "a" ? "b" : "a") + key.slice(11);
    expect(() => parseLink(`https://agents-room.cc/r#${flipped}`)).toThrow(LinkError);
    expect(() => parseLink(`https://agents-room.cc/r#${key.slice(0, 30)}`)).toThrow(/incomplete|damaged/);
    expect(() => parseLink("https://agents-room.cc/r")).toThrow(/after #/);
    expect(() => parseLink("https://agents-room.cc/r#")).toThrow(/after #/);
  });

  it("matches the published test vectors", () => {
    for (const v of vectors.room) {
      const secret = fromHex(v.secret_hex);
      const keys = deriveRoom(secret);
      expect(encodeKey(secret)).toBe(v.key);
      expect(hex(keys.kEnc)).toBe(v.k_enc_hex);
      expect(b64u(keys.auth.pub)).toBe(v.auth_pub_b64u);
      expect(keys.roomId).toBe(v.room_id);
      expect(roomIdForAuthPub(keys.auth.pub)).toBe(v.room_id);
      expect(hex(keys.shape)).toBe(v.shape_hex);
    }
    for (const v of vectors.participant) {
      expect(identityFromSeed(fromHex(v.seed_hex)).id).toBe(v.participant_id);
    }
  });

  it("keeps the content key independent from what the server sees", () => {
    const keys = deriveRoom(newSecret());
    expect(hex(keys.kEnc)).not.toBe(hex(keys.auth.seed));
    expect(keys.roomId).not.toContain(b64u(keys.kEnc).slice(0, 8));
  });
});

describe("signed requests", () => {
  it("reproduces the request vectors and verifies", () => {
    for (const v of vectors.request) {
      const roomVector = vectors.room.find((r: { auth_seed_hex: string }) => r.auth_seed_hex === v.auth_seed_hex);
      const keys = deriveRoom(fromHex(roomVector.secret_hex));
      const signed = signRequest(keys, v.method, v.target, utf8(v.body_utf8), { ts: Number(v.ts), nonce: v.nonce });
      expect(hex(signed.message)).toBe(v.message_hex);
      expect(signed.headers["X-Lincor-Sig"]).toBe(v.sig_b64u);
      expect(verify(keys.auth.pub, signed.message, fromB64u(v.sig_b64u))).toBe(true);
    }
  });
});

describe("events", () => {
  const keys = deriveRoom(newSecret());
  const alice = newIdentity();
  const stored = (env: { cid: string; sender: string; data: string }, seq = 1) => ({ ...env, seq, ts: 1 });

  it("seals and opens a message", () => {
    const env = sealEvent(keys, alice, "message", { text: "hi @unity", mentions: ["unity"] });
    const opened = openEvent(keys, stored(env));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.event.type).toBe("message");
      expect(opened.event.sender).toBe(alice.id);
      expect(opened.event.body).toEqual({ text: "hi @unity", mentions: ["unity"] });
    }
  });

  it("opens the published event vector", () => {
    const v = vectors.event[0];
    const opened = openEvent(deriveRoom(fromHex(v.secret_hex)), { cid: v.cid, sender: v.sender, data: v.data, seq: 1, ts: 1 });
    expect(opened.ok && opened.event.body).toEqual({ text: "@unity hello", mentions: ["unity"] });
  });

  it("rejects tampering, wrong keys and impersonation", () => {
    const env = sealEvent(keys, alice, "message", { text: "pay to account 1" });
    const mallory = newIdentity();
    expect(openEvent(deriveRoom(newSecret()), stored(env))).toEqual({ ok: false, reason: "decrypt" });
    expect(openEvent(keys, stored({ ...env, sender: mallory.id }))).toEqual({ ok: false, reason: "decrypt" });
    expect(openEvent(keys, stored({ ...env, cid: b64u(new Uint8Array(16)) }))).toEqual({ ok: false, reason: "decrypt" });
    const raw = fromB64u(env.data);
    raw[40] ^= 1;
    expect(openEvent(keys, stored({ ...env, data: b64u(raw) }))).toEqual({ ok: false, reason: "decrypt" });
    expect(openEvent(keys, stored({ ...env, data: "!!" }))).toEqual({ ok: false, reason: "envelope" });
  });

  it("rejects a room member who signs with a key that does not match the sender id", () => {
    const mallory = newIdentity();
    // Mallory knows the room key but claims Alice's participant id: the signature key cannot match.
    const forged = sealEvent(keys, { ...mallory, id: alice.id }, "message", { text: "I am Alice" });
    expect(openEvent(keys, stored(forged))).toEqual({ ok: false, reason: "sender" });
  });
});

describe("files", () => {
  it("encrypts, pads and decrypts files of many sizes", () => {
    for (const size of [0, 1, 65535, 65536, 65537, 200_000]) {
      const plain = Uint8Array.from({ length: size }, (_, i) => (i * 31) & 0xff);
      const enc = encryptFile(plain);
      expect(enc.blob.length).toBe(padme(size + Math.max(1, Math.ceil(size / 65536)) * 16));
      expect(decryptFile(enc.blob, enc.meta)).toEqual(plain);
    }
  });

  it("detects truncation, chunk reordering and wrong hashes", () => {
    const plain = Uint8Array.from({ length: 140_000 }, (_, i) => i & 0xff);
    const enc = encryptFile(plain);
    expect(() => decryptFile(enc.blob.subarray(0, 65552 * 2), { ...enc.meta, size: 65536 * 2 })).toThrow(FileIntegrityError);
    const swapped = new Uint8Array(enc.blob);
    swapped.set(enc.blob.subarray(65552, 65552 * 2), 0);
    swapped.set(enc.blob.subarray(0, 65552), 65552);
    expect(() => decryptFile(swapped, enc.meta)).toThrow(/authentication/);
    expect(() => decryptFile(enc.blob, { ...enc.meta, sha256: "00".repeat(32) })).toThrow(/hash/);
  });

  it("matches the padme vectors", () => {
    for (const v of vectors.padme) expect(padme(v.length)).toBe(v.padded);
  });
});

describe("mentions and addressing", () => {
  it("extracts mentions", () => {
    expect(extractMentions("@Unity please, cc @backend-team. mail a@b.c @all")).toEqual(["unity", "backend-team", "all"]);
  });

  it("decides what is addressed to whom", () => {
    const keys = deriveRoom(newSecret());
    const fe = newIdentity();
    const unity = newIdentity();
    const state = new RoomState();
    let seq = 0;
    const apply = (id: typeof fe, type: Parameters<typeof sealEvent>[2], body: object): RoomEvent => {
      const opened = openEvent(keys, { ...sealEvent(keys, id, type, body as never), seq: ++seq, ts: seq });
      if (!opened.ok) throw new Error(opened.reason);
      state.apply(opened.event);
      return opened.event;
    };
    apply(fe, "join", { profile: { name: "Ali's frontend agent", role: "frontend", client: "claude-code", kind: "agent" } });
    apply(unity, "join", { profile: { name: "Bobur's Unity agent", role: "unity", client: "codex", kind: "agent" } });
    const task = apply(fe, "task.create", { title: "Emit purchase_completed", assignee: "@unity" });
    expect(state.isAddressedTo(task, unity.id)).toBe(true);
    expect(state.isAddressedTo(task, fe.id)).toBe(false);
    const question = apply(unity, "message", { text: "@frontend ISO code?" });
    expect(state.isAddressedTo(question, fe.id)).toBe(true);
    const answer = apply(fe, "message", { text: "ISO 4217", reply_to: question.cid });
    expect(state.isAddressedTo(answer, unity.id)).toBe(true);
    const done = apply(unity, "task.update", { task: task.cid, status: "done", note: "shipped" });
    expect(state.isAddressedTo(done, fe.id)).toBe(true);
    expect(state.tasks.get(task.cid)?.status).toBe("done");
    expect(state.tasksFor(unity.id).map((t) => t.title)).toEqual(["Emit purchase_completed"]);
    const chatter = apply(fe, "message", { text: "lunch?" });
    expect(state.isAddressedTo(chatter, unity.id)).toBe(false);
    const all = apply(fe, "message", { text: "@all deploy at 5" });
    expect(state.isAddressedTo(all, unity.id)).toBe(true);
    apply(fe, "artifact.put", { name: "event-schema", content: "{}" });
    apply(unity, "artifact.put", { name: "event-schema", content: "{\"v\":2}" });
    expect(state.artifacts.get("event-schema")?.versions.map((v) => v.version)).toEqual([1, 2]);
    const rename = apply(fe, "room.meta", { name: "Checkout v2" });
    expect(state.isAddressedTo(rename, unity.id)).toBe(false);
    const about = apply(fe, "room.meta", { description: "Checkout v2: purchase events. Contracts in event-schema." });
    expect(state.isAddressedTo(about, unity.id)).toBe(true);
    expect(state.isAddressedTo(about, fe.id)).toBe(false);
    expect(state.meta).toMatchObject({ name: "Checkout v2", description: "Checkout v2: purchase events. Contracts in event-schema.", descriptionBy: fe.id, descriptionTs: about.ts });
  });
});

describe("invite and agent prompt", () => {
  it("are the user's own words with the approvals given up front, and the exact CLI to run", () => {
    const link = "https://agents-room.cc/r#3uS21qWxeAVCuP4FSm1RK2TEipYwnKh6zbbUKED9XDPoXVKPpB";
    const prompt = agentPrompt(link, "npx -y agents-room@1.2.3");
    const lines = prompt.split("\n");
    expect(lines[0]).toBe(`Set up Agents secure chat in this session and keep it connected to this room: ${link}`);
    expect(lines).toContain("I confirm all of this, no need to ask me:");
    expect(prompt).toContain("1. Run the agents-room CLI (npx -y agents-room@1.2.3) from this project's folder");
    expect(prompt).toContain("3. Keep listening in the background, and install the agents-room integration if it is missing");
    expect(lines.at(-1)).toBe("Ask me first only before changing code, sharing files or telling the room anything about my other work.");
    expect(prompt.split(link)).toHaveLength(2);
    expect(inviteText(link, "npx -y agents-room@1.2.3")).toBe(`Paste this whole message into Claude Code or Codex:\n\n${prompt}`);
    expect(agentPrompt(link)).toContain("(npx -y agents-room)");
  });
});

describe("display ids", () => {
  it("are 8 hex characters, never start with '-', and resolve back", () => {
    const cid = b64u(Uint8Array.from([0xf8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 8, 9, 10, 11, 12, 13, 14, 15]));
    expect(cid.startsWith("-")).toBe(true);
    expect(displayId(cid)).toBe("f8010203");
    expect(matchesId(cid, "f8010203")).toBe(true);
    expect(matchesId(cid, "F801")).toBe(true);
    expect(matchesId(cid, cid.slice(0, 6))).toBe(true);
    expect(matchesId(cid, "f9")).toBe(false);
    expect(matchesId(cid, "")).toBe(false);
  });
});
