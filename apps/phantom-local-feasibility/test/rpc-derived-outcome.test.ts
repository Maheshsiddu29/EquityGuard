import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import type { Signature } from "@solana/kit";

import { EQUITY_GUARD_DEVNET_PROGRAM_ID, JUPITER_V6_PROGRAM_ADDRESS } from "../../../packages/guard-client/src/index.ts";
import { confirmReplay, type PreparedReplay } from "../src/replay-execution.ts";
import { EXPECTED_PHANTOM, EXPECTED_PHANTOM_KOX_ATA, EXPECTED_PHANTOM_USDC_ATA } from "../src/local-funding.ts";
import { reproductionMessage } from "../src/reproduction-view.ts";

const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const SIGNATURE = "4Ruxk7BnuFrrSuBuQwGAmAGWVdycq9ctHqvDv1qJqv8hSSJPJ7EmZnWvWKVcMpWNkyj2Tn4ofNpULpb8wWSmWhKX" as Signature;
const GUARD_FAILED = [
  `Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} invoke [1]`,
  "Program log: EquityGuard: ActivationPhaseChanged",
  `Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} failed: custom program error: 0xc`,
];
const EXECUTED = [
  `Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} invoke [1]`, `Program ${EQUITY_GUARD_DEVNET_PROGRAM_ID} success`,
  `Program ${JUPITER_V6_PROGRAM_ADDRESS} invoke [1]`, `Program ${WHIRLPOOL} invoke [2]`,
  `Program ${WHIRLPOOL} success`, `Program ${JUPITER_V6_PROGRAM_ADDRESS} success`,
];

/** Mutable local ledger the mock validator reports; the test never hands the view an outcome. */
const chain = {
  slot: 0, err: null as unknown, logs: [] as string[], units: 0, signer: EXPECTED_PHANTOM as string,
  usdc: 5_000_000n, kox: 0n,
};
let server: Server;
let rpcUrl = "";

function tokenAccount(amount: bigint): string {
  const bytes = Buffer.alloc(165);
  bytes.writeBigUInt64LE(amount, 64);
  return bytes.toString("base64");
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      if (method === "getTransaction") {
        return reply({
          slot: chain.slot, blockTime: 1, version: 0,
          meta: { err: chain.err, logMessages: chain.logs, computeUnitsConsumed: chain.units, fee: 5000,
            preBalances: [], postBalances: [], innerInstructions: [], loadedAddresses: { readonly: [], writable: [] } },
          transaction: { signatures: [SIGNATURE], message: {
            header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
            accountKeys: [chain.signer], instructions: [], recentBlockhash: "11111111111111111111111111111111" } },
        });
      }
      if (method === "getAccountInfo") {
        const amount = params[0] === EXPECTED_PHANTOM_USDC_ATA ? chain.usdc : chain.kox;
        return reply({ context: { slot: chain.slot }, value: { data: [tokenAccount(amount), "base64"],
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1, executable: false, rentEpoch: 0, space: 165 } });
      }
      if (method === "getBlockHeight") return reply(1);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: method } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  rpcUrl = `http://127.0.0.1:${port}`;
});
after(() => { server.close(); });

function prepared(kind: "STALE" | "REFRESHED"): PreparedReplay {
  return {
    kind, sourceAta: EXPECTED_PHANTOM_USDC_ATA, destinationAta: EXPECTED_PHANTOM_KOX_ATA,
    requiredSigner: EXPECTED_PHANTOM, feePayer: EXPECTED_PHANTOM, lastValidBlockHeight: 150n,
    authorizationSource: "LOCAL_EXECUTION_REPRODUCTION", skipPreflight: kind === "STALE",
  } as unknown as PreparedReplay;
}
const BEFORE = { usdc: 5_000_000n, kox: 0n };
/** The stale leg is authorized before the activation, so PENDING / before. */
const STALE_TIMING = {
  encodedPhase: "PENDING",
  clockRelationToLocalT: "BEFORE_ACTIVATION",
  requiredRelationToLocalT: "BEFORE_ACTIVATION",
  clockMatchesExpectedPhase: true,
} as const;

/**
 * A complete proof: the browser's own readings plus the local coordinator's
 * authoritative pre-sign and signed-receipt attestations (EG-A-03) and its
 * two deployment re-attestations (EG-A-02).
 */
const heldProof = (outcome: Awaited<ReturnType<typeof confirmReplay>>) => ({
  outcome, localT: 100n, atSigning: { unixTimestamp: 95n, slot: 1n }, atSubmission: { unixTimestamp: 101n, slot: 2n },
  lifetime: { valid: true, height: 90n, lastValidBlockHeight: 150n }, exactEquality: true,
  signedWireHashBeforeActivation: "ab", signedWireHashAtSubmission: "ab",
  preSign: { proofId: "presign-1", messageSha256: "msg", timing: STALE_TIMING, source: "LOCAL_COORDINATOR" as const },
  signedAuthorization: {
    proofId: "presign-1", messageSha256: "msg", signedWireSha256: "ab",
    messageMatchesSimulated: true as const, timing: STALE_TIMING,
    signatureVerified: true as const, source: "LOCAL_COORDINATOR" as const,
  },
  deploymentAttestations: [
    { stage: "PRE_SIGN" as const, digest: "guard-digest", matched: true as const },
    { stage: "PRE_SUBMISSION" as const, digest: "guard-digest", matched: true as const },
  ] as const,
});
function stale(): void {
  Object.assign(chain, { slot: 4242, err: { InstructionError: [0, { Custom: 12 }] }, logs: GUARD_FAILED, units: 11_017,
    signer: EXPECTED_PHANTOM, usdc: 5_000_000n, kox: 0n });
}
function refreshed(): void {
  Object.assign(chain, { slot: 4300, err: null, logs: EXECUTED, units: 187_654,
    signer: EXPECTED_PHANTOM, usdc: 0n, kox: 5_504_261n });
}

test("stale outcome fields are decoded from confirmed RPC metadata, not asserted", async () => {
  stale();
  const outcome = await confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl);
  assert.equal(outcome.slot, 4242n);
  assert.equal(outcome.failedInstruction, 0);
  assert.equal(outcome.customCode, 12);
  assert.equal(outcome.guardErrorName, "ActivationPhaseChanged");
  assert.equal(outcome.guardInvoked, true);
  assert.equal(outcome.jupiterInvoked, false);
  assert.equal(outcome.whirlpoolInvoked, false);
  assert.equal(outcome.computeUnits, "11017");
  assert.deepEqual(outcome.after, BEFORE);
  const view = reproductionMessage(heldProof(outcome));
  assert.match(view, /EquityGuard\s+Rejected/);
  assert.match(view, /Jupiter\s+Not invoked/);
  assert.match(view, /Whirlpool\s+Not invoked/);
  assert.match(view, /Token movement\s+0\n/);
});

test("stale rejection is never rendered when the ledger shows downstream execution, movement, or another error", async () => {
  stale(); chain.logs = [...GUARD_FAILED, `Program ${JUPITER_V6_PROGRAM_ADDRESS} invoke [1]`];
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl), /fail-closed/);
  stale(); chain.logs = [...GUARD_FAILED, `Program ${WHIRLPOOL} invoke [2]`];
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl), /fail-closed/);
  stale(); chain.kox = 1n;
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl), /fail-closed/);
  stale(); chain.err = { InstructionError: [0, { Custom: 13 }] };
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl), /fail-closed/);
  stale(); chain.err = { InstructionError: [3, { Custom: 12 }] };
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl), /fail-closed/);
  stale(); chain.signer = "11111111111111111111111111111111";
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl), /signer\/fee payer/);
});

test("refreshed success and KOx amount come from the ledger's token balances", async () => {
  refreshed();
  const outcome = await confirmReplay(prepared("REFRESHED"), SIGNATURE, BEFORE, null, rpcUrl);
  assert.equal(outcome.error, null);
  assert.equal(outcome.skipPreflight, false);
  assert.equal(outcome.jupiterInvoked && outcome.whirlpoolInvoked && outcome.guardInvoked, true);
  assert.deepEqual(outcome.after, { usdc: 0n, kox: 5_504_261n });
  const view = reproductionMessage(heldProof(outcome));
  assert.match(view, /5\.00 USDC → 0\.05504261 KOx/);
  assert.match(view, /EquityGuard\s+Passed\nJupiter\s+Executed\nWhirlpool\s+Executed/);

  refreshed(); chain.kox = 5_504_260n;
  await assert.rejects(confirmReplay(prepared("REFRESHED"), SIGNATURE, BEFORE, null, rpcUrl), /exact token movement/);
  refreshed(); chain.logs = EXECUTED.filter((line) => !line.includes(WHIRLPOOL));
  await assert.rejects(confirmReplay(prepared("REFRESHED"), SIGNATURE, BEFORE, null, rpcUrl), /exact token movement/);
  refreshed(); chain.err = { InstructionError: [2, { Custom: 6001 }] };
  await assert.rejects(confirmReplay(prepared("REFRESHED"), SIGNATURE, BEFORE, null, rpcUrl), /exact token movement/);
});

test("stale view refuses an incomplete signed-before-activation proof", async () => {
  stale();
  const outcome = await confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, rpcUrl);
  const proof = heldProof(outcome);
  assert.doesNotThrow(() => reproductionMessage(proof));
  for (const broken of [
    { ...proof, exactEquality: false },
    { ...proof, signedWireHashAtSubmission: "cd" },
    { ...proof, atSigning: { unixTimestamp: 100n, slot: 1n } },
    { ...proof, atSubmission: { unixTimestamp: 100n, slot: 2n } },
    { ...proof, lifetime: { ...proof.lifetime, valid: false } },
    // EG-A-03: the coordinator's records are load-bearing, not decorative.
    { ...proof, preSign: { ...proof.preSign, source: "BROWSER" as never } },
    { ...proof, preSign: { ...proof.preSign, timing: { ...STALE_TIMING, clockMatchesExpectedPhase: false } as never } },
    // A stale panel may not be rendered from an ACTIVATED authorization.
    { ...proof, preSign: { ...proof.preSign, timing: { ...STALE_TIMING, encodedPhase: "ACTIVATED" } as never } },
    { ...proof, preSign: { ...proof.preSign, timing: { ...STALE_TIMING, clockRelationToLocalT: "AT_OR_AFTER_ACTIVATION" } as never } },
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, source: "BROWSER" as never } },
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, timing: { ...STALE_TIMING, clockMatchesExpectedPhase: false } as never } },
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, timing: { ...STALE_TIMING, clockRelationToLocalT: "AT_OR_AFTER_ACTIVATION" } as never } },
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, signatureVerified: false as never } },
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, messageMatchesSimulated: false as never } },
    // The signed message must be the one the coordinator simulated...
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, messageSha256: "other" } },
    // ...and the attested wire must be the one that was held.
    { ...proof, signedAuthorization: { ...proof.signedAuthorization, signedWireSha256: "cd" } },
    // EG-A-02: the deployment must have been re-attested, twice, unchanged.
    { ...proof, deploymentAttestations: [] as never },
    { ...proof, deploymentAttestations: [proof.deploymentAttestations[0]] as never },
    { ...proof, deploymentAttestations: [proof.deploymentAttestations[0], { stage: "PRE_SUBMISSION", digest: "other", matched: true }] as never },
    { ...proof, deploymentAttestations: [proof.deploymentAttestations[0], { ...proof.deploymentAttestations[1], matched: false }] as never },
  ]) assert.throws(() => reproductionMessage(broken), /proof is incomplete/);
});

test("confirmation is refused for any non-localhost RPC", async () => {
  stale();
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, "https://api.devnet.solana.com"), /non-local RPC/);
  await assert.rejects(confirmReplay(prepared("STALE"), SIGNATURE, BEFORE, null, "https://api.mainnet-beta.solana.com"), /non-local RPC/);
});
