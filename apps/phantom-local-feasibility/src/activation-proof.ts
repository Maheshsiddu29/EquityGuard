import type { BuyStage } from "./buy-error.ts";

export const LOCAL_ACTIVATION_SOURCE = "LOCAL_EXECUTION_REPRODUCTION";
export function activationDelay(value = "15"): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 30) throw new Error("Activation delay must be 5–30 validator seconds");
  return seconds;
}
export function localActivation(clock: bigint, delay: number): bigint {
  return clock + BigInt(activationDelay(String(delay)));
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
export async function wireHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export interface ActivationClock { readonly unixTimestamp: bigint; readonly slot: bigint }
export interface LifetimeCheck { readonly valid: boolean; readonly height: bigint; readonly lastValidBlockHeight: bigint }
export interface ActivationDependencies<Prepared, Outcome> {
  readonly build: () => Promise<Prepared>;
  /** Must reject unless the complete guard + Jupiter + Whirlpool simulation passes. */
  readonly simulate: (prepared: Prepared) => Promise<unknown>;
  readonly sign: (prepared: Prepared) => Promise<Uint8Array>;
  readonly clock: () => Promise<ActivationClock>;
  readonly lifetime: (prepared: Prepared) => Promise<LifetimeCheck>;
  readonly submit: (prepared: Prepared, bytes: Uint8Array, stale: boolean) => Promise<Outcome>;
  readonly pause: () => Promise<void>;
  readonly stage: (stage: BuyStage, clock?: ActivationClock) => void;
}

/** One explicit approval, one build, one immutable signed wire, at most one submission. */
export async function executeAcrossActivation<P, O>(
  deps: ActivationDependencies<P, O>, localT: bigint, stale: boolean,
) {
  deps.stage("TRANSACTION_BUILD");
  const prepared = await deps.build();
  const beforeSimulation = await deps.clock();
  if (stale ? beforeSimulation.unixTimestamp >= localT : beforeSimulation.unixTimestamp < localT) {
    throw new Error("Authorization phase is not ready; reset the local reproduction");
  }
  deps.stage("PRE_SIGN_SIMULATION");
  const simulation = await deps.simulate(prepared);
  const atSimulation = await deps.clock();
  if (stale && atSimulation.unixTimestamp >= localT) throw new Error("Activation passed during simulation; no signature requested");
  deps.stage("SIGN_REQUEST");
  const returned = await deps.sign(prepared);
  // The private reference and submission copy are never exposed to a builder or wallet again.
  const reference = Uint8Array.from(returned);
  const held = Uint8Array.from(returned);
  deps.stage("SIGNED_BYTES_RETURNED");
  const atSigning = await deps.clock();
  if (stale && atSigning.unixTimestamp >= localT) throw new Error("Signature returned after activation; aborting without submission or re-signing");
  const signedWireHashBeforeActivation = await wireHash(reference);
  let atSubmission = atSigning;
  let polls = 0;
  if (stale) {
    deps.stage("WAITING_FOR_ACTIVATION", atSubmission);
    // The production guard refuses the inclusive [T,T] transition second even for a zero-width window.
    while (atSubmission.unixTimestamp <= localT) {
      if (++polls > 240) throw new Error("Validator Clock did not cross activation; transaction not submitted");
      await deps.pause();
      atSubmission = await deps.clock();
      deps.stage("WAITING_FOR_ACTIVATION", atSubmission);
    }
  }
  deps.stage("BLOCKHASH_VALIDATION");
  const lifetime = await deps.lifetime(prepared);
  if (!lifetime.valid || lifetime.height > lifetime.lastValidBlockHeight) {
    throw new Error("Original blockhash expired; aborted without rebuilding or re-signing");
  }
  const signedWireHashAtSubmission = await wireHash(held);
  if (!equalBytes(reference, held) || signedWireHashBeforeActivation !== signedWireHashAtSubmission) {
    throw new Error("Signed transaction bytes changed; submission refused");
  }
  deps.stage("SUBMISSION");
  const outcome = await deps.submit(prepared, held, stale);
  return {
    environment: LOCAL_ACTIVATION_SOURCE, localT, beforeSimulation, atSimulation,
    simulation, atSigning, atSubmission, lifetime, wireLength: held.length,
    signedWireHashBeforeActivation, signedWireHashAtSubmission, exactEquality: equalBytes(reference, held), outcome,
  };
}
