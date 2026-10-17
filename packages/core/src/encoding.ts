const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_INDEX = new Map([...B64U].map((c, i) => [c, i]));

export function b64u(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64U[n >> 18] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64U[n >> 18] + B64U[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64U[n >> 18] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63];
  }
  return out;
}

export function fromB64u(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("invalid base64url length");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = B64U_INDEX.get(c);
    if (v === undefined) throw new Error("invalid base64url character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function isB64u(text: string, bytes: number): boolean {
  if (typeof text !== "string" || text.length !== Math.ceil((bytes * 4) / 3)) return false;
  try {
    return fromB64u(text).length === bytes;
  } catch {
    return false;
  }
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) throw new Error("invalid hex");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

/** Joins byte strings with a 0x00 separator, as used in signature and AAD layouts. */
export function joinZero(...parts: Uint8Array[]): Uint8Array {
  const withSeparators: Uint8Array[] = [];
  parts.forEach((p, i) => {
    if (i > 0) withSeparators.push(new Uint8Array([0]));
    withSeparators.push(p);
  });
  return concat(...withSeparators);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
