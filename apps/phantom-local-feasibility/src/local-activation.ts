import { createSolanaRpc, type Signature } from "@solana/kit";
import { fetchGuardSnapshot, ActivationPhase, JUPITER_V6_PROGRAM_ADDRESS, EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../../../packages/guard-client/src/index.ts";
import type { PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import type { BuyStage } from "./buy-error.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "./feasibility.ts";
import { EXPECTED_PHANTOM } from "./local-funding.ts";
import { KOX_MINT } from "./replay-model.ts";
import { executeAcrossActivation, LOCAL_ACTIVATION_SOURCE } from "./activation-proof.ts";
import { prepareReplay, balances, exactPhantomSignature, encodeForPhantom, confirmReplay, type ReplayData, type PreparedReplay, type TokenBalances } from "./replay-execution.ts";
import { decodeLocalRpcFailure, ReplaySimulationError, invoked } from "./rpc-failure.ts";

const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
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
async function simulate(prepared: PreparedReplay) {
  const response = await fetch(assertLocalRpcUrl(LOCAL_RPC_URL), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [base64(prepared.wireBytes), {
      encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed",
    }] }),
  });
  const result = await response.json() as { error?: unknown; result?: { context: unknown; value: { err: unknown; logs: string[] | null; unitsConsumed?: number } } };
  if (result.error || !result.result || result.result.value.err !== null) {
    throw new ReplaySimulationError(decodeLocalRpcFailure(result.error ?? { data: result.result?.value }, "simulation", prepared.programs));
  }
  const logs = result.result.value.logs ?? [];
  if (!logs.includes("Program " + EQUITY_GUARD_DEVNET_PROGRAM_ID + " success") ||
      !logs.includes("Program " + JUPITER_V6_PROGRAM_ADDRESS + " success") ||
      !logs.includes("Program " + WHIRLPOOL + " success")) throw new Error("Pre-sign simulation did not prove all programs succeeded");
  return result.result;
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
    simulate,
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
