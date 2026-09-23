import {
  address,
  createSolanaRpc,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  type Address,
  type Signature,
  type Transaction,
} from "@solana/kit";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ADDRESS,
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  USDC_MINT_ADDRESS,
  decodeRouteV2Prefix,
  checkGuardedJupiterTransaction,
  equityGuardErrorName,
  type AssertSafeExecutionRequest,
  type JupiterAdapterKind,
} from "../../../packages/guard-client/src/index.ts";
import { parseBuildResponse, type BuildResponse } from "../../../packages/jupiter/src/build-client.ts";
import { composeGuardedJupiterTrade } from "../../../packages/jupiter/src/advanced.ts";
import { resolveWireTransaction } from "../../../packages/jupiter/src/compose.ts";
import type { PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import type { BuyStage } from "./buy-error.ts";
import {
  FeasibilityError,
  LOCAL_RPC_URL,
  assertLocalRpcUrl,
  signedTransactionBytes,
} from "./feasibility.ts";
import { fixtureUrl } from "./local-host.ts";
import {
  ReplaySimulationError,
  decodeLocalRpcFailure,
  invoked,
} from "./rpc-failure.ts";
import type { LocalSimulationFailure } from "./rpc-failure.ts";
import {
  EXPECTED_IN_AMOUNT,
  EXPECTED_KOX_BASELINE,
  EXPECTED_OUT_AMOUNT,
  EXPECTED_PHANTOM,
  EXPECTED_PHANTOM_KOX_ATA,
  EXPECTED_PHANTOM_USDC_ATA,
  EXPECTED_USDC_BASELINE,
  KOX_DECIMALS,
  REFRESHED_AUTHORIZATION_SOURCE,
  STALE_AUTHORIZATION_SOURCE,
  formatKox,
  skipPreflightAllowed,
} from "./local-funding.ts";
import {
  KOX_MINT,
  expectationFromRecordedAuthorization,
  requiredSignerAddresses,
  retargetBuildForTrader,
  type RecordedAuthorization,
  type ReplayKind,
} from "./replay-model.ts";

const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const GUARD_PROGRAM = address(EQUITY_GUARD_DEVNET_PROGRAM_ID);
const POLL_MS = 500;
const POLL_LIMIT = 60;
const LOCAL_AIRDROP = 1_000_000_000n;
const MINIMUM_FEE_BALANCE = 10_000_000n;

interface RouteFixture {
  readonly adapterKind: JupiterAdapterKind;
  readonly taker: string;
  readonly outputMint: string;
  readonly computeUnitLimit: number;
  readonly build: unknown;
}

interface SealedAuthorizations {
  readonly stale: { readonly source: string; readonly authorization: RecordedAuthorization };
  readonly refreshed: { readonly source: string; readonly authorization: RecordedAuthorization };
  readonly asset: { readonly decimals: number };
}

export interface ReplayData {
  readonly fixture: RouteFixture;
  readonly build: BuildResponse;
  readonly stale: AssertSafeExecutionRequest;
  readonly refreshed: AssertSafeExecutionRequest;
  readonly staleSource: string;
  readonly refreshedSource: string;
}

export interface PreparedReplay {
  readonly kind: ReplayKind;
  readonly unsigned: Transaction;
  readonly wireBytes: Uint8Array;
  readonly sourceAta: Address;
  readonly destinationAta: Address;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly commitmentHex: string;
  readonly requiredSigner: Address;
  readonly feePayer: Address;
  readonly programs: readonly string[];
  readonly routeDataUnchanged: true;
  readonly routePlanUnchanged: true;
  readonly inAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly authorizationSource: string;
  readonly skipPreflight: boolean;
}

export interface TokenBalances {
  readonly usdc: bigint;
  readonly kox: bigint;
}

export interface ReplayOutcome {
  readonly kind: ReplayKind;
  readonly signature: string;
  readonly slot: bigint;
  readonly signer: string;
  readonly feePayer: string;
  readonly error: unknown;
  readonly failedInstruction: number | null;
  readonly customCode: number | null;
  readonly guardErrorName: string | null;
  readonly guardInvoked: boolean;
  readonly jupiterInvoked: boolean;
  readonly whirlpoolInvoked: boolean;
  readonly before: TokenBalances;
  readonly after: TokenBalances;
  readonly skipPreflight: boolean;
  readonly logs: readonly string[];
  readonly computeUnits: string | null;
  readonly simulation: LocalSimulationFailure | null;
  readonly authorizationSource: string;
}

export async function loadReplayData(): Promise<ReplayData> {
  const [fixtureResponse, sealedResponse] = await Promise.all([
    fetch(fixtureUrl("route-fixture.json"), { cache: "no-store" }),
    fetch(fixtureUrl("sealed-authorizations.json"), { cache: "no-store" }),
  ]);
  if (!fixtureResponse.ok || !sealedResponse.ok) throw new Error("Local replay fixture files are unavailable");
  const fixture = await fixtureResponse.json() as RouteFixture;
  const sealed = await sealedResponse.json() as SealedAuthorizations;
  if (sealed.asset.decimals !== KOX_DECIMALS) throw new Error("sealed KOx decimals are not 8");
  if (sealed.stale.source !== STALE_AUTHORIZATION_SOURCE || sealed.refreshed.source !== REFRESHED_AUTHORIZATION_SOURCE) {
    throw new Error("sealed authorization sources are not the Sep 15 KOx observations");
  }
  return {
    fixture,
    build: parseBuildResponse(fixture.build),
    stale: expectationFromRecordedAuthorization(sealed.stale.authorization),
    refreshed: expectationFromRecordedAuthorization(sealed.refreshed.authorization),
    staleSource: sealed.stale.source,
    refreshedSource: sealed.refreshed.source,
  };
}

export async function verifyLocalReplayValidator(rpcUrl: string = LOCAL_RPC_URL): Promise<string> {
  const local = assertLocalRpcUrl(rpcUrl);
  const rpc = createSolanaRpc(local.href);
  const genesis = await rpc.getGenesisHash().send();
  if ([MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH].includes(genesis)) {
    throw new FeasibilityError("LOCAL_RPC_REFUSED", "Refusing a public Solana cluster genesis hash");
  }
  const guard = await rpc.getAccountInfo(GUARD_PROGRAM, { encoding: "base64" }).send();
  if (!guard.value?.executable) throw new Error("Local validator does not have the EquityGuard replay program");
  return genesis;
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function assertConnectedPhantom(trader: Address): void {
  if (trader !== EXPECTED_PHANTOM) {
    throw new Error(`this experiment funds ${EXPECTED_PHANTOM}; reconnect that Phantom`);
  }
}

export async function readPhantomBaseline(
  rpc: ReturnType<typeof createSolanaRpc>,
  trader: Address,
  sourceAta: Address,
  destinationAta: Address,
): Promise<{ readonly sol: bigint; readonly usdc: bigint; readonly kox: bigint }> {
  const [sol, usdc, kox] = await Promise.all([
    rpc.getBalance(trader, { commitment: "confirmed" }).send(),
    tokenBalance(rpc, sourceAta),
    tokenBalance(rpc, destinationAta),
  ]);
  return { sol: sol.value, usdc, kox };
}

export function assertDeterministicBaseline(balances: { readonly sol: bigint; readonly usdc: bigint; readonly kox: bigint }): void {
  if (balances.sol < MINIMUM_FEE_BALANCE) throw new Error("Phantom local SOL is below the fee reserve; reseed the local fixture");
  if (balances.usdc !== EXPECTED_USDC_BASELINE) {
    throw new Error(`Phantom USDC is ${balances.usdc}, expected ${EXPECTED_USDC_BASELINE}. Reseed the local fixture.`);
  }
  if (balances.kox !== EXPECTED_KOX_BASELINE) {
    throw new Error(`Phantom KOx is ${balances.kox}, expected ${EXPECTED_KOX_BASELINE}. Reseed the local fixture.`);
  }
}

function assertSingleSigner(transaction: Transaction, trader: Address): void {
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts);
  if (signers.length !== 1 || signers[0] !== trader) {
    throw new Error(`guarded replay requires unexpected signers: ${signers.join(",")}`);
  }
}

function decodeAccountData(data: readonly [string, string]): Uint8Array {
  return Uint8Array.from(atob(data[0]), (character) => character.charCodeAt(0));
}

function assertTokenAccount(
  account: { readonly owner: string; readonly data: readonly [string, string] },
  expectedProgram: string,
  expectedMint: Address,
  expectedOwner: Address,
  label: string,
): void {
  if (account.owner !== expectedProgram) throw new Error(`${label} is owned by the wrong token program`);
  const bytes = decodeAccountData(account.data);
  if (bytes.length < 72) throw new Error(`${label} is malformed`);
  const decoder = getAddressDecoder();
  if (decoder.decode(bytes.subarray(0, 32)) !== expectedMint || decoder.decode(bytes.subarray(32, 64)) !== expectedOwner) {
    throw new Error(`${label} does not belong to the connected Phantom public key and expected mint`);
  }
}

export async function prepareReplay(
  data: ReplayData,
  trader: Address,
  kind: ReplayKind,
  rpcUrl: string = LOCAL_RPC_URL,
): Promise<PreparedReplay> {
  await verifyLocalReplayValidator(rpcUrl);
  assertConnectedPhantom(trader);
  const rpc = createSolanaRpc(assertLocalRpcUrl(rpcUrl).href);
  await ensureLocalFeeFunds(rpc, trader);
  const retargeted = await retargetBuildForTrader(data.build, trader);
  if (retargeted.sourceAta !== EXPECTED_PHANTOM_USDC_ATA || retargeted.destinationAta !== EXPECTED_PHANTOM_KOX_ATA) {
    throw new Error("canonical Phantom ATAs do not match the reviewed addresses");
  }
  const prefix = decodeRouteV2Prefix(Uint8Array.from(atob(data.build.swapInstruction.data), (character) => character.charCodeAt(0)));
  if (prefix === null || prefix.inAmount !== EXPECTED_IN_AMOUNT || prefix.quotedOutAmount !== EXPECTED_OUT_AMOUNT) {
    throw new Error("Jupiter route amounts changed; refusing to retarget");
  }
  if (formatKox(prefix.quotedOutAmount) !== "0.05504261") throw new Error("KOx display amount is not 0.05504261");
  const [sourceAccount, destinationAccount] = await Promise.all([
    rpc.getAccountInfo(retargeted.sourceAta, { encoding: "base64", commitment: "confirmed" }).send(),
    rpc.getAccountInfo(retargeted.destinationAta, { encoding: "base64", commitment: "confirmed" }).send(),
  ]);
  if (!sourceAccount.value) throw new Error(`Phantom local USDC ATA ${retargeted.sourceAta} is not loaded`);
  assertTokenAccount(
    sourceAccount.value,
    LEGACY_TOKEN_PROGRAM_ADDRESS,
    address(USDC_MINT_ADDRESS),
    trader,
    "Phantom USDC ATA",
  );
  if (destinationAccount.value) {
    assertTokenAccount(
      destinationAccount.value,
      TOKEN_2022_PROGRAM_ADDRESS,
      KOX_MINT,
      trader,
      "Phantom KOx ATA",
    );
  }
  assertDeterministicBaseline(await readPhantomBaseline(rpc, trader, retargeted.sourceAta, retargeted.destinationAta));
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const build: BuildResponse = {
    ...retargeted.build,
    blockhashWithMetadata: {
      blockhash: [...getBase58Encoder().encode(latest.blockhash)],
      lastValidBlockHeight: Number(latest.lastValidBlockHeight),
    },
  };
  const expectation = kind === "STALE" ? data.stale : data.refreshed;
  const composition = await composeGuardedJupiterTrade({
    build,
    programAddress: GUARD_PROGRAM,
    feePayer: trader,
    taker: trader,
    protectedMint: KOX_MINT,
    adapterKind: data.fixture.adapterKind,
    expectation,
    computeUnitLimit: data.fixture.computeUnitLimit,
  });
  const unsigned = getTransactionDecoder().decode(composition.wireBytes);
  assertSingleSigner(unsigned, trader);
  const resolved = resolveWireTransaction(composition.wireBytes, build.addressesByLookupTableAddress);
  if (resolved[0]?.programAddress !== GUARD_PROGRAM) throw new Error("EquityGuard is not instruction 0");
  if (resolved.at(-1)?.programAddress !== JUPITER_V6_PROGRAM_ADDRESS) throw new Error("Jupiter route is not the final instruction");
  const verdict = await checkGuardedJupiterTransaction({
    instructions: resolved,
    guardIndex: 0,
    adapterKind: data.fixture.adapterKind,
    protectedMint: KOX_MINT,
    commitment: composition.trade.commitment,
  });
  if (verdict !== null) throw new Error(`production guard-client rejected retargeted replay: ${verdict}`);
  if (requiredSignerAddresses(build).join(",") !== trader) throw new Error("retargeted Jupiter build has a hidden signer");
  if (build.swapInstruction.data !== data.build.swapInstruction.data) throw new Error("Jupiter route data changed");
  if (JSON.stringify(build.routePlan) !== JSON.stringify(data.build.routePlan)) throw new Error("Jupiter route plan changed");
  return {
    kind,
    unsigned,
    wireBytes: composition.wireBytes,
    sourceAta: retargeted.sourceAta,
    destinationAta: retargeted.destinationAta,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    commitmentHex: Buffer.from(composition.trade.commitment).toString("hex"),
    requiredSigner: trader,
    feePayer: trader,
    programs: resolved.map((instruction) => instruction.programAddress),
    routeDataUnchanged: true,
    routePlanUnchanged: true,
    inAmount: prefix.inAmount,
    quotedOutAmount: prefix.quotedOutAmount,
    authorizationSource: kind === "STALE" ? data.staleSource : data.refreshedSource,
    skipPreflight: skipPreflightAllowed(kind),
  };
}

export function encodeForPhantom(transaction: Transaction): string {
  return getBase58Decoder().decode(getTransactionEncoder().encode(transaction));
}

export function exactPhantomSignature(unsigned: Transaction, response: unknown): {
  readonly bytes: Uint8Array;
  readonly signed: Transaction;
  readonly signature: Signature;
} {
  const bytes = signedTransactionBytes(response);
  const signed = getTransactionDecoder().decode(bytes);
  if (!sameBytes(unsigned.messageBytes, signed.messageBytes)) {
    throw new FeasibilityError(
      "SERIALIZATION_FAILURE",
      "Phantom changed the guarded Jupiter message; refusing because EquityGuard must remain instruction 0.",
    );
  }
  return { bytes: Uint8Array.from(bytes), signed, signature: getSignatureFromTransaction(signed) };
}

async function tokenBalance(rpc: ReturnType<typeof createSolanaRpc>, account: Address): Promise<bigint> {
  const info = await rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send();
  if (!info.value) return 0n;
  const bytes = Uint8Array.from(atob(info.value.data[0]), (character) => character.charCodeAt(0));
  if (bytes.length < 72) throw new Error(`token account ${account} is malformed`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
}

export async function balances(
  rpc: ReturnType<typeof createSolanaRpc>,
  prepared: PreparedReplay,
): Promise<TokenBalances> {
  const [usdc, kox] = await Promise.all([
    tokenBalance(rpc, prepared.sourceAta),
    tokenBalance(rpc, prepared.destinationAta),
  ]);
  return { usdc, kox };
}

function customFailure(error: unknown): { instruction: number | null; code: number | null } {
  if (typeof error !== "object" || error === null || !("InstructionError" in error)) return { instruction: null, code: null };
  const detail = (error as { readonly InstructionError: unknown }).InstructionError;
  if (!Array.isArray(detail) || detail.length !== 2) return { instruction: null, code: null };
  const code = typeof detail[1] === "object" && detail[1] !== null && "Custom" in detail[1]
    ? Number((detail[1] as { readonly Custom: unknown }).Custom)
    : null;
  return { instruction: Number(detail[0]), code };
}

async function simulateExactSignedTransaction(
  rpcUrl: string,
  wire: string,
  programs: readonly string[],
): Promise<LocalSimulationFailure | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [wire, {
        encoding: "base64",
        sigVerify: true,
        replaceRecentBlockhash: false,
        commitment: "confirmed",
      }],
    }),
  });
  const json = await response.json() as {
    readonly error?: unknown;
    readonly result?: { readonly value?: { readonly err?: unknown; readonly logs?: readonly string[] } };
  };
  if (json.error) return decodeLocalRpcFailure(json.error, "simulation", programs);
  const value = json.result?.value;
  if (value?.err) {
    return decodeLocalRpcFailure({
      code: -32002,
      message: "Transaction simulation failed",
      data: value,
    }, "simulation", programs);
  }
  return null;
}

export function isExpectedStaleSimulation(failure: LocalSimulationFailure | null): boolean {
  return failure !== null
    && failure.failedInstruction === 0
    && failure.customCode === 12
    && failure.customName === "ActivationPhaseChanged";
}

async function ensureLocalFeeFunds(
  rpc: ReturnType<typeof createSolanaRpc>,
  trader: Address,
): Promise<void> {
  if ((await rpc.getBalance(trader, { commitment: "confirmed" }).send()).value >= MINIMUM_FEE_BALANCE) return;
  const localTestRpc = rpc as typeof rpc & {
    requestAirdrop(address: Address, amount: ReturnType<typeof lamports>): { send(): Promise<Signature> };
  };
  const airdrop = await localTestRpc.requestAirdrop(trader, lamports(LOCAL_AIRDROP)).send();
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    const { value } = await rpc.getSignatureStatuses([airdrop]).send();
    if (value[0]?.err) throw new Error("Local fee-funding airdrop failed");
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("Local fee-funding airdrop did not confirm");
}

export async function signSubmitAndConfirmReplay(
  provider: PhantomProvider,
  prepared: PreparedReplay,
  rpcUrl: string = LOCAL_RPC_URL,
  onStage?: (stage: BuyStage) => void,
): Promise<ReplayOutcome> {
  onStage?.("ENVIRONMENT_CHECK");
  await verifyLocalReplayValidator(rpcUrl);
  const rpc = createSolanaRpc(assertLocalRpcUrl(rpcUrl).href);
  await ensureLocalFeeFunds(rpc, prepared.requiredSigner);
  const before = await balances(rpc, prepared);
  onStage?.("SIGN_REQUEST");
  const response = await provider.request({
    method: "signTransaction",
    params: { message: encodeForPhantom(prepared.unsigned) },
  });
  onStage?.("SIGNED_BYTES_RETURNED");
  const { signed, signature } = exactPhantomSignature(prepared.unsigned, response);
  const wire = getBase64EncodedWireTransaction(signed);
  assertLocalRpcUrl(rpcUrl);
  onStage?.("SIMULATION");
  const simulation = await simulateExactSignedTransaction(rpcUrl, wire, prepared.programs);
  const skipPreflight = skipPreflightAllowed(prepared.kind);
  if (prepared.skipPreflight !== skipPreflight) throw new Error("prepared skipPreflight does not match policy");
  if (prepared.kind === "STALE") {
    if (!isExpectedStaleSimulation(simulation)) {
      throw new ReplaySimulationError(simulation ?? decodeLocalRpcFailure({
        code: -32002,
        message: "Stale simulation did not reject at EquityGuard",
        data: { err: null, logs: [] },
      }, "simulation", prepared.programs));
    }
  } else if (simulation) {
    throw new ReplaySimulationError(simulation);
  }
  if (skipPreflight && prepared.kind !== "STALE") throw new Error("skipPreflight is allowed only for the stale rejection");
  onStage?.("SUBMISSION");
  let submitted: Signature;
  try {
    submitted = await rpc.sendTransaction(wire, {
      encoding: "base64",
      skipPreflight,
      preflightCommitment: "confirmed",
    }).send();
  } catch (error) {
    throw new ReplaySimulationError(decodeLocalRpcFailure(error, "sendRawTransaction", prepared.programs));
  }
  if (submitted !== signature) throw new Error("Local RPC returned a different signature");

  return confirmReplay(prepared, signature, before, simulation, rpcUrl, onStage);
}

export async function confirmReplay(
  prepared: PreparedReplay, signature: Signature, before: TokenBalances,
  simulation: LocalSimulationFailure | null, rpcUrl: string = LOCAL_RPC_URL,
  onStage?: (stage: BuyStage) => void,
): Promise<ReplayOutcome> {
  const rpc = createSolanaRpc(assertLocalRpcUrl(rpcUrl).href);
  const skipPreflight = skipPreflightAllowed(prepared.kind);
  onStage?.("CONFIRMATION");
  let transaction: Awaited<ReturnType<ReturnType<typeof rpc.getTransaction>["send"]>> | null = null;
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    transaction = await rpc.getTransaction(signature, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    }).send();
    if (transaction) break;
    const height = await rpc.getBlockHeight({ commitment: "processed" }).send();
    if (height > prepared.lastValidBlockHeight) throw new Error("Local guarded replay expired before confirmation");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (!transaction) throw new Error("Local guarded replay did not confirm");
  onStage?.("BALANCE_VERIFICATION");
  if (!transaction.meta) throw new Error("Confirmed transaction metadata is missing");
  if (transaction.transaction.message.header.numRequiredSignatures !== 1 ||
      transaction.transaction.message.accountKeys[0] !== prepared.requiredSigner ||
      transaction.transaction.signatures[0] !== signature) throw new Error("Confirmed signer/fee payer/signature mismatch");
  const after = await balances(rpc, prepared);
  const error = transaction.meta?.err ?? null;
  const failure = customFailure(error);
  const logs = transaction.meta?.logMessages ?? [];
  const outcome: ReplayOutcome = {
    kind: prepared.kind,
    signature,
    slot: transaction.slot,
    signer: prepared.requiredSigner,
    feePayer: prepared.feePayer,
    error,
    failedInstruction: failure.instruction,
    customCode: failure.code,
    guardErrorName: failure.code === null ? null : (equityGuardErrorName(failure.code) ?? null),
    guardInvoked: invoked(logs, GUARD_PROGRAM),
    jupiterInvoked: invoked(logs, JUPITER_V6_PROGRAM_ADDRESS),
    whirlpoolInvoked: invoked(logs, WHIRLPOOL_PROGRAM),
    before,
    after,
    skipPreflight,
    logs,
    computeUnits: transaction.meta?.computeUnitsConsumed === undefined || transaction.meta.computeUnitsConsumed === null
      ? null
      : String(transaction.meta.computeUnitsConsumed),
    simulation,
    authorizationSource: prepared.authorizationSource,
  };
  assertOutcome(outcome);
  return outcome;
}

export function assertOutcome(outcome: ReplayOutcome): void {
  if (!outcome.guardInvoked) throw new Error("confirmed transaction did not invoke EquityGuard");
  if (outcome.kind === "STALE") {
    if (
      !outcome.skipPreflight ||
      outcome.failedInstruction !== 0 ||
      outcome.customCode !== 12 ||
      outcome.guardErrorName !== "ActivationPhaseChanged" ||
      outcome.jupiterInvoked ||
      outcome.whirlpoolInvoked ||
      outcome.before.usdc !== outcome.after.usdc ||
      outcome.before.kox !== outcome.after.kox
    ) {
      throw new Error("confirmed stale transaction did not prove fail-closed ActivationPhaseChanged");
    }
    return;
  }
  if (outcome.skipPreflight) throw new Error(`${outcome.kind} must keep preflight enabled`);
  if (
    outcome.error !== null ||
    !outcome.jupiterInvoked ||
    !outcome.whirlpoolInvoked ||
    outcome.after.usdc !== outcome.before.usdc - EXPECTED_IN_AMOUNT ||
    outcome.after.kox !== outcome.before.kox + EXPECTED_OUT_AMOUNT
  ) {
    throw new Error("confirmed transaction did not prove guarded Jupiter/Whirlpool execution and exact token movement");
  }
}
