import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createAddressWithSeed, createTransactionMessage, generateKeyPairSigner, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type TransactionSigner } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import {
  ActivationPhase,
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  SOLANA_GENESIS_HASH,
  clusterFromGenesisHash,
  deploymentForCluster,
  type AssertSafeExecutionRequest,
  type GuardSnapshot,
} from "@equityguard/guard-client";

import { classifyPrepareInstruction, getPrepareSessionInstructions, verifyScheduledDemoMint } from "../src/demo-asset.ts";
import {
  AUTHORIZATION_WINDOW_ELAPSED_MESSAGE,
  AuthorizationWindowElapsed,
  StaleAuthorizationExpired,
  acceptanceFromIdentity,
  assertMutationGate,
  assertPendingAuthorizationStillOpen,
  assertSameSignedBytes,
  confirmedActivationRejection,
  confirmedUpdatedExecution,
  pendingAuthorizationAfterSignature,
  prepareHeldSubmission,
  sealPendingAuthorizationIfOpen,
  sealSignedTransaction,
  type ConfirmedOutcome,
} from "../src/live-execution.ts";
import {
  DEMO_ASSET_DISCLAIMER,
  SCENARIO_CATALOG,
  formatMultiplier,
  randomScenario,
  scenarioById,
  scenarioForAttempt,
  startAttempt,
  storedMultiplier,
  validateScenarioCatalog,
} from "../src/scenarios.ts";
import {
  ACTIVATION_DELAY_SECONDS,
  CLOCK_CROSSING_WINDOW,
  MAX_SIGN_LEAD_SECONDS,
  activatedReviewDecision,
  activationTimestamp,
  buildClockCrossingTransfer,
  chainReadyForStaleSubmit,
  heldWaitDecision,
  pendingSignDecision,
  validateActivationTiming,
} from "../src/transactions.ts";
import { explorerUrl, resultMarkup } from "../src/ui.ts";
import { buildTransferCheckedInstruction } from "../src/demo-asset.ts";

const wallet = address("GgBaCs3NGLqX87FtL4WQ6eqR5vUtdKQeKqHHB8SNn7z");
const signer: TransactionSigner = { address: wallet, signTransactions: async (transactions) => transactions };
const source = address("7w2MRSqKByxbNkYoXWR7vNC2D8yaZ3iPfZCVd4FcrBgT");
const destination = address("ECrVumzWbWA4c352fohUimkUmRkYm6ubAuyU8hb3Yr3y");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TOKEN = TOKEN_2022_PROGRAM_ADDRESS;
const REVIEWED_ELF = "d7d59ccd9e96bb3eb3e16893aca638d8e5fdbfaf5032b4b39737ef16a41e4e46";

function snapshot(input: {
  readonly clock: bigint;
  readonly activation: bigint;
  readonly initial?: number;
  readonly scheduled?: number;
  readonly phase?: ActivationPhase;
}): GuardSnapshot {
  const scenario = SCENARIO_CATALOG[0]!;
  const initial = input.initial ?? scenario.initialMultiplier;
  const scheduled = input.scheduled ?? scenario.newMultiplier;
  const state = {
    multiplier: storedMultiplier(initial),
    newMultiplier: storedMultiplier(scheduled),
    newMultiplierEffectiveTimestamp: input.activation,
  };
  const phase = input.phase ?? (input.clock >= input.activation ? ActivationPhase.Activated : ActivationPhase.Pending);
  return {
    mint,
    contextSlot: 1n,
    clock: { slot: 1n, unixTimestamp: input.clock },
    state,
    phase,
    hasScheduledChange: true,
  };
}

function expectationFor(phase: ActivationPhase, activation: bigint): AssertSafeExecutionRequest {
  const value = snapshot({ clock: phase === ActivationPhase.Pending ? activation - 1n : activation + 1n, activation, phase });
  return { expected: value.state, expectedPhase: phase, window: CLOCK_CROSSING_WINDOW };
}

describe("tokenized-equity scenario catalog", () => {
  it("contains exactly three approved templates with exact multipliers", () => {
    validateScenarioCatalog();
    assert.deepEqual(SCENARIO_CATALOG.map((scenario) => scenario.id), ["KO-DEMO", "UNH-DEMO", "CRM-DEMO"]);
    assert.deepEqual(SCENARIO_CATALOG.map((scenario) => [scenario.displayName, scenario.eventLabel, scenario.newMultiplier]), [
      ["Coca-Cola Demo Equity", "2-for-1 stock split", 2],
      ["UnitedHealth Demo Equity", "3-for-2 stock split", 1.5],
      ["Salesforce Demo Equity", "1-for-2 reverse split", 0.5],
    ]);
    for (const scenario of SCENARIO_CATALOG) {
      assert.equal(scenario.initialMultiplier, 1);
      assert.equal(formatMultiplier(scenario.initialMultiplier), "1.00×");
      assert.equal(storedMultiplier(scenario.newMultiplier).length, 8);
      assert.equal(DEMO_ASSET_DISCLAIMER, "Devnet demonstration asset. Not a real security and has no market value.");
    }
    assert.equal(formatMultiplier(1.5), "1.50×");
    assert.equal(formatMultiplier(0.5), "0.50×");
  });

  it("selects only an approved template, including random choice", () => {
    assert.equal(scenarioById("KO-DEMO").eventLabel, "2-for-1 stock split");
    assert.equal(scenarioById("UNH-DEMO").id, "UNH-DEMO");
    assert.equal(scenarioById("CRM-DEMO").symbol, "CRM-DEMO");
    assert.throws(() => scenarioById("KOX"), /Unknown scenario/);
    assert.equal(randomScenario(() => 0).id, "KO-DEMO");
    assert.equal(randomScenario(() => 0.34).id, "UNH-DEMO");
    assert.equal(randomScenario(() => 0.67).id, "CRM-DEMO");
    assert.equal(randomScenario(() => 0.999).id, "CRM-DEMO");
    assert.throws(() => randomScenario(() => 1), /approved scenario catalog/);
    assert.throws(() => randomScenario(() => -0.01), /approved scenario catalog/);
    const seen = new Set(Array.from({ length: 30 }, (_, index) => randomScenario(() => index / 30).id));
    assert.deepEqual([...seen].sort(), ["CRM-DEMO", "KO-DEMO", "UNH-DEMO"]);
  });

  it("keeps the chosen scenario fixed once an attempt starts", () => {
    const attempt = startAttempt(scenarioById("UNH-DEMO"));
    assert.equal(scenarioForAttempt(attempt, "UNH-DEMO").eventLabel, "3-for-2 stock split");
    assert.throws(() => scenarioForAttempt(attempt, "KO-DEMO"), /cannot change during an active attempt/);
    assert.throws(() => scenarioForAttempt(attempt, "CRM-DEMO"), /cannot change during an active attempt/);
  });
});

describe("session mint setup and arm", () => {
  it("puts mint creation, token accounts, balance, and the future schedule in one wallet-signed transaction", async () => {
    const scenario = scenarioById("KO-DEMO");
    const seed = "eg-0123456789abcdef";
    const sessionMint = await createAddressWithSeed({ baseAddress: wallet, seed, programAddress: TOKEN_2022_PROGRAM_ADDRESS });
    const recipient = await generateKeyPairSigner();
    const chainUnixTimestamp = 1_700_000_000n;
    const effectiveTimestamp = activationTimestamp(chainUnixTimestamp);
    assert.equal(effectiveTimestamp, chainUnixTimestamp + BigInt(ACTIVATION_DELAY_SECONDS));
    assert.throws(() => activationTimestamp(chainUnixTimestamp, 0), /positive/);
    const instructions = await getPrepareSessionInstructions({
      payer: signer,
      mintAddress: sessionMint,
      seed,
      rentLamports: 2_000_000n,
      recipient: recipient.address,
      scenario,
      effectiveTimestamp,
      chainUnixTimestamp,
    });
    assert.deepEqual(instructions.map(classifyPrepareInstruction), [
      "create-mint",
      "initialize-scaled-ui",
      "initialize-mint",
      "schedule-multiplier",
      "create-ata",
      "mint-to",
      "create-ata",
    ]);
    const schedule = instructions[3]!;
    const authority = schedule.accounts?.[1];
    assert.equal(authority?.address, wallet);
    assert.equal(authority?.role, AccountRole.WRITABLE_SIGNER);
    const data = schedule.data as Uint8Array;
    assert.equal(data[0], 43);
    assert.equal(data[1], 1);
    assert.deepEqual(data.subarray(2, 10), storedMultiplier(2));
    assert.equal(new DataView(data.buffer, data.byteOffset + 10, 8).getBigInt64(0, true), effectiveTimestamp);
    await assert.rejects(
      () => getPrepareSessionInstructions({
        payer: signer,
        mintAddress: sessionMint,
        seed,
        rentLamports: 2_000_000n,
        recipient: recipient.address,
        scenario,
        effectiveTimestamp: chainUnixTimestamp,
        chainUnixTimestamp,
      }),
      /after the chain clock/,
    );
    const message = pipe(
      createTransactionMessage({ version: "legacy" }),
      (value) => setTransactionMessageFeePayer(wallet, value),
      (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 1n }, value),
      (value) => appendTransactionMessageInstructions(instructions, value),
    );
    const transaction = compileTransaction(message);
    assert.deepEqual(Object.keys(transaction.signatures), [wallet]);
    assert.ok(transaction.messageBytes.length + 65 < 1_232);
  });

  it("rejects a scheduled mint that does not match the template", () => {
    const data = new Uint8Array(226);
    const view = new DataView(data.buffer);
    data[44] = 6;
    data[45] = 1;
    data[165] = 1;
    view.setUint16(166, 25, true);
    view.setUint16(168, 56, true);
    view.setFloat64(202, 1, true);
    view.setBigInt64(210, 1_075n, true);
    view.setFloat64(218, 2, true);
    assert.doesNotThrow(() => verifyScheduledDemoMint(TOKEN_2022_PROGRAM_ADDRESS, data, scenarioById("KO-DEMO"), 1_075n));
    assert.throws(() => verifyScheduledDemoMint(TOKEN_2022_PROGRAM_ADDRESS, data, scenarioById("CRM-DEMO"), 1_075n), /scheduled multiplier/);
    assert.throws(() => verifyScheduledDemoMint(TOKEN_2022_PROGRAM_ADDRESS, data, scenarioById("KO-DEMO"), 1_076n), /activation timestamp/);
  });
});

describe("chain clock authorization", () => {
  const activation = 1_000n;
  const scenario = scenarioById("KO-DEMO");

  it("uses a short validated delay and ignores a later imagined wall clock", () => {
    validateActivationTiming();
    assert.equal(ACTIVATION_DELAY_SECONDS, 75);
    assert.equal(MAX_SIGN_LEAD_SECONDS, 35);
    assert.deepEqual(CLOCK_CROSSING_WINDOW, { beforeSecs: 0, afterSecs: 0 });
    assert.throws(() => validateActivationTiming(200, 35, 60), /too long/);
    const early = snapshot({ clock: activation - 50n, activation });
    assert.equal(pendingSignDecision(early, scenario, activation), "wait");
    assert.equal(chainReadyForStaleSubmit(early, expectationFor(ActivationPhase.Pending, activation)), false);
    assert.equal(activatedReviewDecision(early, scenario, activation), "wait");
  });

  it("signs the pending authorization only while the chain clock is before T and inside the lead", () => {
    assert.equal(pendingSignDecision(snapshot({ clock: activation - 36n, activation }), scenario, activation), "wait");
    assert.equal(pendingSignDecision(snapshot({ clock: activation - 35n, activation }), scenario, activation), "sign");
    assert.equal(pendingSignDecision(snapshot({ clock: activation - 1n, activation }), scenario, activation), "sign");
    assert.equal(pendingSignDecision(snapshot({ clock: activation, activation }), scenario, activation), "missed");
    assert.equal(pendingSignDecision(snapshot({ clock: activation - 10n, activation, scheduled: 1.5 }), scenario, activation), "mismatch");
  });

  it("submits the held authorization only after the chain clock produces ActivationPhaseChanged", () => {
    const pending = expectationFor(ActivationPhase.Pending, activation);
    assert.equal(chainReadyForStaleSubmit(snapshot({ clock: activation, activation }), pending), false);
    assert.equal(chainReadyForStaleSubmit(snapshot({ clock: activation + 1n, activation }), pending), true);
    assert.equal(activatedReviewDecision(snapshot({ clock: activation, activation }), scenario, activation), "wait");
    assert.equal(activatedReviewDecision(snapshot({ clock: activation + 1n, activation }), scenario, activation), "ready");
    assert.equal(heldWaitDecision({ blockHeight: 10n, lastValidBlockHeight: 10n, ready: false }), "wait");
    assert.equal(heldWaitDecision({ blockHeight: 10n, lastValidBlockHeight: 10n, ready: true }), "submit");
    assert.equal(heldWaitDecision({ blockHeight: 11n, lastValidBlockHeight: 10n, ready: true }), "expired");
  });

  it("builds a pending transfer before T and a new activated transfer only after T", () => {
    const transfer = buildTransferCheckedInstruction({
      source, mint, destination, authority: signer, amount: 100_000n, decimals: 6,
    });
    const pending = buildClockCrossingTransfer({
      snapshot: snapshot({ clock: activation - 10n, activation }),
      scenario,
      activationTimestamp: activation,
      requiredPhase: ActivationPhase.Pending,
      feePayer: wallet,
      mint,
      transferChecked: transfer,
    });
    const updated = buildClockCrossingTransfer({
      snapshot: snapshot({ clock: activation + 1n, activation }),
      scenario,
      activationTimestamp: activation,
      requiredPhase: ActivationPhase.Activated,
      feePayer: wallet,
      mint,
      transferChecked: transfer,
    });
    assert.equal(pending.expectation.expectedPhase, ActivationPhase.Pending);
    assert.equal(updated.expectation.expectedPhase, ActivationPhase.Activated);
    assert.notDeepEqual(pending.guarded.guard.data, updated.guarded.guard.data);
    assert.throws(() => buildClockCrossingTransfer({
      snapshot: snapshot({ clock: activation - 10n, activation }),
      scenario,
      activationTimestamp: activation,
      requiredPhase: ActivationPhase.Activated,
      feePayer: wallet,
      mint,
      transferChecked: transfer,
    }), /not ready/);
  });
});

describe("stale and updated evidence", () => {
  const before = { source: 1_000_000n, destination: 0n };
  const held = sealSignedTransaction({
    signedBytes: Uint8Array.of(1, 2, 3, 4),
    lastValidBlockHeight: 50n,
    signature: "held-signature",
    guardInstructionIndex: 0,
    expectation: expectationFor(ActivationPhase.Pending, 1_000n),
  });

  it("keeps signed bytes immutable and refuses to rebuild an expired authorization", () => {
    assert.doesNotThrow(() => assertSameSignedBytes(held, Uint8Array.of(1, 2, 3, 4)));
    assert.deepEqual(prepareHeldSubmission(held, 50n), Uint8Array.of(1, 2, 3, 4));
    assert.throws(() => assertSameSignedBytes(held, Uint8Array.of(1, 2, 3, 5)), /bytes changed/);
    assert.throws(() => prepareHeldSubmission(held, 51n), (error) => error instanceof StaleAuthorizationExpired && error.code === "STALE_AUTHORIZATION_EXPIRED");
    const mutated = sealSignedTransaction({
      signedBytes: Uint8Array.of(9, 9),
      lastValidBlockHeight: 50n,
      signature: "held-signature",
      guardInstructionIndex: 0,
      expectation: held.expectation,
    });
    mutated.signedBytes[0] = 1;
    assert.throws(() => prepareHeldSubmission(mutated, 40n), /bytes changed/);
  });

  it("accepts only ActivationPhaseChanged with zero movement and no token transfer", () => {
    const outcome = (code: number, logs: string[], balances = before): ConfirmedOutcome => ({
      signature: "stale-signature",
      slot: 7n,
      error: { InstructionError: [0, { Custom: code }] },
      customError: { instructionIndex: 0, code },
      logs,
      guardInstructionIndex: 0,
    });
    const logs = [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} invoke [1]`, `Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} failed: custom program error: 0xc`];
    const result = confirmedActivationRejection({
      outcome: outcome(12, logs),
      before,
      after: before,
      symbol: "KO-DEMO",
      eventLabel: "2-for-1 stock split",
      authorizedMultiplier: "1.00×",
      currentMultiplier: "2.00×",
    });
    assert.equal(result.type, "CONFIRMED_ACTIVATION_REJECTION");
    const html = resultMarkup(result);
    assert.match(html, /PROTECTED BY EQUITYGUARD/);
    assert.match(html, /ActivationPhaseChanged/);
    assert.match(html, /BLOCKED/);
    assert.match(html, /Token movement 0/);
    assert.match(html, /Solana Devnet/);
    assert.match(html, /economic state changed after authorization/);
    assert.match(html, /EquityGuard required a new authorization instead of silently executing against the changed state/);
    assert.match(html, /Not a real security/);
    assert.match(html, new RegExp(explorerUrl("stale-signature").replace(/[?]/g, "\\?")));
    assert.doesNotMatch(html, /MultiplierChanged|Jupiter|Whirlpool/);
    assert.throws(() => confirmedActivationRejection({
      outcome: outcome(9, [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} invoke [1]`, `Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} failed: custom program error: 0x9`]),
      before, after: before, symbol: "KO-DEMO", eventLabel: "2-for-1 stock split", authorizedMultiplier: "1.00×", currentMultiplier: "2.00×",
    }), /ActivationPhaseChanged/);
    assert.throws(() => confirmedActivationRejection({
      outcome: outcome(13, [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} invoke [1]`]),
      before, after: before, symbol: "KO-DEMO", eventLabel: "2-for-1 stock split", authorizedMultiplier: "1.00×", currentMultiplier: "2.00×",
    }), /ActivationPhaseChanged/);
    assert.throws(() => confirmedActivationRejection({
      outcome: outcome(12, [...logs, `Program ${TOKEN} success`]),
      before, after: before, symbol: "KO-DEMO", eventLabel: "2-for-1 stock split", authorizedMultiplier: "1.00×", currentMultiplier: "2.00×",
    }), /zero protected token movement/);
    assert.throws(() => confirmedActivationRejection({
      outcome: outcome(12, logs, { source: 900_000n, destination: 100_000n }),
      before, after: { source: 900_000n, destination: 100_000n }, symbol: "KO-DEMO", eventLabel: "2-for-1 stock split", authorizedMultiplier: "1.00×", currentMultiplier: "2.00×",
    }), /zero protected token movement/);
  });

  it("renders blockhash expiry as a failed attempt without a protection result", () => {
    const html = resultMarkup({ type: "STALE_AUTHORIZATION_EXPIRED" });
    assert.match(html, /STALE_AUTHORIZATION_EXPIRED/);
    assert.match(html, /not a protection result/);
    assert.doesNotMatch(html, /PROTECTED BY EQUITYGUARD|ActivationPhaseChanged|explorer\.solana\.com/);
  });

  it("requires a confirmed transfer and the exact token delta for the updated authorization", () => {
    const success: ConfirmedOutcome = {
      signature: "updated-signature",
      slot: 8n,
      error: null,
      customError: null,
      logs: [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} success`, `Program ${TOKEN} success`],
    };
    const result = confirmedUpdatedExecution({
      outcome: success,
      before,
      after: { source: 900_000n, destination: 100_000n },
      amount: 100_000n,
      symbol: "KO-DEMO",
      eventLabel: "2-for-1 stock split",
    });
    assert.equal(result.type, "CONFIRMED_UPDATED_EXECUTION");
    const html = resultMarkup(result);
    assert.match(html, /EquityGuard passed/);
    assert.match(html, /Token transfer executed/);
    assert.match(html, /Token movement 100000/);
    assert.match(html, /cluster=devnet/);
    assert.doesNotMatch(html, /Jupiter|Whirlpool/);
    assert.throws(() => confirmedUpdatedExecution({
      outcome: success, before, after: before, amount: 100_000n, symbol: "KO-DEMO", eventLabel: "2-for-1 stock split",
    }), /did not execute/);
    assert.throws(() => confirmedUpdatedExecution({
      outcome: { ...success, logs: [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} success`] },
      before, after: { source: 900_000n, destination: 100_000n }, amount: 100_000n, symbol: "KO-DEMO", eventLabel: "2-for-1 stock split",
    }), /did not execute/);
  });
});

describe("late pending authorization", () => {
  const scenario = scenarioById("KO-DEMO");
  const activation = 1_700_000_075n;
  const expectation = expectationFor(ActivationPhase.Pending, activation);
  const sealInput = (value: GuardSnapshot, signedBytes = Uint8Array.of(4, 5, 6, 7)) => ({
    snapshot: value,
    scenario,
    activationTimestamp: activation,
    signedBytes,
    lastValidBlockHeight: 80n,
    signature: "pending-signature",
    guardInstructionIndex: 0,
    expectation,
  });

  it("holds a signature that returns while the chain clock is still before T", () => {
    const open = snapshot({ clock: activation - 10n, activation });
    assert.equal(pendingAuthorizationAfterSignature(open, scenario, activation), "hold");
    assert.doesNotThrow(() => assertPendingAuthorizationStillOpen(open, scenario, activation));
    const earlyLead = snapshot({ clock: activation - 36n, activation });
    assert.equal(pendingAuthorizationAfterSignature(earlyLead, scenario, activation), "hold");
    const signedBytes = Uint8Array.of(4, 5, 6, 7);
    const held = sealPendingAuthorizationIfOpen(sealInput(open, signedBytes));
    signedBytes[0] = 0;
    assert.equal(held.signedBytes[0], 4);
    assert.throws(() => assertSameSignedBytes(held, signedBytes), /bytes changed/);
    assert.equal(prepareHeldSubmission(held, 80n)[0], 4);
  });

  it("refuses a signature that returns at T, after T, or against a changed mint, and sends nothing", () => {
    let sent = 0;
    const submit = () => { sent += 1; };
    const cases = [
      snapshot({ clock: activation, activation }),
      snapshot({ clock: activation + 5n, activation }),
      snapshot({ clock: activation - 10n, activation, scheduled: 1.5 }),
      snapshot({ clock: activation - 10n, activation, initial: 2 }),
    ];
    const drifted = snapshot({ clock: activation - 10n, activation });
    cases.push({
      ...drifted,
      state: { ...drifted.state, newMultiplierEffectiveTimestamp: activation + 1n },
    });
    for (const value of cases) {
      assert.equal(pendingAuthorizationAfterSignature(value, scenario, activation), "elapsed");
      assert.throws(() => {
        sealPendingAuthorizationIfOpen(sealInput(value));
        submit();
      }, (error) => error instanceof AuthorizationWindowElapsed
        && error.code === "AUTHORIZATION_WINDOW_ELAPSED"
        && error.message === AUTHORIZATION_WINDOW_ELAPSED_MESSAGE
        && error.clock === value.clock.unixTimestamp
        && error.activation === activation);
    }
    assert.equal(sent, 0);
    const html = resultMarkup({ type: "AUTHORIZATION_WINDOW_ELAPSED", clock: activation.toString(), activation: activation.toString() });
    assert.match(html, /AUTHORIZATION_WINDOW_ELAPSED/);
    assert.match(html, /activated before wallet approval completed/);
    assert.match(html, /No transaction was submitted/);
    assert.match(html, new RegExp(`Clock ${activation}`));
    assert.match(html, new RegExp(`Activation ${activation}`));
    assert.doesNotMatch(html, /PROTECTED BY EQUITYGUARD|ActivationPhaseChanged|explorer\.solana\.com/);
  });
});

describe("devnet demo security boundary", () => {
  it("rejects mainnet and testnet and a deployment that is not the reviewed binary", () => {
    assert.equal(clusterFromGenesisHash(SOLANA_GENESIS_HASH["mainnet-beta"]), "mainnet-beta");
    assert.equal(clusterFromGenesisHash(SOLANA_GENESIS_HASH.testnet), "testnet");
    assert.equal(deploymentForCluster("mainnet-beta"), null);
    assert.equal(deploymentForCluster("testnet"), null);
    assert.equal(deploymentForCluster("devnet"), EQUITY_GUARD_DEVNET_PROGRAM_ID);
    assert.throws(() => assertMutationGate({ verified: false, reason: "Connected to mainnet-beta — refusing all state-changing actions" }, null), /mainnet/);
    assert.throws(() => assertMutationGate({ verified: false, reason: "Connected to testnet — only devnet is supported" }, null), /testnet/);
    const refused = acceptanceFromIdentity({ ok: false, reason: "BINARY_MISMATCH", message: "ELF mismatch" }, REVIEWED_ELF);
    assert.equal(refused.verified, false);
    const trusted = acceptanceFromIdentity({
      ok: true,
      attestation: {
        programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
        programDataAddress: address("4Zc4TAEYNSXCGUkpD7y7CcEWDS8a9aQBDfYHFu55dPE3"),
        reviewedElfSha256: null,
        deploymentSlot: 1n,
        upgradeAuthority: null,
        mutability: "UNKNOWN",
        identity: "CALLER_TRUSTED",
      },
    }, REVIEWED_ELF);
    assert.equal(trusted.verified, false);
  });

  it("does not authorize from the browser clock, add a secret, or accept an arbitrary endpoint", () => {
    const root = new URL("../src/", import.meta.url);
    const files = ["scenarios.ts", "transactions.ts", "demo-asset.ts", "live-execution.ts", "app.ts", "ui.ts"];
    for (const file of files) {
      const sourceText = readFileSync(new URL(file, root), "utf8");
      assert.doesNotMatch(sourceText, /secretKey|privateKey|localStorage|sessionStorage|location\.search|URLSearchParams|api\.mainnet-beta\.solana\.com|Jupiter|Whirlpool|whirLb/);
    }
    const timing = readFileSync(new URL("transactions.ts", root), "utf8");
    assert.doesNotMatch(timing, /Date\.now|new Date\(/);
    const sign = readFileSync(new URL("live-execution.ts", root), "utf8");
    const signFn = sign.slice(sign.indexOf("export async function signPendingProtectedTransfer"), sign.indexOf("export async function submitHeldAuthorization"));
    assert.doesNotMatch(signFn, /sendTransaction/);
    assert.ok(signFn.lastIndexOf("pendingSignDecision") < signFn.indexOf("provider.request"));
    const afterRequest = signFn.slice(signFn.indexOf("provider.request"));
    assert.ok(afterRequest.indexOf("readSnapshot") < afterRequest.indexOf("assertPendingAuthorizationStillOpen"));
    assert.ok(afterRequest.indexOf("assertPendingAuthorizationStillOpen") < afterRequest.indexOf("sealPendingAuthorizationIfOpen"));
    assert.ok(afterRequest.indexOf("sealPendingAuthorizationIfOpen") < afterRequest.indexOf("onPhase(\"HOLDING\""));
    assert.doesNotMatch(afterRequest, /sendTransaction|submitHeldAuthorization/);
    const sealFn = sign.slice(sign.indexOf("export function sealPendingAuthorizationIfOpen"), sign.indexOf("export function prepareHeldSubmission"));
    assert.ok(sealFn.indexOf("assertPendingAuthorizationStillOpen") < sealFn.indexOf("return sealSignedTransaction"));
    const submitFn = sign.slice(sign.indexOf("export async function submitHeldAuthorization"), sign.indexOf("export function confirmedActivationRejection"));
    assert.doesNotMatch(submitFn, /getLatestBlockhash|provider\.request|signTransaction/);
    assert.match(submitFn, /prepareHeldSubmission/);
    const ui = readFileSync(new URL("ui.ts", root), "utf8");
    assert.match(ui, /id="mint-address"/);
    assert.match(ui, /id="token-balance"/);
    const app = readFileSync(new URL("app.ts", root), "utf8");
    const authorize = app.slice(app.indexOf("async function authorizeProtectedAction"), app.indexOf("async function confirmUpdatedAction"));
    assert.equal(authorize.split("signPendingProtectedTransfer").length - 1, 1);
    const late = app.slice(app.indexOf("if (error instanceof AuthorizationWindowElapsed)"), app.indexOf("const signature = error instanceof LiveExecutionError"));
    assert.match(late, /proofClosed = true/);
    assert.match(late, /type: "AUTHORIZATION_WINDOW_ELAPSED"/);
    assert.doesNotMatch(late, /signPendingProtectedTransfer|submitHeldAuthorization|sendTransaction|provider\.request|getLatestBlockhash/);
    const expiry = app.slice(app.indexOf("if (error instanceof StaleAuthorizationExpired)"), app.indexOf("throw error;", app.indexOf("if (error instanceof StaleAuthorizationExpired)")));
    assert.doesNotMatch(expiry, /signPendingProtectedTransfer|buildClockCrossingTransfer|getLatestBlockhash|submitHeldAuthorization/);
    const confirm = app.slice(app.indexOf("async function confirmUpdatedAction"), app.indexOf("async function waitForPendingSign"));
    assert.doesNotMatch(confirm, /signPendingProtectedTransfer|submitHeldAuthorization|session\.held/);
    assert.match(confirm, /buildClockCrossingTransfer/);
    assert.match(confirm, /await execute\("UPDATED"/);
    assert.match(app, /return submitAndConfirm\(/);
  });
});
