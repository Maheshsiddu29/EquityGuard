/**
 * The proven local Phantom flow, exposed for a second local host.
 *
 * `app.ts` is the flow's original page and stays exactly as it was. This
 * module is a thin adapter over the same functions — the same arming, the
 * same authorization construction, the same protected Jupiter build, the same
 * Phantom request, the same local submission and confirmation — so the
 * apps/web live demo drives the proven implementation rather than a copy of
 * it. Nothing about transaction semantics is decided here.
 *
 * What this module adds is a boundary:
 *
 * - results cross it as plain JSON-safe values, because the caller is React
 *   state rather than a DOM string;
 * - each leg's invariants are re-checked here, independently of the checks
 *   `confirmReplay`/`assertOutcome` already made, so a caller that renders
 *   whatever it is handed still cannot render a success the run did not
 *   prove. Every check throws. There is no partial result.
 *
 * It is bundled for the browser by `build/build-live-adapter.ts` and loaded
 * only when the live demo is explicitly enabled on a loopback host.
 */
import { connectPhantomWallet, detectPhantom, type PhantomProvider } from "../../devnet-wallet-demo/src/wallet.ts";
import { LOCAL_ACTIVATION_SOURCE } from "./activation-proof.ts";
import { type BuyStage } from "./buy-error.ts";
import { FeasibilityError } from "./feasibility.ts";
import { armLocalActivation, recordEvidence, runLocalActivation, type LocalActivationProof } from "./local-activation.ts";
import { configureLocalCoordinator } from "./local-host.ts";
import {
  EXPECTED_IN_AMOUNT,
  EXPECTED_OUT_AMOUNT,
  EXPECTED_PHANTOM,
  formatKox,
  formatUsdc,
} from "./local-funding.ts";
import { loadReplayData, type ReplayData } from "./replay-execution.ts";
import { reproductionMessage } from "./reproduction-view.ts";
import { stageStatus } from "./stage-status.ts";
import { isSignatureCancelled, traderFacingError } from "./trader-flow.ts";

/** Bumped when the shape below changes, so a stale bundle is detectable. */
export const LIVE_ADAPTER_VERSION = 1;

export const ENVIRONMENT = LOCAL_ACTIVATION_SOURCE;

/** The canonical display amounts. Asserted against the run, never substituted for it. */
export const EXPECTED_DISPLAY = {
  usdcIn: "5.00",
  koxOut: "0.05504261",
  usdcInRaw: EXPECTED_IN_AMOUNT.toString(),
  koxOutRaw: EXPECTED_OUT_AMOUNT.toString(),
} as const;

export interface LiveStageUpdate {
  readonly stage: BuyStage;
  readonly message: string;
}

export interface LiveWallet {
  readonly publicKey: string;
}

interface LiveResultBase {
  readonly environment: typeof ENVIRONMENT;
  readonly walletPublicKey: string;
  readonly signature: string;
  readonly slot: string;
  readonly localT: string;
  /** The verified prose the proven app renders for this leg. */
  readonly summary: string;
  /** The whole proof, bigint-free, for the raw technical drawer. */
  readonly proof: unknown;
  readonly logs: readonly string[];
}

export interface LiveStaleResult extends LiveResultBase {
  readonly leg: "STALE";
  readonly guard: string;
  readonly guardErrorName: string;
  readonly failedInstruction: number;
  readonly jupiterInvoked: false;
  readonly whirlpoolInvoked: false;
  readonly usdcDelta: string;
  readonly koxDelta: string;
}

export interface LiveUpdatedResult extends LiveResultBase {
  readonly leg: "REFRESHED";
  readonly guard: string;
  readonly jupiterInvoked: true;
  readonly whirlpoolInvoked: true;
  readonly usdcSpentRaw: string;
  readonly koxReceivedRaw: string;
  readonly usdcDisplay: string;
  readonly koxDisplay: string;
}

export interface LiveFailure {
  readonly headline: string;
  readonly technical: string;
  readonly stage: BuyStage;
  readonly cancelled: boolean;
  /** True only once a wallet signature was actually requested for this leg. */
  readonly walletRequested: boolean;
  /** True only once bytes were actually sent to the validator for this leg. */
  readonly submitted: boolean;
}

/** One reproduction attempt. A new Buy replaces it; nothing survives across attempts. */
interface Session {
  provider: PhantomProvider;
  wallet: string;
  data: ReplayData;
  localT: bigint;
  stale: LocalActivationProof | null;
}

let session: Session | null = null;
let stage: BuyStage = "PHANTOM_CONNECT";
let walletRequested = false;
let submitted = false;

const jsonSafe = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, inner: unknown) => typeof inner === "bigint" ? inner.toString() : inner));

function track(onStage: (update: LiveStageUpdate) => void, localT: bigint | null) {
  return (value: BuyStage, clock?: { unixTimestamp: bigint; slot: bigint }): void => {
    stage = value;
    if (value === "SIGN_REQUEST") walletRequested = true;
    if (value === "SUBMISSION") submitted = true;
    onStage({ stage: value, message: stageStatus(value, clock, localT) });
  };
}

/**
 * Points the proven flow at the local coordinator. The origin is checked by
 * `configureLocalCoordinator`, which accepts loopback http only.
 */
export function configureLiveDemo(coordinatorOrigin: string): void {
  configureLocalCoordinator(coordinatorOrigin);
}

/** Drops the current attempt. The next Buy starts from nothing. */
export function resetLiveSession(): void {
  session = null;
  stage = "PHANTOM_CONNECT";
  walletRequested = false;
  submitted = false;
}

/** Connects the real Phantom provider. No transaction is built or signed here. */
export async function connectLiveWallet(): Promise<LiveWallet> {
  stage = "PHANTOM_CONNECT";
  if (!detectPhantom()) throw new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected");
  const connected = await connectPhantomWallet();
  if (connected.publicKey !== EXPECTED_PHANTOM) {
    throw new Error("Connect the configured Phantom public key");
  }
  return { publicKey: connected.publicKey };
}

/**
 * The stale leg: arm the local activation, build the pre-activation
 * authorization, take one Phantom signature, hold the exact signed bytes
 * across the state change, submit them, and confirm.
 */
export async function startStaleAttempt(onStage: (update: LiveStageUpdate) => void): Promise<LiveStaleResult> {
  resetLiveSession();
  const report = track(onStage, null);
  report("PHANTOM_CONNECT");
  if (!detectPhantom()) throw new FeasibilityError("PHANTOM_NOT_DETECTED", "Phantom was not detected");
  const connected = await connectPhantomWallet();
  if (connected.publicKey !== EXPECTED_PHANTOM) throw new Error("Connect the configured Phantom public key");
  report("ENVIRONMENT_CHECK");
  const data = await loadReplayData();
  const localT = await armLocalActivation();
  session = { provider: connected.provider, wallet: connected.publicKey, data, localT, stale: null };
  const proof = await runLocalActivation(data, connected.provider, localT, true, track(onStage, localT));
  session.stale = proof;
  const result = verifyStaleResult(proof, connected.publicKey);
  void recordEvidence({ stale: proof, refreshed: null }).catch((error: unknown) => console.warn(error));
  return result;
}

/**
 * The updated leg. Reached only from an explicit second click: it builds a new
 * post-activation authorization and asks Phantom for a second signature. The
 * first signature is never reused, and nothing here is pre-authorized.
 */
export async function confirmUpdatedOrder(onStage: (update: LiveStageUpdate) => void): Promise<LiveUpdatedResult> {
  const current = session;
  if (!current || !current.stale) throw new Error("No verified stale result to update from");
  walletRequested = false;
  submitted = false;
  const proof = await runLocalActivation(current.data, current.provider, current.localT, false, track(onStage, current.localT));
  const result = verifyUpdatedResult(proof, current.wallet);
  void recordEvidence({ stale: current.stale, refreshed: proof }).catch((error: unknown) => console.warn(error));
  return result;
}

/** Trader-facing copy for a failed leg, with what did and did not happen. */
export function describeLiveFailure(action: "buy" | "confirm", error: unknown): LiveFailure {
  const facing = traderFacingError(action, error, stage, true);
  return {
    headline: facing.headline,
    technical: facing.technical,
    stage,
    cancelled: isSignatureCancelled(error),
    walletRequested,
    submitted,
  };
}

/**
 * The stale leg's fail-closed boundary. Exported so the host that renders the
 * result, and this app's tests, exercise the same check the run does.
 */
export function verifyStaleResult(proof: LocalActivationProof, wallet: string): LiveStaleResult {
  // Throws unless the signed-before-activation proof is complete.
  const summary = reproductionMessage(proof);
  const outcome = proof.outcome;
  const usdc = outcome.after.usdc - outcome.before.usdc;
  const kox = outcome.after.kox - outcome.before.kox;
  if (
    outcome.kind !== "STALE" ||
    outcome.authorizationSource !== LOCAL_ACTIVATION_SOURCE ||
    !outcome.guardInvoked ||
    outcome.failedInstruction !== 0 ||
    outcome.guardErrorName !== "ActivationPhaseChanged" ||
    outcome.jupiterInvoked ||
    outcome.whirlpoolInvoked ||
    usdc !== 0n ||
    kox !== 0n
  ) {
    throw new Error("Live stale attempt did not prove a fail-closed ix0 rejection with zero token movement");
  }
  return {
    leg: "STALE",
    environment: ENVIRONMENT,
    walletPublicKey: wallet,
    signature: outcome.signature,
    slot: outcome.slot.toString(),
    localT: proof.localT.toString(),
    summary,
    guard: "REJECTED at ix0",
    guardErrorName: outcome.guardErrorName,
    failedInstruction: 0,
    jupiterInvoked: false,
    whirlpoolInvoked: false,
    usdcDelta: usdc.toString(),
    koxDelta: kox.toString(),
    logs: outcome.logs,
    proof: jsonSafe(proof),
  };
}

/** The updated leg's fail-closed boundary. Exported for the same reason. */
export function verifyUpdatedResult(proof: LocalActivationProof, wallet: string): LiveUpdatedResult {
  const summary = reproductionMessage(proof);
  const outcome = proof.outcome;
  const spent = outcome.before.usdc - outcome.after.usdc;
  const received = outcome.after.kox - outcome.before.kox;
  const usdcDisplay = formatUsdc(spent);
  const koxDisplay = formatKox(received);
  if (
    outcome.kind !== "REFRESHED" ||
    outcome.authorizationSource !== LOCAL_ACTIVATION_SOURCE ||
    outcome.error !== null ||
    outcome.skipPreflight ||
    !outcome.guardInvoked ||
    !outcome.jupiterInvoked ||
    !outcome.whirlpoolInvoked ||
    spent !== EXPECTED_IN_AMOUNT ||
    received !== EXPECTED_OUT_AMOUNT ||
    usdcDisplay !== EXPECTED_DISPLAY.usdcIn ||
    koxDisplay !== EXPECTED_DISPLAY.koxOut
  ) {
    throw new Error("Live updated attempt did not prove guarded Jupiter/Whirlpool execution and the exact token movement");
  }
  return {
    leg: "REFRESHED",
    environment: ENVIRONMENT,
    walletPublicKey: wallet,
    signature: outcome.signature,
    slot: outcome.slot.toString(),
    localT: proof.localT.toString(),
    summary,
    guard: "PASSED",
    jupiterInvoked: true,
    whirlpoolInvoked: true,
    usdcSpentRaw: spent.toString(),
    koxReceivedRaw: received.toString(),
    usdcDisplay,
    koxDisplay,
    logs: outcome.logs,
    proof: jsonSafe(proof),
  };
}
