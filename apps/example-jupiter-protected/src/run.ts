#!/usr/bin/env node
/**
 * Runs the protected flow end to end against the real Jupiter API and a real
 * RPC, and prints what it would sign.
 *
 * BUILD ONLY. The wallet is a {@link DryRunWallet}: this script signs nothing
 * and submits nothing, on any cluster.
 *
 *   JUPITER_API_KEY=... SOLANA_RPC_URL=... \
 *     node apps/example-jupiter-protected/src/run.ts [--amount 5000000] [--sell] [--program <address>]
 *
 * EquityGuard is deployed on devnet only, and Jupiter exists only on mainnet.
 * A mainnet RPC therefore refuses with GUARD_DEPLOYMENT_UNAVAILABLE unless
 * `--program` names a deployment the caller trusts — that refusal is itself
 * the behaviour worth seeing. What the script proves is that the integration
 * produces a valid, correctly bound, unsigned protected transaction from live
 * inputs, and never silently reuses the devnet program elsewhere.
 */

import { address, createSolanaRpc, type Address } from "@solana/kit";
import { USDC_MINT_ADDRESS, explainEquityGuardError, protectJupiterSwap } from "@equityguard/jupiter/protect";

import { buildJupiterSwap } from "./jupiter.ts";
import { DryRunWallet } from "./wallet.ts";

/** xStocks KOx on mainnet: a Token-2022 mint with ScaledUiAmount state. */
const PROTECTED_MINT = address("XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ");
/** A wallet that holds both sides, used only to ask Jupiter for a route. */
const DEMO_TAKER = address("AbDZ5Lh8T8njsGVuzhA97qwFRnQDwTLMzWsrWL7tVLhH");
const PROTECTION_WINDOW = { beforeSecs: 900, afterSecs: 300 };
const DEFAULT_AMOUNT = 5_000_000n;
const SLIPPAGE_BPS = 50;

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see the header of this file`);
  return value;
}

async function main(): Promise<void> {
  const apiKey = required("JUPITER_API_KEY");
  const rpc = createSolanaRpc(required("SOLANA_RPC_URL"));
  const wallet = new DryRunWallet((arg("--taker") as Address | null) ?? DEMO_TAKER);
  const sell = process.argv.includes("--sell");
  const amount = BigInt(arg("--amount") ?? DEFAULT_AMOUNT);

  const request = {
    inputMint: sell ? PROTECTED_MINT : USDC_MINT_ADDRESS,
    outputMint: sell ? USDC_MINT_ADDRESS : PROTECTED_MINT,
    amount,
    taker: wallet.publicKey,
    slippageBps: SLIPPAGE_BPS,
  };

  const build = await buildJupiterSwap(request, apiKey);
  console.log(`Jupiter: ${build.inAmount} ${build.inputMint} -> ${build.outAmount} ${build.outputMint} (min ${build.otherAmountThreshold})`);

  const program = arg("--program") as Address | null;
  const result = await protectJupiterSwap({
    build,
    userPublicKey: wallet.publicKey,
    rpc,
    protectionWindow: PROTECTION_WINDOW,
    ...(program ? { programAddress: program } : {}),
  });
  console.log(`EquityGuard: ${result.status}`);
  console.log(explainEquityGuardError(result));

  if (result.status !== "PROTECTED") {
    process.exitCode = 1;
    return;
  }
  console.log(
    [
      `  protected mint      ${result.protectedMint} (${result.direction})${result.knownAsset ? ` — ${result.knownAsset.symbol}, ${result.knownAsset.issuer}` : ""}`,
      `  guard program       ${result.programAddress} on ${result.cluster}`,
      `  state read at slot  ${result.snapshot.contextSlot}, chain time ${result.snapshot.clock.unixTimestamp}`,
      `  scheduled change    ${result.snapshot.hasScheduledChange ? `yes, at ${result.snapshot.state.newMultiplierEffectiveTimestamp}` : "no"}`,
      `  suffix commitment   ${result.binding.suffixCommitmentHex}`,
      `  transaction         ${result.metrics.serializedTransactionBytes} bytes unsigned, ${1232 - result.metrics.serializedTransactionBytes} bytes of headroom`,
      `  lookup tables       ${result.metrics.addressLookupTableCount} (${result.metrics.lookedUpAddressCount} addresses)`,
      `  signatures required ${result.metrics.requiredSignatures}`,
    ].join("\n"),
  );
  // A real application would call wallet.signAndSendTransaction here.
  console.log(`not sent: ${await wallet.signAndSend(result.transaction)}`);
}

await main();
