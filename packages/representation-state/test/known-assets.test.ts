/**
 * The guard client's protected-asset registry and the representation registry
 * describe the same six mainnet representations.
 *
 * They are separate on purpose — the guard client cannot depend on the
 * representation layer — so this test is what stops them drifting. A
 * representation missing from the guard client's registry would be classified
 * as an ordinary token if it ever stopped presenting its state model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { KNOWN_PROTECTED_ASSETS, findKnownProtectedAsset } from "@equityguard/guard-client";

import { findRepresentationByMint, listUnderlyings } from "../src/index.ts";

const representations = listUnderlyings().flatMap((underlying) => underlying.representations);

test("every registry representation is a known protected asset of the guard client", () => {
  assert.ok(representations.length > 0);
  for (const representation of representations) {
    const known = findKnownProtectedAsset(representation.mint);
    assert.ok(known, `${representation.symbol} is missing from KNOWN_PROTECTED_ASSETS`);
    assert.equal(known.symbol, representation.symbol);
    assert.equal(known.issuer, representation.issuer);
    assert.equal(known.underlying, representation.underlying);
  }
});

test("the guard client claims no protected asset the registry does not know", () => {
  for (const asset of KNOWN_PROTECTED_ASSETS) {
    const representation = findRepresentationByMint(asset.mint);
    assert.ok(representation, `${asset.symbol} is not a registry representation`);
    assert.equal(representation.symbol, asset.symbol);
    assert.equal(representation.issuer, asset.issuer);
  }
  assert.equal(KNOWN_PROTECTED_ASSETS.length, representations.length);
});
