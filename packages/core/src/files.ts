import { open, randomBytes, seal, sha256 } from "./crypto.js";
import { b64u, concat, fromB64u, hex, u64be, utf8 } from "./encoding.js";
import type { FileBody } from "./events.js";

export const CHUNK_SIZE = 65536;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TAG = 16;

/** Padmé padding (PROTOCOL §7): leaks O(log log L) bits of the length, overhead ≤ 12 %. */
export function padme(length: number): number {
  if (length < 2) return length;
  const e = Math.floor(Math.log2(length));
  const s = Math.floor(Math.log2(e)) + 1;
  const z = e - s;
  const mask = 2 ** z - 1;
  return Math.floor((length + mask) / (mask + 1)) * (mask + 1);
}

const chunkAad = (final: boolean) => concat(utf8("lincor/v1/file"), new Uint8Array([0, final ? 1 : 0]));
const chunkNonce = (np: Uint8Array, i: number) => concat(np, u64be(i));
const chunkCount = (size: number, cs: number) => Math.max(1, Math.ceil(size / cs));

export interface EncryptedFile {
  blob: Uint8Array;
  /** Event body fields except `blob` id, `name` and `mime`. */
  meta: Pick<FileBody, "size" | "sha256" | "key" | "np" | "cs">;
}

export interface EncryptOptions {
  /** Only for deterministic test vectors. */
  key?: Uint8Array;
  np?: Uint8Array;
}

export function encryptFile(plaintext: Uint8Array, options: EncryptOptions = {}): EncryptedFile {
  if (plaintext.length > MAX_FILE_BYTES) throw new Error(`files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
  const key = options.key ?? randomBytes(32);
  const np = options.np ?? randomBytes(16);
  const n = chunkCount(plaintext.length, CHUNK_SIZE);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const chunk = plaintext.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    parts.push(seal(key, chunkNonce(np, i), chunk, chunkAad(i === n - 1)));
  }
  const ciphertext = concat(...parts);
  const blob = new Uint8Array(padme(ciphertext.length));
  blob.set(ciphertext);
  return {
    blob,
    meta: { size: plaintext.length, sha256: hex(sha256(plaintext)), key: b64u(key), np: b64u(np), cs: CHUNK_SIZE },
  };
}

export class FileIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileIntegrityError";
  }
}

export function decryptFile(blob: Uint8Array, meta: Pick<FileBody, "size" | "sha256" | "key" | "np" | "cs">): Uint8Array {
  const key = fromB64u(meta.key);
  const np = fromB64u(meta.np);
  const cs = meta.cs;
  if (key.length !== 32 || np.length !== 16 || !Number.isInteger(cs) || cs <= 0 || cs > 1 << 24) {
    throw new FileIntegrityError("file metadata is invalid");
  }
  const n = chunkCount(meta.size, cs);
  const expected = meta.size + n * TAG;
  if (blob.length < expected) throw new FileIntegrityError("file is truncated");
  const out = new Uint8Array(meta.size);
  let offset = 0;
  for (let i = 0; i < n; i++) {
    const plainLen = i === n - 1 ? meta.size - i * cs : cs;
    const ct = blob.subarray(offset, offset + plainLen + TAG);
    const chunk = open(key, chunkNonce(np, i), ct, chunkAad(i === n - 1));
    if (!chunk) throw new FileIntegrityError(`file chunk ${i} failed authentication`);
    out.set(chunk, i * cs);
    offset += plainLen + TAG;
  }
  if (hex(sha256(out)) !== meta.sha256) throw new FileIntegrityError("file hash mismatch");
  return out;
}

export const newBlobId = (): string => b64u(randomBytes(16));
