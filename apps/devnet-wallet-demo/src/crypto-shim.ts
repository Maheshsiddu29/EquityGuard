/**
 * Browser-compatible replacement for `node:crypto` used by
 * `@equityguard/guard-client`'s downstream commitment and deployment
 * verification. Only the SHA-256 `createHash` pattern is implemented.
 *
 * esbuild replaces `import { createHash } from "node:crypto"` with this
 * module at bundle time via `--alias:node:crypto=...`. The same SHA-256
 * algorithm runs; only the implementation backend changes (OpenSSL → pure JS).
 *
 * Uses `@noble/hashes/sha2` which is already in node_modules via @solana/kit.
 */

import { sha256 } from "@noble/hashes/sha2.js";

interface HashLike {
  update(data: Uint8Array | string): HashLike;
  digest(encoding?: string): Uint8Array | string;
}

/**
 * Minimal `createHash('sha256')` compatible with the guard-client's usage:
 *   `createHash("sha256").update(bytes).digest()`       → Uint8Array
 *   `createHash("sha256").update(bytes).digest("hex")`  → hex string
 */
export function createHash(algorithm: string): HashLike {
  if (algorithm !== "sha256") {
    throw new Error(`crypto-shim: only sha256 is supported, got ${algorithm}`);
  }
  let accumulated: Uint8Array | null = null;

  const hash: HashLike = {
    update(data: Uint8Array | string): HashLike {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (accumulated === null) {
        accumulated = bytes;
      } else {
        const merged = new Uint8Array(accumulated.length + bytes.length);
        merged.set(accumulated);
        merged.set(bytes, accumulated.length);
        accumulated = merged;
      }
      return hash;
    },
    digest(encoding?: string): Uint8Array | string {
      const result = sha256(accumulated ?? new Uint8Array(0));
      if (encoding === "hex") {
        return Array.from(result)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
      return result;
    },
  };
  return hash;
}
