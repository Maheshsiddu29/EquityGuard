/**
 * Synchronous SHA-256 (FIPS 180-4) with no platform dependency, so the state
 * package stays usable outside Node. Round constants are derived exactly with
 * integer roots instead of being transcribed. Used for commitments (digests),
 * never as authentication.
 */

function integerRoot(value: bigint, degree: bigint): bigint {
  // Newton's method on integers: floor(value^(1/degree)).
  let x = 1n << (BigInt(value.toString(2).length) / degree + 1n);
  for (;;) {
    const next = ((degree - 1n) * x + value / x ** (degree - 1n)) / degree;
    if (next >= x) break;
    x = next;
  }
  while (x ** degree > value) x -= 1n;
  while ((x + 1n) ** degree <= value) x += 1n;
  return x;
}

const PRIMES = (() => {
  const out: bigint[] = [];
  for (let n = 2n; out.length < 64; n += 1n) {
    if (out.every((p) => n % p !== 0n)) out.push(n);
  }
  return out;
})();

const MASK_32 = 0xffffffffn;
/** First 32 fractional bits of the cube roots of the first 64 primes. */
const K = Uint32Array.from(PRIMES.map((p) => Number(integerRoot(p << 96n, 3n) & MASK_32)));
/** First 32 fractional bits of the square roots of the first 8 primes. */
const H0 = Uint32Array.from(PRIMES.slice(0, 8).map((p) => Number(integerRoot(p << 64n, 2n) & MASK_32)));

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const blocks = Math.ceil((data.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(data.length) * 8n, false);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = ((h[i] as number) + (add[i] as number)) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i] as number, false);
  return out;
}

export function sha256Hex(text: string): string {
  return Array.from(sha256(new TextEncoder().encode(text)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
