/**
 * Public Devnet demo policy. No wallet, no RPC, and no localhost coordinator.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, getTransferCheckedInstruction } from "@solana-program/token-2022";

import { ActivationPhase } from "../../../packages/guard-client/src/abi.ts";
import { SOLANA_GENESIS_HASH } from "../../../packages/guard-client/src/deployment.ts";
import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../../../packages/guard-client/src/program-id.ts";
import { buildGuardedTransferChecked } from "../../../packages/guard-client/src/downstream.ts";
import { SCENARIO_CATALOG as REFERENCE_CATALOG } from "../../devnet-wallet-demo/src/scenarios.ts";
import {
  ACTIVATION_DELAY_SECONDS,
  AUTHORIZATION_WINDOW_ELAPSED_MESSAGE,
  AUTHORIZATION_WINDOW_MISSED_MESSAGE,
  CLOCK_CROSSING_WINDOW,
  DEMO_TRANSFER_RAW,
  DEVNET_RPC_URL,
  MIN_AUTHORIZATION_REMAINING_SECONDS,
  PROTECTION_EXPLANATION,
  PUBLIC_GENESIS,
  SCENARIO_CATALOG,
  STALE_AUTHORIZATION_EXPIRED_MESSAGE,
  acceptActivationRejection,
  acceptUpdatedExecution,
  activatedReviewDecision,
  activationTimestamp,
  assertDevnetCluster,
  authorizeDecision,
  chainReadyForStaleSubmit,
  expectationForSnapshot,
  formatMultiplier,
  heldWaitDecision,
  initialPublicDemoMode,
  isExplicitDevnetSelection,
  pendingReturnDecision,
  presentationCountdownSeconds,
  randomScenario,
  requirePhantom,
  scenarioById,
  scenarioForAttempt,
  bindReviewedProgram,
  buildPublicGuardedTransfer,
  classifyPrepareInstruction,
  prepareSessionInstructions,
  sha256Hex,
  startAttempt,
  storedMultiplier,
  submissionPermitted,
} from "../lib/devnet-public.ts";

bindReviewedProgram(EQUITY_GUARD_DEVNET_PROGRAM_ID);

const wallet = address("GgBaCs3NGLqX87FtL4WQ6eqR5vUtdKQeKqHHB8SNn7z");
const source = address("7w2MRSqKByxbNkYoXWR7vNC2D8yaZ3iPfZCVd4FcrBgT");
const destination = address("ECrVumzWbWA4c352fohUimkUmRkYm6ubAuyU8hb3Yr3y");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const signer = { address: wallet, signTransactions: async (transactions) => transactions };
const scenario = scenarioById("KO-DEMO");

function snapshot(input) {
  const initial = input.initial ?? 1;
  const scheduled = input.scheduled ?? 2;
  const state = {
    multiplier: storedMultiplier(initial),
    newMultiplier: storedMultiplier(scheduled),
    newMultiplierEffectiveTimestamp: input.activation,
  };
  return {
    mint,
    contextSlot: 1n,
    clock: { slot: 1n, unixTimestamp: input.clock },
    state,
    phase: input.phase ?? (input.clock >= input.activation ? ActivationPhase.Activated : ActivationPhase.Pending),
    hasScheduledChange: initial !== scheduled,
  };
}

const balances = { source: 1_000_000n, destination: 0n };

test("the recorded replay stays the default and Devnet requires an explicit choice", () => {
  assert.equal(initialPublicDemoMode(), "replay");
  assert.equal(isExplicitDevnetSelection(null), false);
  assert.equal(isExplicitDevnetSelection("replay"), false);
  assert.equal(isExplicitDevnetSelection("devnet"), true);
});

test("the catalog is the three approved templates and random cannot leave it", () => {
  assert.deepEqual(SCENARIO_CATALOG.map((item) => item.id), ["KO-DEMO", "UNH-DEMO", "CRM-DEMO"]);
  assert.deepEqual(SCENARIO_CATALOG, REFERENCE_CATALOG);
  assert.equal(formatMultiplier(1), "1.00×");
  assert.equal(formatMultiplier(1.5), "1.50×");
  assert.equal(formatMultiplier(0.5), "0.50×");
  assert.equal(randomScenario(() => 0).id, "KO-DEMO");
  assert.equal(randomScenario(() => 0.34).id, "UNH-DEMO");
  assert.equal(randomScenario(() => 0.67).id, "CRM-DEMO");
  assert.throws(() => randomScenario(() => 1), /approved scenario catalog/);
  const attempt = startAttempt(scenarioById("UNH-DEMO"));
  assert.throws(() => scenarioForAttempt(attempt, "KO-DEMO"), /cannot change/);
});

test("Phantom, Devnet genesis, and the reviewed deployment are required", () => {
  assert.throws(() => requirePhantom(null), /Phantom/);
  assert.throws(() => requirePhantom({ isPhantom: false }), /Phantom/);
  assert.equal(assertDevnetCluster(PUBLIC_GENESIS.devnet), "devnet");
  assert.deepEqual(PUBLIC_GENESIS, SOLANA_GENESIS_HASH);
  assert.throws(() => assertDevnetCluster(PUBLIC_GENESIS["mainnet-beta"]), /mainnet/);
  assert.throws(() => assertDevnetCluster(PUBLIC_GENESIS.testnet), /testnet/);
  assert.equal(DEVNET_RPC_URL, "https://api.devnet.solana.com");
  assert.equal(EQUITY_GUARD_DEVNET_PROGRAM_ID.length > 30, true);
});

test("setup arms a fresh session and Authorize is immediate when enough chain time remains", async () => {
  const chain = 1_700_000_000n;
  const activation = activationTimestamp(chain);
  assert.equal(activation - chain, BigInt(ACTIVATION_DELAY_SECONDS));
  assert.equal(ACTIVATION_DELAY_SECONDS >= 25 && ACTIVATION_DELAY_SECONDS <= 30, true);
  assert.equal(MIN_AUTHORIZATION_REMAINING_SECONDS >= 8 && MIN_AUTHORIZATION_REMAINING_SECONDS <= 15, true);
  const open = snapshot({ clock: activation - BigInt(MIN_AUTHORIZATION_REMAINING_SECONDS), activation });
  assert.equal(authorizeDecision(open, scenario, activation), "sign");
  assert.equal(authorizeDecision(snapshot({ clock: activation - 20n, activation }), scenario, activation), "sign");
  assert.equal(authorizeDecision(snapshot({ clock: activation - BigInt(MIN_AUTHORIZATION_REMAINING_SECONDS - 1), activation }), scenario, activation), "missed");
  const instructions = await prepareSessionInstructions({
    payer: signer,
    mintAddress: mint,
    seed: "eg-0123456789abcdef",
    rentLamports: 2_000_000n,
    recipient: destination,
    scenario,
    effectiveTimestamp: activation,
    chainUnixTimestamp: chain,
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
  assert.equal(instructions[3].accounts?.[1]?.role, AccountRole.WRITABLE_SIGNER);
});

test("the public path has no 35-second gate and fetches the pending blockhash at authorization", async () => {
  const root = new URL("../", import.meta.url);
  const [policy, experience, component] = await Promise.all([
    readFile(new URL("lib/devnet-public.ts", root), "utf8"),
    readFile(new URL("components/demo/demo-experience.tsx", root), "utf8"),
    readFile(new URL("components/demo/live-devnet-experience.tsx", root), "utf8"),
  ]);
  const chain = policy;
  for (const sourceText of [policy, chain, component]) {
    assert.doesNotMatch(sourceText, /MAX_SIGN_LEAD|Date\.now|new Date\(/);
    assert.doesNotMatch(sourceText, /\b(?:35|75)\b/);
  }
  const authorize = chain.slice(chain.indexOf("export async function authorizePending"), chain.indexOf("export async function currentBlockHeight"));
  assert.ok(authorize.indexOf("authorizeDecision") < authorize.indexOf("getLatestBlockhash"));
  assert.ok(authorize.indexOf("getLatestBlockhash") < authorize.indexOf("provider.request"));
  assert.ok(authorize.indexOf("provider.request") < authorize.indexOf("pendingReturnDecision"));
  assert.doesNotMatch(authorize.slice(authorize.indexOf("provider.request")), /sendTransaction/);
  assert.match(experience, /modeChoice \?\? \(live\.available \? "live" : "replay"\)/);
  assert.match(experience, /setModeChoice\("devnet"\)/);
  assert.match(component, /submissionPermitted/);
  assert.match(component, /bindReviewedProgram/);
  assert.equal(component.includes(EQUITY_GUARD_DEVNET_PROGRAM_ID), true);
  assert.equal(policy.includes(EQUITY_GUARD_DEVNET_PROGRAM_ID), false);
  assert.doesNotMatch(component, /127\.0\.0\.1:4175|NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO|Jupiter|Whirlpool/);
  assert.doesNotMatch(chain, /127\.0\.0\.1:4175|NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO|Jupiter|Whirlpool/);
});

test("a late Phantom return is refused and a timely one freezes the signed bytes", () => {
  const activation = 1_700_000_028n;
  const open = snapshot({ clock: activation - 10n, activation });
  assert.equal(pendingReturnDecision(open, scenario, activation), "hold");
  assert.equal(pendingReturnDecision(snapshot({ clock: activation, activation }), scenario, activation), "elapsed");
  assert.equal(pendingReturnDecision(snapshot({ clock: activation + 3n, activation }), scenario, activation), "elapsed");
  assert.equal(pendingReturnDecision(snapshot({ clock: activation - 8n, activation, scheduled: 1.5 }), scenario, activation), "elapsed");
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const hash = sha256Hex(bytes);
  bytes[0] = 9;
  assert.notEqual(sha256Hex(bytes), hash);
  assert.match(AUTHORIZATION_WINDOW_ELAPSED_MESSAGE, /No transaction was submitted/);
  assert.match(AUTHORIZATION_WINDOW_MISSED_MESSAGE, /too close to activation/);
});

test("the countdown cannot submit and only the chain clock can", () => {
  const activation = 50n;
  const pending = snapshot({ clock: 40n, activation });
  const expectation = expectationForSnapshot(pending);
  assert.equal(expectation.expectedPhase, ActivationPhase.Pending);
  assert.equal(expectation.window, CLOCK_CROSSING_WINDOW);
  assert.equal(presentationCountdownSeconds(40n, activation), 10);
  assert.equal(submissionPermitted({ displayedSeconds: 0, chainReady: false }), false);
  assert.equal(submissionPermitted({ displayedSeconds: 8, chainReady: false }), false);
  assert.equal(chainReadyForStaleSubmit(pending, expectation), false);
  const crossed = snapshot({ clock: activation + 1n, activation });
  assert.equal(chainReadyForStaleSubmit(crossed, expectation), true);
  assert.equal(submissionPermitted({ displayedSeconds: 0, chainReady: true }), true);
  assert.equal(heldWaitDecision({ blockHeight: 10n, lastValidBlockHeight: 9n, ready: true }), "expired");
  assert.equal(heldWaitDecision({ blockHeight: 4n, lastValidBlockHeight: 9n, ready: false }), "wait");
  assert.equal(heldWaitDecision({ blockHeight: 4n, lastValidBlockHeight: 9n, ready: true }), "submit");
  assert.match(STALE_AUTHORIZATION_EXPIRED_MESSAGE, /not a protection result/);
});

test("stale success is only ActivationPhaseChanged with zero movement", () => {
  const outcome = (code, logs, error = { InstructionError: [0, { Custom: code }] }) => ({
    signature: "stale-signature",
    slot: 3n,
    error,
    customError: { instructionIndex: 0, code },
    logs,
    guardInstructionIndex: 0,
  });
  const logs = [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} invoke [1]`];
  assert.equal(acceptActivationRejection({
    outcome: outcome(12, logs),
    before: balances,
    after: balances,
    programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.equal(acceptActivationRejection({
    outcome: outcome(9, logs),
    before: balances,
    after: balances,
    programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.equal(acceptActivationRejection({
    outcome: outcome(12, [...logs, `Program ${TOKEN_2022_PROGRAM_ADDRESS} success`]),
    before: balances,
    after: balances,
    programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.equal(acceptActivationRejection({
    outcome: outcome(12, logs),
    before: balances,
    after: { source: 900_000n, destination: 100_000n },
    programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.match(PROTECTION_EXPLANATION, /new authorization/);
});

test("the updated authorization is a new confirmed transfer, not the stale signature", () => {
  const activation = 80n;
  assert.equal(activatedReviewDecision(snapshot({ clock: activation, activation }), scenario, activation), "wait");
  assert.equal(activatedReviewDecision(snapshot({ clock: activation + 1n, activation }), scenario, activation), "ready");
  const pending = expectationForSnapshot(snapshot({ clock: activation - 5n, activation }));
  const activated = expectationForSnapshot(snapshot({ clock: activation + 1n, activation }));
  assert.notEqual(pending.expectedPhase, activated.expectedPhase);
  const success = {
    signature: "updated-signature",
    slot: 9n,
    error: null,
    customError: null,
    logs: [`Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} success`, `Program ${TOKEN_2022_PROGRAM_ADDRESS} success`],
    guardInstructionIndex: 0,
  };
  assert.equal(acceptUpdatedExecution({
    outcome: success,
    before: balances,
    after: { source: 900_000n, destination: DEMO_TRANSFER_RAW },
    amount: DEMO_TRANSFER_RAW,
    programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.equal(acceptUpdatedExecution({
    outcome: success,
    before: balances,
    after: balances,
    amount: DEMO_TRANSFER_RAW,
    programId: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
});

test("the public guarded transfer matches the reviewed Token-2022 builder", () => {
  const activation = 90n;
  const view = snapshot({ clock: activation - 10n, activation });
  const transfer = getTransferCheckedInstruction({
    source, mint, destination, authority: signer, amount: DEMO_TRANSFER_RAW, decimals: 6,
  });
  const expectation = expectationForSnapshot(view);
  const proven = buildGuardedTransferChecked({
    programAddress: EQUITY_GUARD_DEVNET_PROGRAM_ID,
    feePayer: wallet,
    mint,
    expectation,
    transferChecked: transfer,
  });
  const pub = buildPublicGuardedTransfer({ feePayer: wallet, mint, expectation, transferChecked: transfer });
  assert.equal(pub.instructions.length, proven.instructions.length);
  assert.deepEqual(pub.guard.data, proven.guard.data);
  assert.equal(pub.guard.programAddress, EQUITY_GUARD_DEVNET_PROGRAM_ID);
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (value) => setTransactionMessageFeePayer(wallet, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1n }, value),
    (value) => appendTransactionMessageInstructions(pub.instructions, value),
  );
  assert.equal(compileTransaction(message).messageBytes.length > 0, true);
});
