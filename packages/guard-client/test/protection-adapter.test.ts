/**
 * The protected-asset resolver, over the REAL mainnet mint accounts.
 *
 * The invariant under test: unknown protection semantics never become
 * permission. An asset is only classified NOT_PROTECTED when it has been
 * positively read and placed outside EquityGuard's universe.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Address } from "@solana/kit";

import {
  KNOWN_PROTECTED_ASSETS,
  PROTECTED_STATE_MODEL,
  findKnownProtectedAsset,
  resolveProtectionAdapter,
  type KnownProtectedAsset,
} from "../src/index.ts";
import { TOKEN_2022, mainnetMint } from "./fixtures.ts";

const LEGACY_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const UNKNOWN_MINT = "So11111111111111111111111111111111111111112" as Address;

/** A minimal initialized mint with no extensions. */
function baseMintBytes(): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setUint32(0, 1, true);
  data[44] = 6;
  data[45] = 1;
  return data;
}

const resolve = (mint: Address, owner: string, data: Uint8Array, registry?: readonly KnownProtectedAsset[]) =>
  resolveProtectionAdapter({ mint, owner, data, ...(registry ? { registry } : {}) });

test("every known representation decodes under the supported state model", () => {
  assert.equal(KNOWN_PROTECTED_ASSETS.length, 6);
  for (const asset of KNOWN_PROTECTED_ASSETS) {
    const resolution = resolve(asset.mint, TOKEN_2022, mainnetMint(asset.symbol));
    assert.equal(resolution.kind, "SUPPORTED", asset.symbol);
    if (resolution.kind !== "SUPPORTED") continue;
    assert.equal(resolution.stateModel, PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT);
    assert.equal(resolution.knownAsset?.symbol, asset.symbol);
    assert.equal(resolution.state.multiplier.length, 8);
  }
});

test("both issuers are represented, and each entry cites chain evidence", () => {
  const issuers = new Set(KNOWN_PROTECTED_ASSETS.map((a) => a.issuer));
  assert.deepEqual([...issuers].sort(), ["Ondo", "xStocks"]);
  for (const asset of KNOWN_PROTECTED_ASSETS) {
    assert.match(asset.evidence, /slot 446827429/, asset.symbol);
    assert.equal(asset.stateModel, PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT);
  }
});

test("an unlisted mint presenting the supported model is protected on its own merits", () => {
  // This is what devnet test mints and any future xStock rely on: the registry
  // is not an allowlist.
  const resolution = resolve(UNKNOWN_MINT, TOKEN_2022, mainnetMint("KOx"));
  assert.equal(resolution.kind, "SUPPORTED");
  assert.equal(resolution.kind === "SUPPORTED" && resolution.knownAsset, null);
});

test("ordinary assets are positively classified as not protected", () => {
  const legacy = resolve(UNKNOWN_MINT, LEGACY_TOKEN_PROGRAM, baseMintBytes());
  assert.deepEqual(legacy, { kind: "NOT_PROTECTED", reason: "NOT_TOKEN_2022" });

  const plain = resolve(UNKNOWN_MINT, TOKEN_2022, baseMintBytes());
  assert.deepEqual(plain, { kind: "NOT_PROTECTED", reason: "NO_PROTECTED_STATE_MODEL" });
});

test("a KNOWN representation that stops presenting the model fails closed", () => {
  for (const asset of KNOWN_PROTECTED_ASSETS) {
    // Same bytes that make an unlisted mint "ordinary" must not make a known
    // tokenized equity ordinary.
    const noExtension = resolve(asset.mint, TOKEN_2022, baseMintBytes());
    assert.equal(noExtension.kind, "KNOWN_PROTECTED_UNSUPPORTED", asset.symbol);
    assert.equal(noExtension.kind === "KNOWN_PROTECTED_UNSUPPORTED" && noExtension.reason, "NO_SUPPORTED_STATE_ADAPTER");

    const notToken2022 = resolve(asset.mint, LEGACY_TOKEN_PROGRAM, baseMintBytes());
    assert.equal(notToken2022.kind, "KNOWN_PROTECTED_UNSUPPORTED", asset.symbol);
  }
});

test("a known asset whose declared state model is not implemented fails closed", () => {
  const future: KnownProtectedAsset = {
    mint: UNKNOWN_MINT,
    symbol: "FUTUREx",
    issuer: "xStocks",
    underlying: "FUTURE",
    stateModel: "TOKEN_2022_SOME_FUTURE_MODEL",
    evidence: "test-only registry entry",
  };
  // Even with a perfectly decodable ScaledUiAmount account, a declared model
  // this client does not implement is a refusal, not a silent downgrade.
  const resolution = resolve(UNKNOWN_MINT, TOKEN_2022, mainnetMint("KOx"), [future]);
  assert.equal(resolution.kind, "KNOWN_PROTECTED_UNSUPPORTED");
  assert.equal(resolution.kind === "KNOWN_PROTECTED_UNSUPPORTED" && resolution.reason, "UNSUPPORTED_STATE_MODEL");
});

test("an unreadable Token-2022 account is INVALID_STATE, never NOT_PROTECTED", () => {
  const broken = mainnetMint("KOx").slice();
  broken[45] = 0; // is_initialized = false
  for (const mint of [UNKNOWN_MINT, KNOWN_PROTECTED_ASSETS[0]?.mint as Address]) {
    const resolution = resolve(mint, TOKEN_2022, broken);
    assert.equal(resolution.kind, "INVALID_STATE");
    assert.equal(resolution.kind === "INVALID_STATE" && resolution.errorCode, "InvalidMintData");
  }
});

test("findKnownProtectedAsset matches by mint only", () => {
  assert.equal(findKnownProtectedAsset("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ")?.symbol, "KOx");
  assert.equal(findKnownProtectedAsset(UNKNOWN_MINT), null);
});
