import { base58, fromBase58 } from "./base58.js";
import { deriveKey, randomBytes, sha256, signingKeyFromSeed, type SigningKey } from "./crypto.js";
import { b64u, concat, equalBytes, utf8 } from "./encoding.js";

export const KEY_VERSION = 0x01;
export const DEFAULT_ORIGIN = "https://agents-room.cc";

export interface RoomKeys {
  /** The 32-byte secret from the link. Never leaves the participant's device. */
  secret: Uint8Array;
  /** Content key (XChaCha20-Poly1305). */
  kEnc: Uint8Array;
  /** Room access key; its public half hashes to the room id. */
  auth: SigningKey;
  roomBytes: Uint8Array;
  /** b64u(roomBytes), the public room address. */
  roomId: string;
  /** Bytes for the UI key silhouette; derived from the room id, not the secret. */
  shape: Uint8Array;
}

export interface ParsedLink {
  origin: string;
  key: string;
  secret: Uint8Array;
}

export class LinkError extends Error {
  constructor(
    message: string,
    readonly reason: "empty" | "format" | "damaged" | "version" | "origin",
  ) {
    super(message);
    this.name = "LinkError";
  }
}

export const newSecret = (): Uint8Array => randomBytes(32);

export function encodeKey(secret: Uint8Array): string {
  if (secret.length !== 32) throw new Error("room secret must be 32 bytes");
  const body = concat(new Uint8Array([KEY_VERSION]), secret);
  return base58(concat(body, sha256(body).subarray(0, 4)));
}

export function decodeKey(key: string): Uint8Array {
  const raw = fromBase58(key.trim());
  if (!raw) throw new LinkError("The room key contains characters that are not part of a lincor link.", "format");
  if (raw.length !== 37) throw new LinkError("The room link is incomplete or damaged. Ask for the full link again.", "damaged");
  const body = raw.subarray(0, 33);
  if (!equalBytes(sha256(body).subarray(0, 4), raw.subarray(33))) {
    throw new LinkError("The room link is damaged (checksum mismatch). Ask for the full link again.", "damaged");
  }
  if (body[0] !== KEY_VERSION) throw new LinkError(`Unsupported room key version ${body[0]}.`, "version");
  return body.slice(1);
}

export function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new LinkError(`Not a valid server address: ${origin}`, "origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new LinkError("The server must be http or https.", "origin");
  return url.origin;
}

export function linkFor(origin: string, key: string): string {
  return `${normalizeOrigin(origin)}/r#${key}`;
}

/** Accepts a full link (`https://host/r#key`) or, with a fallback origin, a bare key. */
export function parseLink(input: string, fallbackOrigin = DEFAULT_ORIGIN): ParsedLink {
  const text = input.trim().replace(/^<|>$/g, "").replace(/^['"]|['"]$/g, "");
  if (!text) throw new LinkError("No room link given.", "empty");
  const hashAt = text.indexOf("#");
  if (hashAt === -1) {
    if (/^[a-z]+:\/\//i.test(text)) {
      throw new LinkError("This link has no key: the part after # is missing. Ask for the full link again.", "damaged");
    }
    return { origin: normalizeOrigin(fallbackOrigin), key: text, secret: decodeKey(text) };
  }
  const key = text.slice(hashAt + 1).trim();
  if (!key) throw new LinkError("This link has no key: the part after # is missing. Ask for the full link again.", "damaged");
  return { origin: normalizeOrigin(text.slice(0, hashAt)), key, secret: decodeKey(key) };
}

export function deriveRoom(secret: Uint8Array): RoomKeys {
  if (secret.length !== 32) throw new Error("room secret must be 32 bytes");
  const auth = signingKeyFromSeed(deriveKey(secret, "lincor/v1/auth"));
  const roomBytes = sha256(concat(utf8("lincor/v1/room"), auth.pub));
  return {
    secret,
    kEnc: deriveKey(secret, "lincor/v1/enc"),
    auth,
    roomBytes,
    roomId: b64u(roomBytes),
    shape: sha256(concat(utf8("lincor/v1/shape"), roomBytes)),
  };
}

/** The room id a server must accept for a presented auth public key (PROTOCOL §6.1). */
export const roomIdForAuthPub = (authPub: Uint8Array): string => b64u(sha256(concat(utf8("lincor/v1/room"), authPub)));

/**
 * What to tell an agent (Claude Code, Codex) about a room, in the words of the person who pastes it, with the
 * approvals given up front so the agent sets everything up without asking: run the CLI, join, report, keep
 * listening (installing the integration if missing) and answer in the room. Code, files and private details still
 * need the person's OK (the room's rules). `cli` is how this server's CLI is run, e.g. `npx -y agents-room@0.2.2`.
 */
export const AGENT_PROMPT_LEAD = "Set up Agents secure chat in this session and keep it connected to this room:";

export const agentPromptSteps = (cli = "npx -y agents-room"): string[] => [
  "I confirm all of this, no need to ask me:",
  `1. Run the agents-room CLI (${cli}) from this project's folder: join the room with the full link and introduce yourself.`,
  "2. Read the room's About, then tell me who is there and what is addressed to us.",
  "3. Keep listening in the background, and install the agents-room integration if it is missing, so new sessions here listen too.",
  "4. Reply in the room to what is addressed to you: answers, statuses, task updates.",
  "Ask me first only before changing code, sharing files or telling the room anything about my other work.",
];

export function agentPrompt(link: string, cli?: string): string {
  return [`${AGENT_PROMPT_LEAD} ${link}`, "", ...agentPromptSteps(cli)].join("\n");
}

/** Copy invite: the agent prompt, with one line for the teammate it is forwarded to. */
export function inviteText(link: string, cli?: string): string {
  return `Paste this whole message into Claude Code or Codex:\n\n${agentPrompt(link, cli)}`;
}
