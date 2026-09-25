/**
 * Public Devnet demo policy. No wallet, no RPC, and no localhost coordinator.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS, getTransferCheckedInstruction } from "@solana-program/token-2022";

import { SCENARIO_CATALOG as REFERENCE_CATALOG } from "../../devnet-wallet-demo/src/scenarios.ts";
import {
  ACTIVATION_DELAY_SECONDS,
  AUTHORIZATION_WINDOW_ELAPSED_MESSAGE,
  AUTHORIZATION_WINDOW_MISSED_MESSAGE,
  ActivationPhase,
  CLOCK_CROSSING_WINDOW,
  DEMO_TRANSFER_RAW,
  DEVNET_RPC_URL,
  MIN_AUTHORIZATION_REMAINING_SECONDS,
  PROTECTION_EXPLANATION,
  PUBLIC_GENESIS,
  SCENARIO_CATALOG,
  CONFIRMATION_STATUS_UNKNOWN_TITLE,
  STALE_AUTHORIZATION_EXPIRED_MESSAGE,
  STALE_SEND_TIMEOUT_MS,
  STALE_STATUS_POLL_MS,
  STALE_STATUS_WINDOW_MS,
  SUBMISSION_STATUS_UNKNOWN_MESSAGE,
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
  classifyPrepareInstruction,
  phantomSignedTransaction,
  parseCustomError,
  prepareSessionInstructions,
  sha256Hex,
  ConfirmationStatusUnknown,
  DevnetSubmissionError,
  classifyStaleSend,
  confirmationStatusUnknownMessage,
  runStaleSubmission,
  signatureFromSignedBytes,
  staleSendAmbiguous,
  staleSendExpiry,
  staleSendFailure,
  SubmissionStatusUnknown,
  unexpectedStaleResultCopy,
  verifyWalletSignedTransaction,
  startAttempt,
  storedMultiplier,
  submissionPermitted,
} from "../lib/devnet-public.ts";

const componentSource = readFileSync(new URL("../components/demo/live-devnet-experience.tsx", import.meta.url), "utf8");
const reviewedProgram = componentSource.match(/bindReviewedProgram\(address\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)\)/);
if (reviewedProgram === null) throw new Error("Live Devnet component does not bind a reviewed program");
const reviewedProgramId = reviewedProgram[1];
bindReviewedProgram(address(reviewedProgramId));

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
  assert.throws(() => assertDevnetCluster(PUBLIC_GENESIS["mainnet-beta"]), /mainnet/);
  assert.throws(() => assertDevnetCluster(PUBLIC_GENESIS.testnet), /testnet/);
  assert.equal(DEVNET_RPC_URL, "https://api.devnet.solana.com");
  assert.equal(reviewedProgramId.length > 30, true);
});

test("setup arms a fresh session and Authorize is immediate when enough chain time remains", async () => {
  const chain = 1_700_000_000n;
  const activation = activationTimestamp(chain);
  assert.equal(ACTIVATION_DELAY_SECONDS, 35);
  assert.equal(MIN_AUTHORIZATION_REMAINING_SECONDS, 8);
  assert.equal(activation - chain, BigInt(35));
  const open = snapshot({ clock: activation - 8n, activation });
  assert.equal(authorizeDecision(open, scenario, activation), "sign");
  assert.equal(authorizeDecision(snapshot({ clock: activation - 20n, activation }), scenario, activation), "sign");
  assert.equal(authorizeDecision(snapshot({ clock: activation - 7n, activation }), scenario, activation), "missed");
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

test("Authorize has no pre-sign wait and fetches the pending blockhash at authorization", async () => {
  const root = new URL("../", import.meta.url);
  const [policy, experience, component] = await Promise.all([
    readFile(new URL("lib/devnet-public.ts", root), "utf8"),
    readFile(new URL("components/demo/demo-experience.tsx", root), "utf8"),
    readFile(new URL("components/demo/live-devnet-experience.tsx", root), "utf8"),
  ]);
  const chain = policy;
  for (const sourceText of [policy, chain, component]) {
    assert.doesNotMatch(sourceText, /MAX_SIGN_LEAD|Date\.now|new Date\(/);
    assert.doesNotMatch(sourceText, /\b75\b/);
  }
  const prepare = chain.slice(chain.indexOf("export async function prepareLiveSession"), chain.indexOf("export async function authorizePending"));
  assert.doesNotMatch(prepare, /getLatestBlockhash|setTimeout/);
  const authorize = chain.slice(chain.indexOf("export async function authorizePending"), chain.indexOf("export async function currentBlockHeight"));
  assert.doesNotMatch(authorize, /setTimeout/);
  assert.ok(authorize.indexOf("authorizeDecision") < authorize.indexOf("getLatestBlockhash"));
  assert.ok(authorize.indexOf("getLatestBlockhash") < authorize.indexOf("provider.request"));
  assert.ok(authorize.indexOf("provider.request") < authorize.indexOf("pendingReturnDecision"));
  assert.ok(authorize.indexOf("pendingReturnDecision") < authorize.indexOf("verifyWalletSignedTransaction"));
  assert.ok(authorize.indexOf("verifyWalletSignedTransaction") < authorize.indexOf("return seal"));
  assert.doesNotMatch(authorize.slice(authorize.indexOf("provider.request")), /sendTransaction/);
  assert.match(experience, /modeChoice \?\? \(live\.available \? "live" : "replay"\)/);
  assert.match(experience, /setModeChoice\("devnet"\)/);
  assert.match(component, /submissionPermitted/);
  assert.match(component, /bindReviewedProgram/);
  assert.equal(component.includes(reviewedProgramId), true);
  assert.equal(policy.includes(reviewedProgramId), false);
  assert.doesNotMatch(component, /127\.0\.0\.1:4175|NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO|Jupiter|Whirlpool/);
  assert.doesNotMatch(chain, /127\.0\.0\.1:4175|NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO|Jupiter|Whirlpool/);
});

test("a late Phantom return is refused and a timely one freezes the signed bytes", () => {
  const activation = 1_700_000_028n;
  const open = snapshot({ clock: activation - 10n, activation });
  assert.equal(pendingReturnDecision(open, scenario, activation), "hold");
  assert.equal(pendingReturnDecision(snapshot({ clock: activation - 1n, activation }), scenario, activation), "hold");
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
  assert.equal(heldWaitDecision({ blockHeight: 10n, lastValidBlockHeight: 9n, ready: true }), "submit");
  assert.equal(heldWaitDecision({ blockHeight: 4n, lastValidBlockHeight: 9n, ready: false }), "wait");
  assert.equal(heldWaitDecision({ blockHeight: 4n, lastValidBlockHeight: 9n, ready: true }), "submit");
  assert.match(STALE_AUTHORIZATION_EXPIRED_MESSAGE, /not a protection result/);
});

test("a polled block height cannot abandon the sealed stale authorization", async () => {
  const policy = await readFile(new URL("../lib/devnet-public.ts", import.meta.url), "utf8");
  const runner = policy.slice(policy.indexOf("export async function runStaleSubmission"), policy.indexOf("export async function submitHeld"));
  const submit = policy.slice(policy.indexOf("export async function submitHeld"), policy.indexOf("export async function readSessionBalances"));
  const beforeSend = runner.slice(0, runner.indexOf("ports.send(bytes)"));
  assert.equal(heldWaitDecision({ blockHeight: 50n, lastValidBlockHeight: 10n, ready: true }), "submit");
  assert.equal(heldWaitDecision({ blockHeight: 50n, lastValidBlockHeight: 10n, ready: false }), "wait");
  assert.doesNotMatch(beforeSend, /getBlockHeight|lastValidBlockHeight/);
  assert.match(beforeSend, /Uint8Array\.from\(held\.signedBytes\)/);
  assert.match(beforeSend, /assertSameSignedBytes\(held, bytes\)/);
  assert.match(submit, /skipPreflight:\s*true/);
  assert.match(runner, /finishKnown\(expectedSignature\)/);
  assert.equal(submit.match(/connection\.sendTransaction/g)?.length, 1);
  assert.doesNotMatch(`${runner}\n${submit}`, /getLatestBlockhash|signTransaction|compileTransaction|signAndSend|Promise\.race|while\s*\(\s*true\s*\)/);
  assert.equal(staleSendExpiry(new Error("Transaction simulation failed: Blockhash not found")), true);
  assert.equal(staleSendExpiry(new Error("Blockhash not found")), true);
  assert.equal(staleSendExpiry(new Error("block height exceeded")), true);
  assert.equal(staleSendExpiry(new Error("Block height exceeded for this transaction")), true);
  assert.equal(staleSendExpiry(new Error("network down")), false);
  assert.match(runner, /throw new StaleAuthorizationExpired\(\)/);
  assert.match(runner, /throw new SubmissionStatusUnknown\(expectedSignature\)/);
  assert.equal(classifyStaleSend({ kind: "error", error: new Error("blockhash not found") }, "sig"), "expired");
  assert.equal(classifyStaleSend({ kind: "error", error: new Error("block height exceeded") }, "sig"), "expired");
  assert.match(STALE_AUTHORIZATION_EXPIRED_MESSAGE, /not a protection result/);
});

test("a lost stale send is recovered from the sealed signature", async () => {
  const presented = compiledTransfer(DEMO_TRANSFER_RAW);
  const signedBytes = markedSignedWire(presented.transaction);
  const signature = signatureFromSignedBytes(signedBytes);
  assert.equal(signature, verifyWalletSignedTransaction(presented.transaction, signedBytes).signature);
  assert.equal(signature.length > 0, true);

  const held = {
    signedBytes,
    sha256: sha256Hex(signedBytes),
    lastValidBlockHeight: 9n,
    signature,
    guardInstructionIndex: 2,
    expectation: expectationForSnapshot(snapshot({ clock: 40n, activation: 50n })),
  };
  const confirmed = {
    signature,
    slot: 4n,
    error: { InstructionError: [2, { Custom: 12 }] },
    customError: { instructionIndex: 2, code: 12 },
    logs: [`Program ${reviewedProgramId} invoke [1]`],
    guardInstructionIndex: 2,
  };
  const clock = { now: 0 };
  const sleep = async (ms) => { clock.now += ms; };
  const ports = (send, observe) => ({
    send,
    observeSignature: observe,
    confirm: async (observed, guardInstructionIndex) => ({ ...confirmed, signature: observed, guardInstructionIndex }),
    timeoutMs: STALE_SEND_TIMEOUT_MS,
    recoveryWindowMs: STALE_STATUS_WINDOW_MS,
    pollMs: STALE_STATUS_POLL_MS,
    now: () => clock.now,
    sleep,
  });

  let sent = null;
  const matched = await runStaleSubmission(held, ports(
    async (bytes) => {
      sent = bytes;
      return signature;
    },
    async () => { throw new Error("status lookup is not used when send returns"); },
  ));
  assert.deepEqual(sent, signedBytes);
  assert.equal(sent === held.signedBytes, false);
  assert.equal(matched.signature, signature);
  assert.equal(matched.guardInstructionIndex, 2);
  assert.equal(acceptActivationRejection({
    outcome: matched,
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);

  await assert.rejects(
    runStaleSubmission(held, ports(async () => "different-signature", async () => false)),
    /different transaction signature/,
  );
  await assert.rejects(
    runStaleSubmission({ ...held, signature: "not-the-sealed-signature" }, ports(async () => signature, async () => false)),
    /does not match the signed bytes/,
  );

  for (const message of ["Blockhash not found", "block height exceeded"]) {
    let lookups = 0;
    await assert.rejects(
      runStaleSubmission(held, ports(
        async () => { throw new Error(message); },
        async () => { lookups += 1; return false; },
      )),
      (error) => error instanceof Error && error.name === "StaleAuthorizationExpired" && error.code === "STALE_AUTHORIZATION_EXPIRED",
    );
    assert.equal(lookups, 0);
  }

  clock.now = 0;
  let ambiguousLookups = 0;
  let ambiguousSends = 0;
  let checking = false;
  await assert.rejects(
    runStaleSubmission(held, {
      ...ports(
        () => { ambiguousSends += 1; return new Promise(() => undefined); },
        async (observed) => {
          assert.equal(observed, signature);
          ambiguousLookups += 1;
          return false;
        },
      ),
      onChecking: () => { checking = true; },
    }),
    (error) => error instanceof SubmissionStatusUnknown
      && error.code === "SUBMISSION_STATUS_UNKNOWN"
      && error.signature === signature
      && error.message === SUBMISSION_STATUS_UNKNOWN_MESSAGE
      && !(error instanceof Error && error.name === "StaleAuthorizationExpired"),
  );
  assert.equal(checking, true);
  assert.equal(ambiguousSends, 1);
  assert.equal(ambiguousLookups > 0, true);
  assert.equal(clock.now, STALE_SEND_TIMEOUT_MS + STALE_STATUS_WINDOW_MS);
  assert.doesNotMatch(SUBMISSION_STATUS_UNKNOWN_MESSAGE, /ActivationPhaseChanged|STALE_AUTHORIZATION_EXPIRED|protection result/);

  clock.now = 0;
  let foundLookups = 0;
  const recovered = await runStaleSubmission(held, ports(
    () => new Promise(() => undefined),
    async (observed) => {
      assert.equal(observed, signature);
      foundLookups += 1;
      return true;
    },
  ));
  assert.equal(foundLookups, 1);
  assert.equal(recovered.signature, signature);
  assert.equal(acceptActivationRejection({
    outcome: recovered,
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.equal(clock.now, STALE_SEND_TIMEOUT_MS);

  clock.now = 0;
  let networkSends = 0;
  await assert.rejects(
    runStaleSubmission(held, ports(
      async () => { networkSends += 1; throw new Error("network down"); },
      async () => false,
    )),
    (error) => error instanceof SubmissionStatusUnknown && networkSends === 1,
  );
  assert.equal(staleSendAmbiguous(new Error("network down")), true);
  assert.equal(classifyStaleSend({ kind: "pending" }, signature), "pending");
  assert.equal(classifyStaleSend({ kind: "error", error: new Error("network down") }, signature), "ambiguous");
  assert.notEqual(classifyStaleSend({ kind: "error", error: new Error("network down") }, signature), "rejected");

  const component = await readFile(new URL("../components/demo/live-devnet-experience.tsx", import.meta.url), "utf8");
  assert.match(component, /Checking whether the signed transaction reached Solana\.\.\./);
  assert.match(component, /SUBMISSION_STATUS_UNKNOWN_TITLE/);
  assert.match(component, /Expected signature \{expectedSignature \?\? "None"\}/);
  assert.match(component, /not confirmed/);
  assert.match(component, /setPhase\("unknown"\)/);
  const effect = component.slice(component.indexOf("submitHeld(held"), component.indexOf("async function connect"));
  const caught = effect.slice(effect.indexOf(".catch("));
  assert.equal(effect.includes("SUBMISSION_FAILED"), false);
  assert.ok(caught.indexOf('setPhase("unknown")') < caught.indexOf('setPhase("failed")'));
  assert.equal(Number.isFinite(STALE_SEND_TIMEOUT_MS) && STALE_SEND_TIMEOUT_MS > 0, true);
  assert.equal(Number.isFinite(STALE_STATUS_WINDOW_MS) && STALE_STATUS_WINDOW_MS > 0, true);
});

test("a known stale signature is reconciled after confirmation failure", async () => {
  const presented = compiledTransfer(DEMO_TRANSFER_RAW);
  const signedBytes = markedSignedWire(presented.transaction);
  const signature = signatureFromSignedBytes(signedBytes);
  const held = {
    signedBytes,
    sha256: sha256Hex(signedBytes),
    lastValidBlockHeight: 9n,
    signature,
    guardInstructionIndex: 2,
    expectation: expectationForSnapshot(snapshot({ clock: 40n, activation: 50n })),
  };
  const protectedOutcome = {
    signature,
    slot: 8n,
    error: { InstructionError: [2, { Custom: 12 }] },
    customError: { instructionIndex: 2, code: 12 },
    logs: [`Program ${reviewedProgramId} invoke [1]`, "Program log: EquityGuard rejected: ActivationPhaseChanged"],
    guardInstructionIndex: 2,
  };
  const clock = { now: 0 };
  const sleep = async (ms) => { clock.now += ms; };
  const base = () => ({
    timeoutMs: STALE_SEND_TIMEOUT_MS,
    recoveryWindowMs: STALE_STATUS_WINDOW_MS,
    pollMs: STALE_STATUS_POLL_MS,
    now: () => clock.now,
    sleep,
  });

  const events = [];
  let sends = 0;
  const reconciled = await runStaleSubmission(held, {
    ...base(),
    send: async (bytes) => {
      sends += 1;
      assert.deepEqual(bytes, signedBytes);
      events.push("sent");
      return signature;
    },
    onKnownSignature: (known) => {
      assert.equal(known, signature);
      events.push("known");
    },
    confirm: async (known) => {
      assert.equal(known, signature);
      events.push("confirm");
      throw new DevnetSubmissionError("CONFIRMATION_FAILED", `CONFIRMATION_FAILED. Signature ${known} was returned, but confirmation could not be established.`, known);
    },
    observeSignature: async (known) => {
      assert.equal(known, signature);
      events.push("status");
      return true;
    },
    readChainOutcome: async (known, guardInstructionIndex) => {
      assert.equal(known, signature);
      assert.equal(guardInstructionIndex, 2);
      events.push("meta");
      return protectedOutcome;
    },
  });
  assert.deepEqual(events, ["sent", "known", "confirm", "status", "meta"]);
  assert.equal(sends, 1);
  assert.equal(acceptActivationRejection({
    outcome: reconciled,
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);

  clock.now = 0;
  let unexpectedSends = 0;
  const unexpected = await runStaleSubmission(held, {
    ...base(),
    send: async () => { unexpectedSends += 1; return signature; },
    confirm: async () => { throw new DevnetSubmissionError("CONFIRMATION_FAILED", "CONFIRMATION_FAILED", signature); },
    observeSignature: async (known) => known === signature,
    readChainOutcome: async () => ({
      signature,
      slot: 9n,
      error: null,
      customError: null,
      logs: [`Program ${reviewedProgramId} success`, `Program ${TOKEN_2022_PROGRAM_ADDRESS} success`],
      guardInstructionIndex: 2,
    }),
  });
  assert.equal(unexpectedSends, 1);
  assert.equal(acceptActivationRejection({
    outcome: unexpected,
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.match(unexpectedStaleResultCopy(unexpected), /UNEXPECTED_ONCHAIN_RESULT/);

  clock.now = 0;
  const started = { at: null };
  let unresolvedSends = 0;
  let unresolvedLookups = 0;
  await assert.rejects(
    runStaleSubmission(held, {
      ...base(),
      send: async () => { unresolvedSends += 1; return signature; },
      onReconciling: () => { started.at = clock.now; },
      confirm: async () => { throw new DevnetSubmissionError("CONFIRMATION_FAILED", "CONFIRMATION_FAILED", signature); },
      observeSignature: async (known) => {
        assert.equal(known, signature);
        unresolvedLookups += 1;
        return false;
      },
      readChainOutcome: async () => { throw new Error("meta must wait for a visible status"); },
    }),
    (error) => error instanceof ConfirmationStatusUnknown
      && error.code === "CONFIRMATION_STATUS_UNKNOWN"
      && error.signature === signature
      && error.message === confirmationStatusUnknownMessage(signature),
  );
  assert.equal(unresolvedSends, 1);
  assert.equal(unresolvedLookups > 0, true);
  assert.equal(clock.now - started.at, STALE_STATUS_WINDOW_MS);
  clock.now = 0;
  let hungSends = 0;
  const hungConfirmation = await runStaleSubmission(held, {
    ...base(),
    send: async () => { hungSends += 1; return signature; },
    confirm: () => new Promise(() => undefined),
    observeSignature: async (known) => known === signature,
    readChainOutcome: async () => protectedOutcome,
  });
  assert.equal(hungSends, 1);
  assert.equal(acceptActivationRejection({
    outcome: hungConfirmation,
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.doesNotMatch(confirmationStatusUnknownMessage(signature), /ActivationPhaseChanged|STALE_AUTHORIZATION_EXPIRED|protection result|SUBMISSION_STATUS_UNKNOWN/);

  const policy = await readFile(new URL("../lib/devnet-public.ts", import.meta.url), "utf8");
  const recovery = policy.slice(policy.indexOf("async function reconcileKnownSignature"), policy.indexOf("async function finishKnownSignature"));
  const finish = policy.slice(policy.indexOf("async function finishKnownSignature"), policy.indexOf("async function signatureVisible"));
  assert.doesNotMatch(`${recovery}\n${finish}`, /sendTransaction|getLatestBlockhash|signTransaction|compileTransaction|signAndSend/);
  assert.match(recovery, /observeWithin\(ports\.observeSignature, signature/);
  assert.match(finish, /ports\.confirm\(signature, guardInstructionIndex\)/);
  assert.match(recovery, /throw new ConfirmationStatusUnknown\(signature\)/);

  const component = await readFile(new URL("../components/demo/live-devnet-experience.tsx", import.meta.url), "utf8");
  const panel = component.slice(component.indexOf('phase === "unconfirmed"'), component.indexOf('phase === "unknown"'));
  assert.match(panel, /CONFIRMATION_STATUS_UNKNOWN_TITLE/);
  assert.match(panel, /confirmationStatusUnknownMessage\(staleSignature\)/);
  assert.match(panel, /devnetExplorerUrl\(staleSignature\)/);
  assert.ok(panel.indexOf("confirmationStatusUnknownMessage(staleSignature)") < panel.indexOf("Start a new attempt"));
  assert.match(component, /onKnownSignature: \(signature\) => setStaleSignature\(signature\)/);
  assert.match(component, /Checking the on-chain result for the submitted transaction\.\.\./);
  assert.equal(CONFIRMATION_STATUS_UNKNOWN_TITLE, "CONFIRMATION_STATUS_UNKNOWN");
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
  const logs = [`Program ${reviewedProgramId} invoke [1]`];
  assert.equal(acceptActivationRejection({
    outcome: outcome(12, logs),
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.equal(acceptActivationRejection({
    outcome: outcome(9, logs),
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.equal(acceptActivationRejection({
    outcome: outcome(12, [...logs, `Program ${TOKEN_2022_PROGRAM_ADDRESS} success`]),
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.equal(acceptActivationRejection({
    outcome: outcome(12, logs),
    before: balances,
    after: { source: 900_000n, destination: 100_000n },
    programId: reviewedProgramId,
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
    logs: [`Program ${reviewedProgramId} success`, `Program ${TOKEN_2022_PROGRAM_ADDRESS} success`],
    guardInstructionIndex: 0,
  };
  assert.equal(acceptUpdatedExecution({
    outcome: success,
    before: balances,
    after: { source: 900_000n, destination: DEMO_TRANSFER_RAW },
    amount: DEMO_TRANSFER_RAW,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.equal(acceptUpdatedExecution({
    outcome: success,
    before: balances,
    after: balances,
    amount: DEMO_TRANSFER_RAW,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
});

test("Phantom signed responses become owned bytes and a substituted transaction is refused", async () => {
  const payload = Uint8Array.of(4, 5, 6, 7);
  const wrapped = phantomSignedTransaction({ signedTransaction: { serialize: () => payload } });
  const direct = phantomSignedTransaction({ serialize: () => payload });
  assert.deepEqual(wrapped, payload);
  assert.deepEqual(direct, payload);
  payload[0] = 1;
  assert.equal(wrapped[0], 4);
  wrapped[0] = 2;
  assert.equal(payload[0], 1);
  assert.equal(sha256Hex(wrapped).length, 64);

  const buffer = new Uint8Array(payload.buffer.slice(0)).buffer;
  assert.deepEqual(phantomSignedTransaction(buffer), Uint8Array.of(1, 5, 6, 7));
  assert.throws(() => phantomSignedTransaction(null), /no signed transaction bytes/);
  assert.throws(() => phantomSignedTransaction(undefined), /no signed transaction bytes/);
  assert.throws(() => phantomSignedTransaction({}), /no signed transaction bytes/);
  assert.throws(() => phantomSignedTransaction({ serialize: () => "not-bytes" }), /no signed transaction bytes/);
  assert.throws(() => phantomSignedTransaction({ serialize: () => new Uint8Array() }), /no signed transaction bytes/);
  assert.throws(() => phantomSignedTransaction({ serialize() { throw new Error("bad wire"); } }), /no signed transaction bytes/);
  await assert.rejects(
    Promise.reject(new Error("User rejected the request")).then((value) => phantomSignedTransaction(value)),
    /User rejected the request/,
  );

  const presented = compiledTransfer(DEMO_TRANSFER_RAW);
  const matching = markedSignedWire(presented.transaction);
  assert.equal(verifyWalletSignedTransaction(presented.transaction, matching).signature.length > 0, true);
  const substituted = compiledTransfer(DEMO_TRANSFER_RAW + 1n);
  assert.throws(
    () => verifyWalletSignedTransaction(presented.transaction, markedSignedWire(substituted.transaction)),
    /changed a protected transaction instruction/,
  );
});

function compiledTransfer(amount) {
  const transfer = getTransferCheckedInstruction({
    source, mint, destination, authority: signer, amount, decimals: 6,
  });
  const message = pipe(
    createTransactionMessage({ version: "legacy" }),
    (value) => setTransactionMessageFeePayer(wallet, value),
    (value) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 9n }, value),
    (value) => appendTransactionMessageInstructions([transfer], value),
  );
  return { transaction: compileTransaction(message) };
}

function markedSignedWire(transaction) {
  const wire = Uint8Array.from(getTransactionEncoder().encode(transaction));
  const signatureCount = wire[0];
  assert.equal(signatureCount, 1);
  wire[1] = 9;
  return wire;
}

test("a landed ActivationPhaseChanged rejection is recognized at the guard index", async () => {
  const root = new URL("../", import.meta.url);
  const [policy, component] = await Promise.all([
    readFile(new URL("lib/devnet-public.ts", root), "utf8"),
    readFile(new URL("components/demo/live-devnet-experience.tsx", root), "utf8"),
  ]);
  const submit = policy.slice(policy.indexOf("export async function submitHeld"), policy.indexOf("export async function readSessionBalances"));
  const setupSend = policy.slice(policy.indexOf("async function signAndSend"), policy.indexOf("function encodeWire"));
  const prepare = policy.slice(policy.indexOf("export async function prepareLiveSession"), policy.indexOf("export async function authorizePending"));
  const updated = policy.slice(policy.indexOf("export async function authorizeUpdated"), policy.indexOf("export function detectPhantom"));
  assert.match(submit, /skipPreflight:\s*true/);
  assert.match(setupSend, /skipPreflight:\s*false/);
  assert.doesNotMatch(setupSend, /skipPreflight:\s*true/);
  assert.match(prepare, /signAndSend\(/);
  assert.doesNotMatch(prepare, /skipPreflight:\s*true/);
  assert.match(updated, /signAndSend\(/);
  assert.doesNotMatch(updated, /skipPreflight:\s*true/);

  const chainError = { InstructionError: [2n, { Custom: 12n }] };
  assert.deepEqual(parseCustomError(chainError), { instructionIndex: 2, code: 12 });
  const logs = [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]",
    "Program ComputeBudget111111111111111111111111111111 success",
    `Program ${reviewedProgramId} invoke [1]`,
    "Program log: EquityGuard rejected: ActivationPhaseChanged",
    `Program ${reviewedProgramId} failed: custom program error: 0xc`,
  ];
  const outcome = {
    signature: "landed-stale-signature",
    slot: 3n,
    error: chainError,
    customError: parseCustomError(chainError),
    logs,
    guardInstructionIndex: 2,
  };
  assert.equal(acceptActivationRejection({
    outcome,
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), true);
  assert.equal(acceptActivationRejection({
    outcome: { ...outcome, guardInstructionIndex: 0 },
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);
  assert.equal(acceptActivationRejection({
    outcome: { ...outcome, logs: [...logs, `Program ${TOKEN_2022_PROGRAM_ADDRESS} success`] },
    before: balances,
    after: balances,
    programId: reviewedProgramId,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  }), false);

  const effect = component.slice(component.indexOf("submitHeld(held,"), component.indexOf("async function connect"));
  assert.ok(effect.indexOf("setStaleSignature(outcome.signature)") < effect.indexOf("acceptActivationRejection"));
  assert.doesNotMatch(effect, /setStaleSignature\(null\)/);
  const preflight = staleSendFailure(new Error("Transaction simulation failed"));
  const submission = staleSendFailure(new Error("network down"));
  assert.equal(preflight.kind, "PREFLIGHT_REJECTED");
  assert.equal(preflight.signature, null);
  assert.equal(submission.kind, "SUBMISSION_FAILED");
  assert.doesNotMatch(`${preflight.message} ${submission.message}`, /confirmed transaction/i);
  const diagnostic = unexpectedStaleResultCopy({
    ...outcome,
    customError: { instructionIndex: 0, code: 9 },
    logs: ["Program log: EquityGuard rejected: MultiplierChanged"],
  });
  assert.match(diagnostic, /UNEXPECTED_ONCHAIN_RESULT/);
  assert.match(diagnostic, /MultiplierChanged/);
  assert.match(diagnostic, /landed-stale-signature/);
  assert.match(component, /View stale transaction on Solana Explorer/);
});
