import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ActivationPhase } from "../../../packages/guard-client/src/index.ts";
import { writeFabricatedUsdcAta } from "../../../scripts/replay/local-user-accounts.ts";
import { expectationView, loadKoxTradeEvidence } from "../../../scripts/demo/kox-trade-evidence.ts";
import {
  EXPECTED_IN_AMOUNT,
  EXPECTED_KOX_BASELINE,
  EXPECTED_OUT_AMOUNT,
  EXPECTED_PHANTOM,
  EXPECTED_PHANTOM_KOX_ATA,
  EXPECTED_PHANTOM_USDC_ATA,
  EXPECTED_USDC_BASELINE,
  KOX_DECIMALS,
  REFRESHED_AUTHORIZATION_SOURCE,
  STALE_AUTHORIZATION_SOURCE,
  formatKox,
  formatUsdc,
  skipPreflightAllowed,
} from "../src/local-funding.ts";
import { assertDeterministicBaseline } from "../src/replay-execution.ts";
import { expectationFromRecordedAuthorization } from "../src/replay-model.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;

test("local USDC fabrication is deterministic and does not copy the original taker ATA", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phantom-usdc-"));
  const first = await writeFabricatedUsdcAta(EXPECTED_PHANTOM, EXPECTED_USDC_BASELINE, dir);
  const second = await writeFabricatedUsdcAta(EXPECTED_PHANTOM, EXPECTED_USDC_BASELINE, dir);
  assert.equal(first.ata, EXPECTED_PHANTOM_USDC_ATA);
  assert.equal(first.path, second.path);
  const bytes = Buffer.from(JSON.parse(readFileSync(first.path, "utf8")).account.data[0], "base64");
  assert.equal(bytes.readBigUInt64LE(64), EXPECTED_USDC_BASELINE);
  assert.equal(readdirSync(dir).join(","), `${EXPECTED_PHANTOM_USDC_ATA}.json`);
  assert.notEqual(first.ata, "Bze38ZNYkoKZXBWv7hGfqYkH4KBhAAmUkwPMNqNbzCRp");
});

test("KOx display uses 8 decimals and never renders 5.504261", () => {
  assert.equal(KOX_DECIMALS, 8);
  assert.equal(formatKox(EXPECTED_OUT_AMOUNT), "0.05504261");
  assert.notEqual(formatKox(EXPECTED_OUT_AMOUNT), "5.504261");
  assert.equal(formatUsdc(EXPECTED_IN_AMOUNT), "5.00");
});

test("skipPreflight is allowed only for the expected stale rejection", () => {
  assert.equal(skipPreflightAllowed("SAFE"), false);
  assert.equal(skipPreflightAllowed("REFRESHED"), false);
  assert.equal(skipPreflightAllowed("STALE"), true);
  const source = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/replay-execution.ts"), "utf8");
  assert.match(source, /skipPreflightAllowed\(prepared\.kind\)/);
  assert.doesNotMatch(source, /skipPreflight:\s*true/);
});

test("stale and refreshed expectations come from sealed Sep 15 observations", () => {
  const evidence = loadKoxTradeEvidence();
  assert.equal(evidence.pre.source.slot, 447113427);
  assert.equal(evidence.pre.source.blockTime, 1_789_432_186);
  assert.equal(evidence.post.source.slot, 447113520);
  assert.equal(evidence.post.source.blockTime, 1_789_432_216);
  assert.equal(evidence.pre.expectation.expectedPhase, ActivationPhase.Pending);
  assert.equal(evidence.post.expectation.expectedPhase, ActivationPhase.Activated);
  assert.deepEqual(expectationView(evidence.pre.expectation), {
    multiplierHex: "73833748164bf03f",
    newMultiplierHex: "df525701685cf03f",
    newMultiplierEffectiveTimestamp: "1789432200",
    expectedPhase: ActivationPhase.Pending,
    window: { beforeSecs: 0, afterSecs: 0 },
  });
  const stale = expectationFromRecordedAuthorization(expectationView(evidence.pre.expectation));
  const refreshed = expectationFromRecordedAuthorization(expectationView(evidence.post.expectation));
  assert.equal(stale.expectedPhase, ActivationPhase.Pending);
  assert.equal(refreshed.expectedPhase, ActivationPhase.Activated);
  assert.equal(STALE_AUTHORIZATION_SOURCE, "SEALED_SEP_15_PRE_ACTIVATION_OBSERVATION");
  assert.equal(REFRESHED_AUTHORIZATION_SOURCE, "SEALED_SEP_15_POST_ACTIVATION_OBSERVATION");
  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/replay-execution.ts"), "utf8");
  assert.doesNotMatch(app, /expectedPhase\s*=\s*0/);
  assert.doesNotMatch(app, /scenario\s*=\s*"STALE"/);
});

test("deterministic baseline rejects leftover KOx or empty USDC", () => {
  assert.doesNotThrow(() => assertDeterministicBaseline({ sol: 1_000_000_000n, usdc: EXPECTED_USDC_BASELINE, kox: EXPECTED_KOX_BASELINE }));
  assert.throws(() => assertDeterministicBaseline({ sol: 1_000_000_000n, usdc: 0n, kox: 0n }), /USDC/);
  assert.throws(() => assertDeterministicBaseline({ sol: 1_000_000_000n, usdc: EXPECTED_USDC_BASELINE, kox: 11_008_510n }), /KOx/);
});

test("browser does not silently resubmit after stale rejection", () => {
  const app = readFileSync(join(ROOT, "apps/phantom-local-feasibility/src/app.ts"), "utf8");
  const html = readFileSync(join(ROOT, "apps/phantom-local-feasibility/web/index.html"), "utf8");
  assert.match(html, /Confirm updated order/);
  assert.match(app, /reviewUpdatedOrder/);
  assert.match(app, /confirm-order"\)\.addEventListener\("click", \(\) => void confirmUpdatedOrder\(\)\)/);
  assert.doesNotMatch(app, /reviewUpdatedOrder[\s\S]*submit\(TRADER_CONFIRM_KIND\)/);
  assert.doesNotMatch(html, /Sign SAFE local trade|Sign stale local trade|SAFE result|STALE result|REFRESHED result/);
});

test("no mainnet or devnet submission path exists in the experiment", () => {
  const src = join(ROOT, "apps/phantom-local-feasibility/src");
  const text = readdirSync(src).map((file) => readFileSync(join(src, file), "utf8")).join("\n");
  assert.match(text, /assertLocalRpcUrl/);
  assert.doesNotMatch(text, /api\.mainnet-beta\.solana\.com/);
  assert.doesNotMatch(text, /api\.devnet\.solana\.com/);
  assert.doesNotMatch(text, /signAndSendTransaction\s*\(/);
  assert.equal(EXPECTED_PHANTOM_KOX_ATA.length, 44);
});
