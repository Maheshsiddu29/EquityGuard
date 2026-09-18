/**
 * M11-B simulated market scenarios, built only from REAL observed semantics:
 * KOx's scheduled activation (pending bytes, T = 2026-09-15T00:30:00Z) and
 * KOon's immediate-style update, both as captured on mainnet. Only the clock,
 * the window and the moment of authorization are varied; no new
 * corporate-action model is introduced.
 *
 * Each scenario states the invariant it checks (docs/invariants.md I-1, I-2):
 * a transaction authorized against state S must not execute if the protected
 * state — stored fields and the effective phase — differs at execution, and
 * the SDK must not build what the guard would refuse.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ActivationPhase,
  KNOWN_PROTECTED_ASSETS,
  TOKEN_2022_PROGRAM_ADDRESS,
  checkGuardOffline,
  decodeProtectedState,
  phaseAt,
  resolveProtectionAdapter,
  type EquityGuardErrorName,
  type ProtectedState,
  type ProtectionWindow,
} from "@equityguard/guard-client";

import { evaluateGuard } from "../../packages/guard-client/test/guard-mirror.ts";
import { resolveWireTransaction } from "../../packages/jupiter/src/index.ts";
import { protectJupiterSwap, verifyProtectedSwap, type ProtectJupiterSwapResult } from "../../packages/jupiter/src/protect.ts";
import { KOX_MINT, TAKER, fakeRpc, mainnetMint, recordedBuild, token2022Account } from "../../packages/jupiter/test/protect-fixtures.ts";

const KO = (JSON.parse(readFileSync(new URL("../demo/fixtures/ko-corporate-action-2026-09.json", import.meta.url), "utf8")) as { observations: Record<string, { dataBase64: string; blockTime: number }> }).observations;
const bytesOf = (name: string) => Uint8Array.from(Buffer.from(KO[name]!.dataBase64, "base64"));
const stateOf = (data: Uint8Array) => decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, data);

/** KOx as last observed before T: the new schedule pending. */
const KOX_PENDING = bytesOf("koxLastPendingBeforeT");
const KOX_STATE = stateOf(KOX_PENDING);
const T = KOX_STATE.newMultiplierEffectiveTimestamp;
/** KOx before its schedule was published (committed fixture, slot 446827429). */
const KOX_BEFORE_SCHEDULE = mainnetMint("KOx");
const KOON_PRE = stateOf(bytesOf("koonPreEventLast"));
const KOON_POST = stateOf(bytesOf("koonPostEventFirst"));

const ZERO: ProtectionWindow = { beforeSecs: 0, afterSecs: 0 };
const DEMO: ProtectionWindow = { beforeSecs: 900, afterSecs: 300 };
const U32_MAX = 0xffff_ffff;

/** An authorization is what the SDK would bind at `at`: the state and the phase then. */
function authorize(state: ProtectedState, at: bigint, window: ProtectionWindow) {
  const request = { expected: state, expectedPhase: phaseAt(state, at), window };
  return { request, buildable: checkGuardOffline(request, state, at) === null };
}
const execute = (auth: ReturnType<typeof authorize>, actual: ProtectedState, at: bigint): EquityGuardErrorName | "ok" => checkGuardOffline(auth.request, actual, at) ?? "ok";

async function sdk(mintData: Uint8Array, at: bigint, window: ProtectionWindow, quoted?: { state: ProtectedState; phase: ActivationPhase }): Promise<ProtectJupiterSwapResult> {
  return protectJupiterSwap({
    build: recordedBuild("KOx", "BUY"),
    userPublicKey: TAKER,
    rpc: fakeRpc({ accounts: { [KOX_MINT]: token2022Account(mintData) }, unixTimestamp: at }).rpc,
    protectionWindow: window,
    ...(quoted ? { expectedState: quoted.state, expectedPhase: quoted.phase } : {}),
  });
}

const outcomes: string[] = [];
const record = (scenario: string, outcome: string) => outcomes.push(`${scenario}: ${outcome}`);

test("the real KOx bytes: a scheduled change, pending, identical across T", () => {
  assert.notDeepEqual(KOX_STATE.multiplier, KOX_STATE.newMultiplier);
  assert.equal(T, 1_789_432_200n);
  assert.deepEqual(stateOf(bytesOf("koxActivatedFirstObserved")), KOX_STATE);
  assert.deepEqual(KOON_POST.multiplier, KOON_POST.newMultiplier);
});

test("1. quiet before activation: authorized and executed hours before T", async () => {
  const auth = authorize(KOX_STATE, T - 4n * 3600n, DEMO);
  assert.ok(auth.buildable);
  assert.equal(execute(auth, KOX_STATE, T - 3n * 3600n), "ok");
  assert.equal((await sdk(KOX_PENDING, T - 4n * 3600n, DEMO)).status, "PROTECTED");
  record("1 quiet before activation", "ALLOW (state and phase unchanged, outside window)");
});

test("2. authorization 60 s before T", async () => {
  const refused = await sdk(KOX_PENDING, T - 60n, DEMO);
  assert.equal(refused.status === "ERROR" && refused.code, "INSIDE_TRANSITION_WINDOW");
  // With no window it builds pending, and fails if it lands after T.
  const auth = authorize(KOX_STATE, T - 60n, ZERO);
  assert.ok(auth.buildable);
  assert.equal(execute(auth, KOX_STATE, T - 30n), "ok");
  assert.equal(execute(auth, KOX_STATE, T + 30n), "ActivationPhaseChanged");
  record("2 authorization 60 s before T", "SDK refuses under 900/300; zero-window pending guard allows before T, blocks after T");
});

test("3. authorization 1 s before T", () => {
  const auth = authorize(KOX_STATE, T - 1n, ZERO);
  assert.ok(auth.buildable);
  assert.equal(auth.request.expectedPhase, ActivationPhase.Pending);
  assert.equal(execute(auth, KOX_STATE, T - 1n), "ok");
  assert.equal(execute(auth, KOX_STATE, T), "InsideTransitionWindow");
  assert.equal(execute(auth, KOX_STATE, T + 1n), "ActivationPhaseChanged");
  record("3 authorization 1 s before T", "ALLOW at T-1; BLOCK at T and T+1");
});

test("4. execution exactly at T: nothing builds and nothing executes, for any window", async () => {
  for (const window of [ZERO, DEMO, { beforeSecs: U32_MAX, afterSecs: U32_MAX }]) {
    assert.equal(authorize(KOX_STATE, T, window).buildable, false);
    assert.equal(execute(authorize(KOX_STATE, T - 1n, ZERO), KOX_STATE, T), "InsideTransitionWindow");
    const result = await sdk(KOX_PENDING, T, window);
    assert.equal(result.status === "ERROR" && result.code, "INSIDE_TRANSITION_WINDOW");
  }
  record("4 execution exactly at T", "BLOCK (T is inside every window, including zero width)");
});

test("5. execution 1 s after T", () => {
  const pending = authorize(KOX_STATE, T - 1n, ZERO);
  assert.equal(execute(pending, KOX_STATE, T + 1n), "ActivationPhaseChanged");
  const pendingDemo = authorize(KOX_STATE, T - 901n, DEMO);
  assert.equal(execute(pendingDemo, KOX_STATE, T + 1n), "InsideTransitionWindow");
  const activated = authorize(KOX_STATE, T + 1n, ZERO);
  assert.ok(activated.buildable);
  assert.equal(execute(activated, KOX_STATE, T + 1n), "ok");
  record("5 execution 1 s after T", "BLOCK stale pending guards; ALLOW a guard built after T");
});

test("6. large delay after T", () => {
  const pending = authorize(KOX_STATE, T - 4n * 3600n, DEMO);
  assert.equal(execute(pending, KOX_STATE, T + 86_400n), "ActivationPhaseChanged");
  const activated = authorize(KOX_STATE, T + 2n * 86_400n, DEMO);
  assert.equal(execute(activated, KOX_STATE, T + 3n * 86_400n), "ok");
  record("6 large delay after T", "BLOCK a pre-T guard a day later; ALLOW a post-T guard");
});

test("7. current == new: the clock never matters", () => {
  for (const at of [KOON_POST.newMultiplierEffectiveTimestamp - 1n, KOON_POST.newMultiplierEffectiveTimestamp, KOON_POST.newMultiplierEffectiveTimestamp + 1n]) {
    for (const phase of [ActivationPhase.Pending, ActivationPhase.Activated]) {
      for (const window of [ZERO, DEMO, { beforeSecs: U32_MAX, afterSecs: U32_MAX }]) {
        assert.equal(checkGuardOffline({ expected: KOON_POST, expectedPhase: phase, window }, KOON_POST, at), null);
      }
    }
  }
  record("7 current == new", "ALLOW at T-1, T, T+1, either phase, any window");
});

test("8. immediate-style update: the real KOon change", () => {
  const auth = authorize(KOON_PRE, BigInt(KO.koonPreEventLast!.blockTime), ZERO);
  assert.equal(execute(auth, KOON_POST, BigInt(KO.koonPostEventFirst!.blockTime)), "MultiplierChanged");
  assert.equal(execute(authorize(KOON_POST, BigInt(KO.koonPostEventFirst!.blockTime), ZERO), KOON_POST, BigInt(KO.koonPostEventFirst!.blockTime)), "ok");
  record("8 immediate-style update", "BLOCK the pre-update guard (MultiplierChanged); ALLOW a fresh one");
});

test("9. stale pre-update expectation handed to the SDK", async () => {
  // Quoted before KOx's schedule was published; chain now carries the new schedule.
  const quoted = stateOf(KOX_BEFORE_SCHEDULE);
  const result = await sdk(KOX_PENDING, T - 4n * 3600n, DEMO, { state: quoted, phase: ActivationPhase.Activated });
  assert.equal(result.status, "ERROR");
  assert.equal(result.status === "ERROR" && result.code, "ECONOMIC_STATE_CHANGED");
  assert.equal(result.status === "ERROR" && result.guardError, "MultiplierChanged");
  assert.ok(!("transaction" in result));
  record("9 stale pre-update expectation", "SDK refuses ECONOMIC_STATE_CHANGED (MultiplierChanged), no transaction");
});

test("10. protection window boundary equality", () => {
  const pending = authorize(KOX_STATE, T - 4n * 3600n, DEMO);
  assert.equal(execute(pending, KOX_STATE, T - 901n), "ok");
  assert.equal(execute(pending, KOX_STATE, T - 900n), "InsideTransitionWindow");
  assert.equal(execute(pending, KOX_STATE, T + 300n), "InsideTransitionWindow");
  assert.equal(execute(pending, KOX_STATE, T + 301n), "ActivationPhaseChanged");
  const activated = authorize(KOX_STATE, T + 301n, DEMO);
  assert.ok(activated.buildable);
  assert.equal(authorize(KOX_STATE, T + 300n, DEMO).buildable, false);
  assert.equal(execute(activated, KOX_STATE, T + 301n), "ok");
  record("10 window boundary equality", "both bounds inclusive: T-900 and T+300 BLOCK; T-901 and T+301 decided by phase");
});

test("11. zero window: only T itself is refused; the phase check does the rest", () => {
  const pending = authorize(KOX_STATE, T - 10n, ZERO);
  assert.deepEqual([T - 1n, T, T + 1n].map((at) => execute(pending, KOX_STATE, at)), ["ok", "InsideTransitionWindow", "ActivationPhaseChanged"]);
  record("11 zero window", "T-1 ALLOW, T BLOCK, T+1 BLOCK (ActivationPhaseChanged)");
});

test("12. very large u32 windows", async () => {
  const huge = { beforeSecs: U32_MAX, afterSecs: U32_MAX };
  assert.equal(authorize(KOX_STATE, T - 86_400n * 365n, huge).buildable, false);
  const result = await sdk(KOX_PENDING, T - 86_400n * 365n, huge);
  assert.equal(result.status === "ERROR" && result.code, "INSIDE_TRANSITION_WINDOW");
  // A timestamp the window cannot be placed around fails closed.
  const extreme = { ...KOX_STATE, newMultiplierEffectiveTimestamp: 2n ** 63n - 2n };
  assert.equal(checkGuardOffline({ expected: extreme, expectedPhase: ActivationPhase.Pending, window: huge }, extreme, 0n), "ArithmeticOverflow");
  record("12 very large u32 windows", "BLOCK / refuse to build; unrepresentable bounds fail closed (ArithmeticOverflow)");
});

test("13. malformed state fails closed on both sides", async () => {
  const bad = KOX_PENDING.slice();
  const offset = 275 + 4 + 32;
  new DataView(bad.buffer).setFloat64(offset, Number.NaN, true);
  assert.throws(() => stateOf(bad), /InvalidMultiplier/);
  const result = await sdk(bad, T - 4n * 3600n, DEMO);
  assert.equal(result.status === "ERROR" && result.code, "MALFORMED_TOKEN_STATE");
  assert.ok(!("transaction" in result));
  record("13 malformed state", "SDK ERROR MALFORMED_TOKEN_STATE; guard InvalidMultiplier");
});

test("14. a known asset declaring an unknown state model fails closed", () => {
  const registry = KNOWN_PROTECTED_ASSETS.map((a) => (a.mint === KOX_MINT ? { ...a, stateModel: "ISSUER_REDEMPTION_NOT_IMPLEMENTED" } : a));
  const resolution = resolveProtectionAdapter({ mint: KOX_MINT, owner: TOKEN_2022_PROGRAM_ADDRESS, data: KOX_PENDING, registry });
  assert.equal(resolution.kind, "KNOWN_PROTECTED_UNSUPPORTED");
  assert.equal(resolution.kind === "KNOWN_PROTECTED_UNSUPPORTED" && resolution.reason, "UNSUPPORTED_STATE_MODEL");
  record("14 unknown supported-asset state model", "KNOWN_PROTECTED_UNSUPPORTED / UNSUPPORTED_STATE_MODEL");
});

test("15. route mutation at the same time as a state change", async () => {
  const at = T - 4n * 3600n;
  const built = await sdk(KOX_PENDING, at, DEMO);
  assert.equal(built.status, "PROTECTED");
  if (built.status !== "PROTECTED") return;
  // Mutate the route: raise the quoted output (slippage) in the route_v2 data.
  const wire = built.transaction.slice();
  const resolved = resolveWireTransaction(wire, built.lookupTables);
  const routeData = resolved.at(-1)!.data;
  const at8 = Buffer.from(wire).indexOf(Buffer.from(routeData));
  assert.ok(at8 > 0);
  const flipped = at8 + routeData.length - 3;
  wire[flipped] = (wire[flipped] ?? 0) ^ 0x01;
  assert.equal(await verifyProtectedSwap(built, wire), "DownstreamCommitmentMismatch");

  // On chain: the mutated route against the CHANGED state (the schedule moved T by one second).
  const changed = KOX_PENDING.slice();
  new DataView(changed.buffer).setBigInt64(275 + 4 + 40, T + 1n, true);
  const invocation = (mint: Uint8Array, bytes: Uint8Array) => {
    const instructions = resolveWireTransaction(bytes, built.lookupTables).map((i) => ({
      programId: i.programAddress,
      accounts: i.accounts.map((a) => ({ pubkey: a.address, isSigner: a.isSigner, isWritable: a.isWritable })),
      data: i.data,
    }));
    return {
      programId: built.programAddress,
      data: instructions[0]!.data,
      accounts: [
        { pubkey: KOX_MINT as string, owner: TOKEN_2022_PROGRAM_ADDRESS, data: mint },
        { pubkey: "Sysvar1nstructions1111111111111111111111111", owner: "Sysvar1111111111111111111111111111111111111", data: new Uint8Array() },
      ],
      instructions,
      currentInstructionIndex: 0,
      clockUnixTimestamp: at + 60n,
    };
  };
  assert.equal(await evaluateGuard(invocation(KOX_PENDING, built.transaction)), null, "the honest transaction passes");
  assert.equal(await evaluateGuard(invocation(changed, built.transaction)), "EffectiveTimestampChanged", "state change alone");
  assert.equal(await evaluateGuard(invocation(KOX_PENDING, wire)), "DownstreamCommitmentMismatch", "route mutation alone");
  // Both at once: the program checks the commitment before the economics; either way it blocks.
  assert.equal(await evaluateGuard(invocation(changed, wire)), "DownstreamCommitmentMismatch", "both");
  record("15 route mutation + state change", "BLOCK: each alone and both together (commitment checked first)");
});

test("every scenario matched its documented invariant", () => {
  console.log(`M11-B scenarios:\n  ${outcomes.join("\n  ")}`);
  assert.equal(outcomes.length, 15);
});

