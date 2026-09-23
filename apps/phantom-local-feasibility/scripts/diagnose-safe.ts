/**
 * LOCAL-ONLY diagnosis of the failed Phantom SAFE guarded Jupiter transaction.
 * Simulates; does not submit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  USDC_MINT_ADDRESS,
  equityGuardErrorName,
  jupiterSuffixCommitment,
} from "../../../packages/guard-client/src/index.ts";
import { parseBuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import { composeGuardedJupiterTrade } from "../../../packages/jupiter/src/advanced.ts";
import { resolveWireTransaction } from "../../../packages/jupiter/src/compose.ts";
import { LOCAL_RPC_URL, assertLocalRpcUrl } from "../src/feasibility.ts";
import {
  KOX_MINT,
  ORIGINAL_KOX_ATA,
  ORIGINAL_TAKER,
  ORIGINAL_USDC_ATA,
  expectationFromRecordedAuthorization,
  retargetBuildForTrader,
} from "../src/replay-model.ts";

const PHANTOM = address("CBquXGAiR8StFU3HvPNuwyNwmrkY3yNGwL9bjZvVLb4X");
const PHANTOM_USDC = "7xd18PpPsvi8CmmP5Xr6rVQ63jUeQ2CqJ7i4yqZzmok9";
const PHANTOM_KOX = "AnrbNfooXzzthu4kndCspVEEMo14wn8VQYJC6kFqonVj";
const ROOT = new URL("../../../", import.meta.url).pathname;
const RPC = LOCAL_RPC_URL;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

async function accountSnapshot(pubkey: string) {
  const raw = await rpcCall("getAccountInfo", [pubkey, { encoding: "base64", commitment: "confirmed" }]) as {
    result?: { value: { owner: string; lamports: number; executable: boolean; data: [string, string]; space?: number } | null };
  };
  const value = raw.result?.value ?? null;
  if (!value) return { pubkey, exists: false };
  const bytes = Buffer.from(value.data[0], "base64");
  const decoder = getAddressDecoder();
  const token = bytes.length >= 72
    ? {
        mint: decoder.decode(bytes.subarray(0, 32)),
        owner: decoder.decode(bytes.subarray(32, 64)),
        amount: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true).toString(),
      }
    : null;
  return {
    pubkey,
    exists: true,
    owner: value.owner,
    lamports: value.lamports,
    executable: value.executable,
    dataLen: bytes.length,
    token,
  };
}

function instructionView(ix: { programAddress: string; accounts: readonly { address: string; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array }, index: number) {
  return {
    index,
    program: ix.programAddress,
    dataHex: hex(ix.data),
    accounts: ix.accounts.map((account, accountIndex) => ({
      index: accountIndex,
      address: account.address,
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
  };
}

function metaDiff(
  original: ReturnType<typeof instructionView>[],
  phantom: ReturnType<typeof instructionView>[],
) {
  const diffs: unknown[] = [];
  const length = Math.max(original.length, phantom.length);
  for (let i = 0; i < length; i += 1) {
    const left = original[i];
    const right = phantom[i];
    if (!left || !right) {
      diffs.push({ instruction: i, kind: "instruction-count", original: left?.program, phantom: right?.program });
      continue;
    }
    if (left.program !== right.program) diffs.push({ instruction: i, field: "program", original: left.program, phantom: right.program });
    if (left.dataHex !== right.dataHex) {
      diffs.push({
        instruction: i,
        field: "data",
        originalLen: left.dataHex.length / 2,
        phantomLen: right.dataHex.length / 2,
        samePrefix: left.dataHex.slice(0, 16) === right.dataHex.slice(0, 16),
        originalHead: left.dataHex.slice(0, 32),
        phantomHead: right.dataHex.slice(0, 32),
      });
    }
    const accountCount = Math.max(left.accounts.length, right.accounts.length);
    for (let j = 0; j < accountCount; j += 1) {
      const a = left.accounts[j];
      const b = right.accounts[j];
      if (!a || !b || a.address !== b.address || a.isSigner !== b.isSigner || a.isWritable !== b.isWritable) {
        diffs.push({ instruction: i, account: j, original: a, phantom: b });
      }
    }
  }
  return diffs;
}

async function main(): Promise<void> {
  assertLocalRpcUrl(RPC);
  const genesis = await rpcCall("getGenesisHash", []) as { result: string };
  const health = await rpcCall("getHealth", []) as { result: string };
  const fixture = JSON.parse(readFileSync(join(ROOT, "tmp/m9d-c1/route-fixture.json"), "utf8"));
  const evidence = JSON.parse(readFileSync(join(ROOT, "apps/reference/data/kox-trade-replay.json"), "utf8"));
  const originalBuild = parseBuildResponse(fixture.build);
  const retargeted = await retargetBuildForTrader(originalBuild, PHANTOM);
  const rpc = createSolanaRpc(RPC);
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();

  const originalWithBlockhash = {
    ...originalBuild,
    blockhashWithMetadata: {
      blockhash: [...getBase58Encoder().encode(latest.blockhash)],
      lastValidBlockHeight: Number(latest.lastValidBlockHeight),
    },
  };
  const phantomWithBlockhash = {
    ...retargeted.build,
    blockhashWithMetadata: originalWithBlockhash.blockhashWithMetadata,
  };
  const authorization = expectationFromRecordedAuthorization(evidence.refreshedExecution.authorization);
  const originalTrade = await composeGuardedJupiterTrade({
    build: originalWithBlockhash,
    programAddress: address(EQUITY_GUARD_DEVNET_PROGRAM_ID),
    feePayer: ORIGINAL_TAKER,
    taker: ORIGINAL_TAKER,
    protectedMint: KOX_MINT,
    adapterKind: fixture.adapterKind,
    expectation: authorization,
    computeUnitLimit: fixture.computeUnitLimit,
  });
  const phantomTrade = await composeGuardedJupiterTrade({
    build: phantomWithBlockhash,
    programAddress: address(EQUITY_GUARD_DEVNET_PROGRAM_ID),
    feePayer: PHANTOM,
    taker: PHANTOM,
    protectedMint: KOX_MINT,
    adapterKind: fixture.adapterKind,
    expectation: authorization,
    computeUnitLimit: fixture.computeUnitLimit,
  });

  const originalResolved = resolveWireTransaction(originalTrade.wireBytes, originalBuild.addressesByLookupTableAddress);
  const phantomResolved = resolveWireTransaction(phantomTrade.wireBytes, phantomWithBlockhash.addressesByLookupTableAddress);
  const originalView = originalResolved.map(instructionView);
  const phantomView = phantomResolved.map(instructionView);
  const recomputed = jupiterSuffixCommitment(phantomTrade.trade.committedSuffix);
  const guardData = phantomResolved[0]?.data ?? new Uint8Array();
  const includedCommitment = hex(guardData.subarray(guardData.length - 32));

  const accounts = {
    phantom: await accountSnapshot(PHANTOM),
    phantomUsdc: await accountSnapshot(PHANTOM_USDC),
    phantomKox: await accountSnapshot(PHANTOM_KOX),
    originalTaker: await accountSnapshot(ORIGINAL_TAKER),
    originalUsdc: await accountSnapshot(ORIGINAL_USDC_ATA),
    originalKox: await accountSnapshot(ORIGINAL_KOX_ATA),
    usdcMint: await accountSnapshot(USDC_MINT_ADDRESS),
    koxMint: await accountSnapshot(KOX_MINT),
  };

  const wire = getBase64EncodedWireTransaction(getTransactionDecoder().decode(phantomTrade.wireBytes));
  const simulationExact = await rpcCall("simulateTransaction", [wire, {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment: "confirmed",
  }]);
  const simulationReplaced = await rpcCall("simulateTransaction", [wire, {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  }]);
  const sendPreflight = await rpcCall("sendTransaction", [wire, {
    encoding: "base64",
    skipPreflight: false,
    preflightCommitment: "confirmed",
  }]);

  const report = {
    cluster: { rpc: RPC, health: health.result, genesis: genesis.result, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight.toString(), currentHeight: height.toString() },
    accounts,
    programs: phantomView.map((ix) => ({ index: ix.index, program: ix.program })),
    routeDataUnchanged: phantomWithBlockhash.swapInstruction.data === originalBuild.swapInstruction.data,
    routePlanUnchanged: JSON.stringify(phantomWithBlockhash.routePlan) === JSON.stringify(originalBuild.routePlan),
    serializedRouteDataUnchanged: hex(phantomResolved.at(-1)?.data ?? new Uint8Array()) === hex(originalResolved.at(-1)?.data ?? new Uint8Array()),
    requiredSignatures: { original: originalTrade.metrics.requiredSignatures, phantom: phantomTrade.metrics.requiredSignatures },
    commitment: {
      originalHex: hex(originalTrade.trade.commitment),
      recordedHex: evidence.routeEvidence.commitmentHex,
      phantomHex: hex(phantomTrade.trade.commitment),
      recomputedFromExactPhantomSuffix: hex(recomputed),
      includedInGuardData: includedCommitment,
      matchesIncluded: hex(recomputed) === includedCommitment,
    },
    accountMetaDiff: metaDiff(originalView, phantomView),
    simulationExact,
    simulationReplaced,
    sendPreflight,
  };

  const out = join(ROOT, "tmp/phantom-safe-diagnosis.json");
  writeFileSync(out, `${JSON.stringify(report, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2)}\n`);
  console.log(JSON.stringify({
    out,
    health: health.result,
    genesis: genesis.result,
    phantomExists: accounts.phantom.exists,
    phantomLamports: (accounts.phantom as { lamports?: number }).lamports ?? null,
    usdc: accounts.phantomUsdc,
    kox: accounts.phantomKox,
    routeDataUnchanged: report.routeDataUnchanged,
    serializedRouteDataUnchanged: report.serializedRouteDataUnchanged,
    sendPreflightError: (sendPreflight as { error?: unknown }).error ?? null,
    simulationExactErr: (simulationExact as { result?: { value?: { err?: unknown } } }).result?.value?.err
      ?? (simulationExact as { error?: unknown }).error
      ?? null,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
