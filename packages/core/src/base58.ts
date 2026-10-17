const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Returns null for any character outside the Bitcoin base58 alphabet. */
export function fromBase58(text: string): Uint8Array | null {
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
