import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../src");

describe("Wallet Demo: Security Boundary Checks", () => {
  it("contains no hardcoded private keys or secret seeds in src/", () => {
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");

      // Check for base58 private key patterns (88+ chars) or Uint8Array keypair literals
      assert.doesNotMatch(
        content,
        /\[\s*([0-9]{1,3}\s*,\s*){31,63}[0-9]{1,3}\s*\]/,
        `File ${file} contains a raw byte array literal that looks like a keypair`
      );

      assert.doesNotMatch(
        content,
        /secretKey|privateKey/i,
        `File ${file} references secretKey or privateKey`
      );
    }
  });

  it("does not write ephemeral keys to localStorage or sessionStorage", () => {
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      assert.doesNotMatch(
        content,
        /(?:window\s*\.\s*)?(?:localStorage|sessionStorage)\s*\./,
        `File ${file} uses browser storage which could leak key material`
      );
    }
  });

  it("uses devnet RPC as default endpoint and specifies devnet cluster explicitly", () => {
    const clusterGateContent = fs.readFileSync(path.join(srcDir, "cluster-gate.ts"), "utf8");
    assert.match(
      clusterGateContent,
      /https:\/\/api\.devnet\.solana\.com/,
      "cluster-gate.ts must default to devnet RPC"
    );
    assert.doesNotMatch(
      clusterGateContent,
      /api\.mainnet-beta\.solana\.com/,
      "cluster-gate.ts must not contain mainnet RPC"
    );
  });
});
