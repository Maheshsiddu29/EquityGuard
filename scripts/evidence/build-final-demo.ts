/**
 * Builds the canonical final-demo evidence package from one preserved run
 * record. Read-only: it reads the run file and the artifacts it references,
 * verifies everything it can independently, and writes only into
 * `evidence/final-demo/`.
 *
 * It never contacts a validator. The run's transaction slots are pruned long
 * before packaging, so the transaction facts come from the validator records
 * the coordinator captured server-side *during* the run — and every one of
 * them is re-derived here rather than copied:
 *
 *  - the v0 wire is re-serialized from the validator's own JSON and hashed;
 *  - the Ed25519 signature is verified over that reconstructed message;
 *  - the guard payload is decoded from the signed bytes and its downstream
 *    commitment recomputed from the runtime-resolved (lookup-table-expanded)
 *    account set;
 *  - the coordinator's timing evidence is recomputed from its own recorded
 *    Clock, `localT` and the phase in the signed payload.
 *
 * That last point matters: an earlier schema wrote `simulatedBeforeLocalT` /
 * `receivedBeforeLocalT` as literal `true`, which was only ever correct for
 * the pre-activation leg. Those fields are ignored here. The package carries
 * the derived, phase-neutral relation instead, and records that the raw file
 * still contains the superseded booleans so the discrepancy is visible rather
 * than quietly corrected.
 *
 * Usage: node scripts/evidence/build-final-demo.ts <run-file> [--out <dir>]
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  JUPITER_SUFFIX_COMMITMENT_DOMAIN,
  JUPITER_V6_PROGRAM_ADDRESS,
} from "../../packages/guard-client/src/index.ts";

const ROOT = resolve(new URL("../../", import.meta.url).pathname);
/** This script's own repo-relative path, so a rename cannot leave a stale self-reference. */
const SELF = resolve(new URL(import.meta.url).pathname).slice(ROOT.length + 1);
const args = process.argv.slice(2);
const runPath = args.find((a) => !a.startsWith("--"));
const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] ?? "evidence/final-demo" : "evidence/final-demo";
if (!runPath) throw new Error("usage: build-final-demo.mjs <run-file> [--out <dir>]");

// Pinned addresses come from the SDK, so the evidence cannot drift from the
// constants the program and client are actually built against.
const GUARD: string = EQUITY_GUARD_DEVNET_PROGRAM_ID;
const JUP: string = JUPITER_V6_PROGRAM_ADDRESS;
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const PHANTOM = "CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X";
const USDC_ATA = "7xd18PpPsvi8CmmP5Xr6rVQ63jUeQ2CqJ7i4yqZzmok9";
const KOX_ATA = "AnrbNfooXzzthu4kndCspVEEMo14wn8VQYJC6kFqonVj";
const KOX_MINT = "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ";
const SUFFIX_DOMAIN = Buffer.from(JUPITER_SUFFIX_COMMITMENT_DOMAIN);
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58d = (str: string): Buffer => {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58: ${str}`);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c !== "1") break; out.unshift(0); }
  return Buffer.from(out);
};
const cu16 = (n: number): Buffer => { const o = []; do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
const key32 = (k: string): Buffer => { const b = b58d(k); if (b.length !== 32) throw new Error(`key length ${b.length} for ${k}`); return b; };
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const fileSha = (p: string): string | null => (existsSync(resolve(ROOT, p)) ? sha(readFileSync(resolve(ROOT, p))) : null);

const checks: { id: string; passed: boolean; evidence: string }[] = [];
function check(id: string, passed: boolean, evidence = ""): void {
  checks.push({ id, passed, evidence });
  if (!passed) throw new Error(`FAILED: ${id} ${evidence}`);
}

/** Re-serializes a v0 transaction exactly from the validator's json encoding. */
function wireFromJson(t: any): Buffer {
  const m = t.transaction.message;
  if (t.version !== 0) throw new Error("expected a v0 transaction");
  const parts = [
    cu16(t.transaction.signatures.length), ...(t.transaction.signatures as string[]).map(b58d),
    Buffer.from([0x80, m.header.numRequiredSignatures, m.header.numReadonlySignedAccounts, m.header.numReadonlyUnsignedAccounts]),
    cu16(m.accountKeys.length), ...(m.accountKeys as string[]).map(key32), key32(m.recentBlockhash), cu16(m.instructions.length),
  ];
  for (const ix of m.instructions as any[]) {
    const d = b58d(ix.data);
    parts.push(Buffer.from([ix.programIdIndex]), cu16(ix.accounts.length), Buffer.from(ix.accounts), cu16(d.length), d);
  }
  parts.push(cu16(m.addressTableLookups.length));
  for (const l of m.addressTableLookups as any[]) {
    parts.push(key32(l.accountKey), cu16(l.writableIndexes.length), Buffer.from(l.writableIndexes),
      cu16(l.readonlyIndexes.length), Buffer.from(l.readonlyIndexes));
  }
  return Buffer.concat(parts);
}

/** Runtime-resolved account list and its transaction-level flags. */
function resolved(t: any) {
  const m = t.transaction.message;
  const la = t.meta.loadedAddresses ?? { writable: [], readonly: [] };
  const keys = [...m.accountKeys, ...la.writable, ...la.readonly];
  const ns = m.accountKeys.length;
  const { numRequiredSignatures: sig, numReadonlySignedAccounts: ros, numReadonlyUnsignedAccounts: rou } = m.header;
  const flags = (i: number) => ({
    signer: i < sig,
    writable: i < sig ? i < sig - ros : i < ns ? i < ns - rou : i < ns + la.writable.length,
  });
  return { keys, flags };
}

/** SHA-256 of the kind 2/3 downstream commitment over every instruction after the guard. */
function suffixCommitment(t: any): string {
  const m = t.transaction.message;
  const { keys, flags } = resolved(t);
  const suffix = m.instructions.slice(1);
  const parts = [SUFFIX_DOMAIN, u32(suffix.length)];
  for (const ix of suffix as any[]) {
    parts.push(key32(keys[ix.programIdIndex]), u32(ix.accounts.length));
    for (const ai of ix.accounts as number[]) {
      const f = flags(ai);
      parts.push(key32(keys[ai]), Buffer.from([f.signer ? 1 : 0, f.writable ? 1 : 0]));
    }
    const d = b58d(ix.data);
    parts.push(u32(d.length), d);
  }
  return sha(Buffer.concat(parts));
}
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

/** Decodes the ABI v2 guard payload out of the signed transaction. */
function guardPayload(t: any) {
  const m = t.transaction.message;
  const { keys } = resolved(t);
  const ix0 = m.instructions[0];
  if (keys[ix0.programIdIndex] !== GUARD) throw new Error("instruction 0 is not EquityGuard");
  const d = b58d(ix0.data);
  if (d.length !== 99 || d[0] !== 2) throw new Error(`guard payload ${d.length} bytes, version ${d[0]}`);
  return {
    version: d[0],
    expectedMint: [...d.subarray(1, 33)],
    multiplierHex: d.subarray(33, 41).toString("hex"),
    newMultiplierHex: d.subarray(41, 49).toString("hex"),
    effectiveTimestamp: d.readBigInt64LE(49).toString(),
    expectedPhase: d[57] === 0 ? "PENDING" : "ACTIVATED",
    beforeSecs: d.readUInt32LE(58),
    afterSecs: d.readUInt32LE(62),
    adapterKind: d.readUInt8(66),
    downstreamCommitment: d.subarray(67, 99).toString("hex"),
    messageBytes: null,
  };
}

function verifyEd25519(signerB58: string, message: Buffer, signature: Buffer): boolean {
  const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI, key32(signerB58)]), format: "der", type: "spki" });
  return verify(null, message, pub, signature);
}

const tokenBalance = (arr: any, acct: string, keys: string[]): bigint => {
  const e = (arr ?? []).find((b: any) => keys[b.accountIndex] === acct);
  return e ? BigInt(e.uiTokenAmount.amount) : 0n;
};

// ------------------------------------------------------------------- build

const run = JSON.parse(readFileSync(resolve(ROOT, runPath), "utf8"));
const runSha = sha(readFileSync(resolve(ROOT, runPath)));
const localT = BigInt(run.armed.localT);
const attest = run.coordinatorAttestations;

check("RUN_HAS_BOTH_LEGS", Boolean(run.browserProof?.stale && run.browserProof?.refreshed));
check("RUN_HAS_TWO_COORDINATOR_PROOFS", attest.preSignSimulations.length === 2 && attest.signedAuthorizations.length === 2);
check("RUN_HAS_TWO_VALIDATOR_RECORDS", Object.keys(run.validatorMetadata).length === 2);

const legs: Record<string, any> = {};
for (const leg of ["stale", "refreshed"]) {
  const p = run.browserProof[leg];
  const o = p.outcome;
  const t = run.validatorMetadata[o.signature];
  const K = leg.toUpperCase();
  check(`${K}_VALIDATOR_RECORD_PRESENT`, Boolean(t), o.signature);

  const wire = wireFromJson(t);
  const wireSha = sha(wire);
  const message = wire.subarray(1 + 64);
  const signature = b58d(t.transaction.signatures[0]);
  const { keys } = resolved(t);

  check(`${K}_RECONSTRUCTED_WIRE_MATCHES_HELD_HASH`, wireSha === p.signedWireHashBeforeActivation, wireSha);
  check(`${K}_HELD_HASH_UNCHANGED_AT_SUBMISSION`, p.signedWireHashBeforeActivation === p.signedWireHashAtSubmission);
  check(`${K}_EXACT_BYTE_EQUALITY`, p.exactEquality === true);
  check(`${K}_WIRE_LENGTH`, wire.length === p.wireLength, String(wire.length));
  check(`${K}_SIGNATURE_VERIFIES_UNDER_PHANTOM`, verifyEd25519(PHANTOM, message, signature), t.transaction.signatures[0]);
  check(`${K}_SINGLE_SIGNER_IS_FEE_PAYER_PHANTOM`,
    t.transaction.message.header.numRequiredSignatures === 1 && keys[0] === PHANTOM && t.transaction.signatures[0] === o.signature);

  const payload = guardPayload(t);
  check(`${K}_GUARD_PAYLOAD_IS_ABI_V2_JUPITER`, payload.version === 2 && [2, 3].includes(payload.adapterKind));
  check(`${K}_GUARD_PROTECTS_KOX`, Buffer.from(payload.expectedMint).equals(key32(KOX_MINT)));
  check(`${K}_GUARD_NAMES_ARMED_ACTIVATION`, payload.effectiveTimestamp === localT.toString(), payload.effectiveTimestamp);
  check(`${K}_SUFFIX_COMMITMENT_RECOMPUTES`, suffixCommitment(t) === payload.downstreamCommitment, payload.downstreamCommitment);

  // Coordinator timing, re-derived from its own primitives (never from the
  // superseded phase-specific booleans in the raw file).
  const pre = attest.preSignSimulations.find((r: any) => r.shape.encodedPhase === payload.expectedPhase);
  const rec = attest.signedAuthorizations.find((r: any) => r.proofId === pre?.proofId);
  check(`${K}_COORDINATOR_PROOF_FOR_THIS_PHASE`, Boolean(pre && rec), payload.expectedPhase);
  const required = payload.expectedPhase === "PENDING" ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
  const timingOf = (r: any) => {
    const clock = BigInt(r.clock.unixTimestamp);
    const observed = clock < localT ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
    return {
      source: "LOCAL_COORDINATOR",
      clock: r.clock,
      localT: localT.toString(),
      encodedPhase: payload.expectedPhase,
      clockRelationToLocalT: observed,
      requiredRelationToLocalT: required,
      clockMatchesExpectedPhase: observed === required,
    };
  };
  const preTiming = timingOf(pre);
  const recTiming = timingOf(rec);
  check(`${K}_PRE_SIGN_CLOCK_MATCHES_ENCODED_PHASE`, preTiming.clockMatchesExpectedPhase, `${preTiming.clockRelationToLocalT} for ${payload.expectedPhase}`);
  check(`${K}_SIGNED_RECEIPT_CLOCK_MATCHES_ENCODED_PHASE`, recTiming.clockMatchesExpectedPhase, `${recTiming.clockRelationToLocalT} for ${payload.expectedPhase}`);
  check(`${K}_COORDINATOR_SIMULATION_SUCCEEDED`, pre.err === null && pre.programsSucceeded.length === 3, `units ${pre.computeUnits}`);
  check(`${K}_SIGNED_MESSAGE_IS_THE_SIMULATED_MESSAGE`, rec.messageSha256 === pre.messageSha256 && rec.messageMatchesSimulated === true);
  check(`${K}_COORDINATOR_VERIFIED_THE_SIGNATURE`, rec.signatureVerified === true && rec.signer === PHANTOM);
  check(`${K}_COORDINATOR_ATTESTED_THE_SUBMITTED_WIRE`, rec.signedWireSha256 === wireSha, rec.signedWireSha256);

  check(`${K}_DEPLOYMENT_REATTESTED_BEFORE_SIGN_AND_SUBMIT`,
    p.deploymentAttestations.length === 2 && p.deploymentAttestations.every((d: any) => d.matched)
    && p.deploymentAttestations[0].digest === p.deploymentAttestations[1].digest);

  const logs: string[] = t.meta.logMessages ?? [];
  const invoked = (pid: string) => logs.some((l) => l.startsWith(`Program ${pid} invoke [`));
  const usdc = { before: tokenBalance(t.meta.preTokenBalances, USDC_ATA, keys), after: tokenBalance(t.meta.postTokenBalances, USDC_ATA, keys) };
  const kox = { before: tokenBalance(t.meta.preTokenBalances, KOX_ATA, keys), after: tokenBalance(t.meta.postTokenBalances, KOX_ATA, keys) };

  if (leg === "stale") {
    check("STALE_ENCODES_PENDING", payload.expectedPhase === "PENDING");
    check("STALE_REJECTED_AT_INSTRUCTION_0_CUSTOM_12",
      JSON.stringify(t.meta.err) === JSON.stringify({ InstructionError: [0, { Custom: 12 }] }), JSON.stringify(t.meta.err));
    check("STALE_EQUITYGUARD_INVOKED", invoked(GUARD));
    check("STALE_JUPITER_ABSENT", !invoked(JUP) && !logs.some((l) => l.includes(JUP)));
    check("STALE_WHIRLPOOL_ABSENT", !invoked(WHIRLPOOL) && !logs.some((l) => l.includes(WHIRLPOOL)));
    check("STALE_NO_TOKEN_MOVEMENT", usdc.before === usdc.after && kox.before === kox.after, `usdc ${usdc.before} kox ${kox.before}`);
    check("STALE_SOL_CHANGE_IS_FEE_ONLY", BigInt(t.meta.preBalances[0]) - BigInt(t.meta.postBalances[0]) === BigInt(t.meta.fee), `fee ${t.meta.fee}`);
    check("STALE_EXECUTED_AFTER_ACTIVATION", BigInt(t.blockTime) > localT, `blockTime ${t.blockTime} > ${localT}`);
    check("STALE_SUBMITTED_WITH_SKIPPREFLIGHT", o.skipPreflight === true);
  } else {
    check("REFRESHED_ENCODES_ACTIVATED", payload.expectedPhase === "ACTIVATED");
    check("REFRESHED_SUCCEEDED", t.meta.err === null);
    check("REFRESHED_EQUITYGUARD_PASSED", invoked(GUARD) && logs.includes(`Program ${GUARD} success`));
    check("REFRESHED_JUPITER_EXECUTED", invoked(JUP) && logs.includes(`Program ${JUP} success`));
    check("REFRESHED_WHIRLPOOL_EXECUTED", invoked(WHIRLPOOL) && logs.includes(`Program ${WHIRLPOOL} success`));
    check("REFRESHED_USDC_SPENT", usdc.before === 5_000_000n && usdc.after === 0n, `${usdc.before} -> ${usdc.after}`);
    check("REFRESHED_KOX_RECEIVED", kox.before === 0n && kox.after === 5_504_261n, `${kox.before} -> ${kox.after}`);
    check("REFRESHED_PREFLIGHT_ENABLED", o.skipPreflight === false);
  }

  legs[leg] = {
    signature: o.signature, slot: String(t.slot), blockTime: t.blockTime,
    encodedPhase: payload.expectedPhase, signedWireSha256: wireSha, wireLengthBytes: wire.length,
    messageSha256: pre.messageSha256, exactByteEquality: true,
    downstreamCommitment: payload.downstreamCommitment,
    protectionWindow: { beforeSecs: payload.beforeSecs, afterSecs: payload.afterSecs },
    err: t.meta.err, computeUnits: t.meta.computeUnitsConsumed ?? null, feeLamports: t.meta.fee,
    equityGuardInvoked: invoked(GUARD), jupiterInvoked: invoked(JUP), whirlpoolInvoked: invoked(WHIRLPOOL),
    balances: { usdc: { before: String(usdc.before), after: String(usdc.after) }, kox: { before: String(kox.before), after: String(kox.after) } },
    skipPreflight: o.skipPreflight,
    blockhash: t.transaction.message.recentBlockhash,
    lifetime: p.lifetime,
    coordinator: { preSignSimulation: { ...preTiming, proofId: pre.proofId, computeUnits: pre.computeUnits, programsSucceeded: pre.programsSucceeded }, signedAuthorizationReceipt: { ...recTiming, proofId: rec.proofId, signer: rec.signer, signature: rec.signature, signedWireSha256: rec.signedWireSha256 } },
    deploymentAttestations: p.deploymentAttestations,
    reconstructedWireBase64: wire.toString("base64"),
    logs,
  };
}

check("LEGS_ARE_DISTINCT_AUTHORIZATIONS",
  legs.stale.signedWireSha256 !== legs.refreshed.signedWireSha256 && legs.stale.signature !== legs.refreshed.signature);
check("BOTH_LEGS_COMMIT_TO_THE_SAME_TRADE", legs.stale.downstreamCommitment === legs.refreshed.downstreamCommitment);
check("STALE_SIGNED_BEFORE_REFRESHED_BUILT",
  BigInt(legs.stale.coordinator.signedAuthorizationReceipt.clock.unixTimestamp) < BigInt(legs.refreshed.coordinator.preSignSimulation.clock.unixTimestamp));

const references: { path: string; role: string; tracked: boolean; sha256: string | null }[] = ([
  ["scripts/demo/fixtures/ko-corporate-action-2026-09.json", "sealed KOx Sep 15 curated observations (market evidence)", true],
  ["apps/reference/data/kox-trade-replay.json", "earlier recorded replay evidence displayed in the demo", true],
  ["scripts/demo/fixtures/jupiter-liquidity-2026-09-15.json", "Jupiter liquidity capture", true],
  ["tmp/m9d-c1/route-fixture.json", "Sep 17 mainnet-derived Jupiter route fixture", false],
  ["tmp/m9d-c1/accounts/XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ.json", "captured KOx mint account (source for the derived local mint)", false],
  ["target/deploy/equity_guard.so", "EquityGuard program binary loaded by the local validator", false],
] as [string, string, boolean][]).map(([path, role, tracked]) => ({ path, role, tracked, sha256: fileSha(path) }));
check("ALL_REFERENCES_RESOLVE", references.every((r) => r.sha256 !== null), references.filter((r) => !r.sha256).map((r) => r.path).join(","));
check("REVIEWED_ELF_MATCHES_ATTESTED",
  references.find((r) => r.path.endsWith("equity_guard.so"))!.sha256 === run.armed.deployment.reviewedElfSha256);

const executionProof = {
  schemaVersion: 2,
  environment: { type: "LOCAL_EXECUTION_REPRODUCTION", rpc: "http://127.0.0.1:8899", mainnetExecution: false },
  claimBoundary: {
    realMarketEvidence: "Recorded Sep 15 KOx Solana mainnet economic-state transition.",
    routeEvidence: "Independently captured Sep 17 mainnet-derived Jupiter route.",
    liveExecution: "Local solana-test-validator reproduction using compiled EquityGuard, Jupiter and Whirlpool programs.",
    notClaimed: [
      "mainnet EquityGuard execution",
      "live mainnet KOx purchase",
      "the local validator ran at the historical Sep 15 time",
      "the Jupiter route was captured during the Sep 15 event",
      "a post-run live validator re-query of the demo transactions succeeded",
    ],
  },
  schemaNote: {
    supersededFields: ["simulatedBeforeLocalT", "receivedBeforeLocalT"],
    reason:
      "The run record still carries these phase-specific booleans as literal true. They were correct only for the PENDING leg; the ACTIVATED leg is attested at or after localT by construction, so on that leg the booleans contradict the record's own clock. They are ignored here. Every timing statement in this package is re-derived from the coordinator's recorded clock, localT and the activation phase decoded from the signed payload.",
    rawRunFileUnmodified: true,
  },
  sourceRun: { file: runPath, tracked: false, sha256: runSha },
  activation: {
    localT: localT.toString(), configuredDelaySeconds: run.armed.configuredDelay,
    clockAtArm: run.armed.clock, setupSignature: run.armed.setupSignature, setupAuthority: run.armed.setupAuthority,
    localMintProvenance: run.provenance,
  },
  deployment: { ...run.armed.deployment, digest: run.armed.deploymentDigest, reattestations: attest.deploymentReattestations },
  wallet: { type: "Phantom", method: "signTransaction", publicKey: PHANTOM, signAndSendTransactionUsed: false },
  legs,
  verificationSource: {
    liveValidatorRequeryAvailableAfterRun: false,
    detail:
      "The local validator prunes the demo transaction slots well before packaging. Transaction facts come from the validator records the coordinator captured server-side from http://127.0.0.1:8899 during the run; this package re-serializes the v0 wire from each record, re-verifies the Ed25519 signature over it, and recomputes the downstream commitment from the runtime-resolved account set. No post-run live re-query was performed.",
  },
};

const verificationReport = {
  schemaVersion: 2,
  subject: "final remediated Phantom activation-crossing run",
  sourceRun: { file: runPath, sha256: runSha },
  generatedBy: { script: SELF, sha256: fileSha(SELF) },
  summary: { totalChecks: checks.length, passed: checks.filter((c) => c.passed).length, failed: checks.filter((c) => !c.passed).length },
  method: "Every check is re-derived from the preserved run record and the artifacts it references. Nothing is copied from the browser's own claims.",
  checks,
};

const outPath = resolve(ROOT, outDir);
mkdirSync(outPath, { recursive: true });
const write = (name: string, value: unknown): string => {
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(resolve(outPath, name), text);
  return sha(Buffer.from(text));
};
const executionSha = write("execution-proof.json", executionProof);
const verificationSha = write("verification-report.json", verificationReport);

const manifest = {
  schemaVersion: 2,
  createdFrom: "final remediated Phantom activation-crossing run",
  generatedBy: SELF,
  files: { "execution-proof.json": { sha256: executionSha }, "verification-report.json": { sha256: verificationSha } },
  sourceRun: { file: runPath, tracked: false, sha256: runSha },
  execution: {
    staleSignature: legs.stale.signature, staleSignedWireSha256: legs.stale.signedWireSha256,
    refreshedSignature: legs.refreshed.signature, refreshedSignedWireSha256: legs.refreshed.signedWireSha256,
    wireLengthBytes: legs.stale.wireLengthBytes, localT: localT.toString(),
  },
  deployment: { ...run.armed.deployment, digest: run.armed.deploymentDigest },
  references,
  claimBoundary: executionProof.claimBoundary,
  schemaNote: executionProof.schemaNote,
};
write("manifest.json", manifest);

console.log(`${checks.length}/${checks.length} checks passed`);
console.log(`execution-proof.json      ${executionSha}`);
console.log(`verification-report.json  ${verificationSha}`);
console.log(`written to ${outDir}`);
