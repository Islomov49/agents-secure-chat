// Generates test-vectors/vectors.json (PROTOCOL.md). Deterministic: fixed seeds, nonces and timestamps.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  b64u,
  deriveRoom,
  encodeKey,
  encryptFile,
  hex,
  identityFromSeed,
  linkFor,
  padme,
  sealEvent,
  signRequest,
  utf8,
} from "../src/index.js";

const bytes = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

const secrets = [bytes(32, (i) => i), bytes(32, (i) => 255 - i * 7), bytes(32, () => 0x42)];

const room = secrets.map((secret) => {
  const keys = deriveRoom(secret);
  const key = encodeKey(secret);
  return {
    secret_hex: hex(secret),
    key,
    link: linkFor("https://lincor.dev", key),
    k_enc_hex: hex(keys.kEnc),
    auth_seed_hex: hex(keys.auth.seed),
    auth_pub_b64u: b64u(keys.auth.pub),
    room_id: keys.roomId,
    shape_hex: hex(keys.shape),
  };
});

const participantSeeds = [bytes(32, (i) => i * 3 + 1), bytes(32, (i) => 200 - i)];
const participant = participantSeeds.map((seed) => {
  const id = identityFromSeed(seed);
  return { seed_hex: hex(seed), pub_b64u: b64u(id.pub), participant_id: id.id };
});

const requestCases = [
  { method: "GET", target: "/events?after=0&limit=500", body: "" },
  { method: "POST", target: "/events", body: '{"cid":"AAAAAAAAAAAAAAAAAAAAAA","sender":"AAAAAAAAAAAAAAAAAAAAAA","data":"x"}' },
  { method: "DELETE", target: "", body: "" },
];
const request = requestCases.map((c, i) => {
  const keys = deriveRoom(secrets[i % secrets.length]);
  const target = `/api/v1/rooms/${keys.roomId}${c.target}`;
  const ts = 1760000000000 + i;
  const nonce = b64u(bytes(16, (j) => j + i));
  const signed = signRequest(keys, c.method, target, utf8(c.body), { ts, nonce });
  return {
    auth_seed_hex: hex(keys.auth.seed),
    auth_pub_b64u: b64u(keys.auth.pub),
    room_id: keys.roomId,
    method: c.method,
    target,
    body_utf8: c.body,
    ts: String(ts),
    nonce,
    message_hex: hex(signed.message),
    sig_b64u: signed.headers["X-Lincor-Sig"],
  };
});

const eventKeys = deriveRoom(secrets[0]);
const author = identityFromSeed(participantSeeds[0]);
const event = [
  sealEvent(eventKeys, author, "message", { text: "@unity hello", mentions: ["unity"] }, {
    cid: b64u(bytes(16, (i) => i)),
    ts: 1760000000000,
    nonce: bytes(24, (i) => i * 5),
  }),
].map((env) => ({ secret_hex: hex(secrets[0]), participant_seed_hex: hex(participantSeeds[0]), ...env }));

const filePlain = utf8("lincor file vector ".repeat(5000));
const encrypted = encryptFile(filePlain, { key: bytes(32, (i) => i + 9), np: bytes(16, (i) => 100 + i) });
const file = [{ plaintext_len: filePlain.length, plaintext_sha256: encrypted.meta.sha256, ...encrypted.meta, blob_len: encrypted.blob.length, blob_sha256: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encrypted.blob as BufferSource))) }];

const padmeVectors = [0, 1, 2, 3, 100, 1000, 4096, 65552, 1048576, 10485760 + 2560].map((l) => ({ length: l, padded: padme(l) }));

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test-vectors/vectors.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ protocol: "lincor/v1", room, participant, request, event, file, padme: padmeVectors }, null, 2) + "\n");
console.log(`wrote ${out}`);
