import { randomBytes, sha256, signingKeyFromSeed, type SigningKey } from "./crypto.js";
import { b64u, concat, fromB64u, hex, utf8 } from "./encoding.js";

export interface Identity extends SigningKey {
  /** Opaque participant id the server sees as `sender`. */
  id: string;
}

export const participantIdFor = (pub: Uint8Array): string =>
  b64u(sha256(concat(utf8("lincor/v1/participant"), pub)).subarray(0, 16));

export function identityFromSeed(seed: Uint8Array): Identity {
  const key = signingKeyFromSeed(seed);
  return { ...key, id: participantIdFor(key.pub) };
}

export const newIdentity = (): Identity => identityFromSeed(randomBytes(32));

/** Short, human-comparable fingerprint of a participant (6 hex characters); also an @handle. */
export const shortId = (participantId: string): string => displayId(participantId).slice(0, 6);

/**
 * Short id shown to agents and people for an event (message, task, file): 8 hex characters.
 * Hex, unlike base64url, never starts with "-", so it is safe as a command-line argument.
 */
export function displayId(cid: string): string {
  try {
    return hex(fromB64u(cid)).slice(0, 8);
  } catch {
    return cid.slice(0, 8);
  }
}

/** Whether user input (a display id, a hex prefix or a base64url prefix of the cid) refers to `cid`. */
export function matchesId(cid: string, input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (cid.startsWith(text)) return true;
  return /^[0-9a-f]+$/i.test(text) && displayIdFull(cid).startsWith(text.toLowerCase());
}

const displayIdFull = (cid: string): string => {
  try {
    return hex(fromB64u(cid));
  } catch {
    return "";
  }
};
