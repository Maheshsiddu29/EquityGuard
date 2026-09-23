/**
 * LOCAL-ONLY, read-only: measure how many blocks and validator-Clock seconds a
 * signing window consumes, against the blockhash lifetime the demo will sign.
 *
 * Usage: node apps/phantom-local-feasibility/scripts/measure-blockhash.ts [windowSeconds]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createSolanaRpc } from "@solana/kit";
import { fetchGuardSnapshot } from "../../../packages/guard-client/src/index.ts";
import { activationDelay } from "../src/activation-proof.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "../src/feasibility.ts";
import { KOX_MINT } from "../src/replay-model.ts";

const window = activationDelay(process.argv[2] ?? process.env.DEMO_ACTIVATION_DELAY_SECONDS);
const rpc = createSolanaRpc(assertLocalRpcUrl(LOCAL_RPC_URL).href);

async function sample() {
  const [latest, height, snapshot] = await Promise.all([
    rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
    rpc.getBlockHeight({ commitment: "confirmed" }).send(),
    fetchGuardSnapshot(rpc, KOX_MINT),
  ]);
  return { wallMs: Date.now(), height, clock: snapshot.clock, blockhash: latest.value.blockhash,
    lastValidBlockHeight: latest.value.lastValidBlockHeight };
}

const start = await sample();
let end = start;
// Hold until the validator Clock (not wall time) has advanced by the window.
while (end.clock.unixTimestamp < start.clock.unixTimestamp + BigInt(window)) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  end = await sample();
}
const valid = (await rpc.isBlockhashValid(start.blockhash as Parameters<typeof rpc.isBlockhashValid>[0], { commitment: "confirmed" }).send()).value;
const consumed = end.height - start.height;
const lifetime = start.lastValidBlockHeight - start.height;
const report = {
  environment: "LOCAL_EXECUTION_REPRODUCTION",
  windowValidatorSeconds: window,
  start, end,
  wallSeconds: (end.wallMs - start.wallMs) / 1000,
  validatorSeconds: Number(end.clock.unixTimestamp - start.clock.unixTimestamp),
  blocksConsumed: consumed,
  blockhashLifetimeBlocks: lifetime,
  remainingBlocksAfterWindow: start.lastValidBlockHeight - end.height,
  consumedFractionOfLifetime: Number(consumed) / Number(lifetime),
  originalBlockhashStillValid: valid,
};
const json = JSON.stringify(report, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2);
await mkdir(new URL("../../../tmp/phantom-activation/", import.meta.url), { recursive: true });
await writeFile(new URL("../../../tmp/phantom-activation/blockhash-measurement.json", import.meta.url), json + "\n");
console.log(json);
// Require at least a third of the blockhash lifetime to remain after the whole window.
if (!valid || (lifetime - consumed) * 3n < lifetime) {
  console.error("Signing window leaves less than a third of the blockhash lifetime");
  process.exitCode = 1;
}
