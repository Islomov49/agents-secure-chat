import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { utf8 } from "./encoding.js";

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data);

export const randomBytes = (n: number): Uint8Array => nobleRandomBytes(n);

/** HKDF-SHA256 with the protocol salt "lincor/v1" and a 32-byte output (PROTOCOL §1). */
export const deriveKey = (ikm: Uint8Array, label: string): Uint8Array =>
  hkdf(nobleSha256, ikm, utf8("lincor/v1"), utf8(label), 32);

export interface SigningKey {
  seed: Uint8Array;
  pub: Uint8Array;
}

export function signingKeyFromSeed(seed: Uint8Array): SigningKey {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  return { seed, pub: ed25519.getPublicKey(seed) };
}

export const sign = (key: SigningKey, message: Uint8Array): Uint8Array => ed25519.sign(message, key.seed);

export function verify(pub: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, pub);
  } catch {
    return false;
  }
}

export const seal = (key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array =>
  xchacha20poly1305(key, nonce, aad).encrypt(plaintext);

/** Returns null when the tag does not verify. */
export function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    return null;
  }
}
