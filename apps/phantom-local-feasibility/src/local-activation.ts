import { createSolanaRpc, type Signature } from "@solana/kit";
import { fetchGuardSnapshot, ActivationPhase, EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../../../packages/guard-client/src/index.ts";
import type { PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import type { BuyStage } from "./buy-error.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "./feasibility.ts";
import { EXPECTED_PHANTOM } from "./local-funding.ts";
import { KOX_MINT } from "./replay-model.ts";
import {
  executeAcrossActivation,
  LOCAL_ACTIVATION_SOURCE,
  type DeploymentAttestation,
  type PreSignAttestation,
  type SignedAuthorizationAttestation,
} from "./activation-proof.ts";
import { prepareReplay, balances, exactPhantomSignature, encodeForPhantom, confirmReplay, type ReplayData, type PreparedReplay, type TokenBalances } from "./replay-execution.ts";
import { decodeLocalRpcFailure, ReplaySimulationError, invoked } from "./rpc-failure.ts";

const rpc = () => createSolanaRpc(assertLocalRpcUrl(LOCAL_RPC_URL).href);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
export async function armLocalActivation(): Promise<bigint> {
  assertLocalRpcUrl(location.origin);
  const response = await fetch("/api/arm", { method: "POST" });
  const result = await response.json() as { localT?: string; error?: string };
  if (!response.ok || !result.localT) throw new Error(result.error ?? "Local activation setup failed");
  return BigInt(result.localT);
}
const serialize = (value: unknown) => JSON.stringify(value, (_key, inner: unknown) => typeof inner === "bigint" ? inner.toString() : inner);
/** Hands the verified proof to the local coordinator, which re-reads each signature from the validator. */
export async function recordEvidence(proof: { stale: unknown; refreshed: unknown }): Promise<void> {
  assertLocalRpcUrl(location.origin);
  const response = await fetch("/api/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: serialize(proof) });
  if (!response.ok) throw new Error("Local evidence could not be recorded");
}
/** POSTs to the local coordinator and fails loudly on any refusal. */
async function coordinator<T>(path: string, payload: unknown): Promise<T> {
  assertLocalRpcUrl(location.origin);
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: serialize(payload),
  });
  const result = await response.json() as T & { error?: string; code?: string };
  if (!response.ok || result.error) {
    throw new Error(result.error ?? `Local coordinator refused ${path}`);
  }
  return result;
}

/**
 * EG-A-03: the coordinator simulates the exact unsigned message itself, reads
 * its own Clock, and refuses unless the complete guard + Jupiter + Whirlpool
 * path succeeded before localT. The browser asserts nothing here.
 */
async function attestPreSignSimulation(prepared: PreparedReplay): Promise<PreSignAttestation & { logs: readonly string[]; computeUnits: number | null }> {
  return coordinator("/api/pre-sign-simulation", { unsignedWireBase64: base64(prepared.wireBytes) });
}

/**
 * EG-A-03: hands the exact Phantom-signed bytes to the coordinator, which
 * verifies the signature, requires the message to equal the simulated one, and
 * dates the receipt against its own Clock.
 */
async function attestSignedAuthorization(proofId: string, signed: Uint8Array): Promise<SignedAuthorizationAttestation> {
  return coordinator("/api/signed-authorization", { proofId, signedWireBase64: base64(signed) });
}

/** EG-A-02: re-reads the guard deployment. Never touches the transaction. */
async function attestDeployment(stage: DeploymentAttestation["stage"]): Promise<DeploymentAttestation> {
  return coordinator("/api/deployment-attestation", { stage });
}

export async function runLocalActivation(
  data: ReplayData, provider: PhantomProvider, localT: bigint, stale: boolean,
  stage: (stage: BuyStage, clock?: { unixTimestamp: bigint; slot: bigint }) => void,
) {
  let before: TokenBalances | null = null;
  let signature: Signature | null = null;
  const snapshot = async () => {
    const value = await fetchGuardSnapshot(rpc(), KOX_MINT);
    if (value.state.newMultiplierEffectiveTimestamp !== localT) throw new Error("Local activation timestamp changed; aborting");
    if (!Buffer.from(value.state.multiplier).equals(Buffer.from(data.stale.expected.multiplier)) ||
        !Buffer.from(value.state.newMultiplier).equals(Buffer.from(data.stale.expected.newMultiplier))) throw new Error("Captured multiplier bytes changed");
    return value;
  };
  return executeAcrossActivation({
    stage,
    clock: async () => (await snapshot()).clock,
    pause: () => new Promise<void>(resolve => setTimeout(resolve, 250)),
    build: async () => {
      const current = await snapshot();
      if (current.phase !== (stale ? ActivationPhase.Pending : ActivationPhase.Activated)) throw new Error("Wrong local phase before building");
      const expectation = { expected: current.state, expectedPhase: current.phase, window: { beforeSecs: 0, afterSecs: 0 } };
      const prepared = await prepareReplay({ ...data, stale: expectation, refreshed: expectation,
        staleSource: LOCAL_ACTIVATION_SOURCE, refreshedSource: LOCAL_ACTIVATION_SOURCE }, EXPECTED_PHANTOM, stale ? "STALE" : "REFRESHED");
      before = await balances(rpc(), prepared);
      return prepared;
    },
    attestPreSignSimulation,
    attestSignedAuthorization,
    attestDeployment,
    sign: async (prepared) => {
      const returned = await provider.request({ method: "signTransaction", params: { message: encodeForPhantom(prepared.unsigned) } });
      stage("SIGNED_BYTES_RETURNED");
      const signed = exactPhantomSignature(prepared.unsigned, returned);
      signature = signed.signature;
      return signed.bytes;
    },
    lifetime: async (prepared) => {
      const [valid, height] = await Promise.all([
        rpc().isBlockhashValid(prepared.blockhash as Parameters<ReturnType<typeof rpc>["isBlockhashValid"]>[0], { commitment: "confirmed" }).send(),
        rpc().getBlockHeight({ commitment: "confirmed" }).send(),
      ]);
      return { valid: valid.value, height, lastValidBlockHeight: prepared.lastValidBlockHeight };
    },
    submit: async (prepared, bytes, deliberateStale) => {
      if (!signature || !before) throw new Error("No signed transaction or baseline");
      const current = await snapshot();
      if (current.phase !== ActivationPhase.Activated) throw new Error("Validator Clock has not crossed activation");
      const encoded = base64(bytes);
      // Send the held byte array verbatim: no transaction decoder/encoder or builder here.
      const response = await fetch(assertLocalRpcUrl(LOCAL_RPC_URL), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [encoded, {
          encoding: "base64", skipPreflight: deliberateStale, preflightCommitment: "confirmed",
        }] }),
      });
      const result = await response.json() as { error?: unknown; result?: string };
      if (result.error) throw new ReplaySimulationError(decodeLocalRpcFailure(result.error, "sendRawTransaction", prepared.programs));
      if (result.result !== signature) throw new Error("Local submission signature mismatch");
      const outcome = await confirmReplay(prepared, signature, before, null, LOCAL_RPC_URL, stage);
      if (!invoked(outcome.logs, EQUITY_GUARD_DEVNET_PROGRAM_ID)) throw new Error("Guard execution absent");
      return { ...outcome, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight,
        clockAtRpcSubmission: current.clock, commitment: prepared.commitmentHex };
    },
  }, localT, stale);
}
export type LocalActivationProof = Awaited<ReturnType<typeof runLocalActivation>>;
