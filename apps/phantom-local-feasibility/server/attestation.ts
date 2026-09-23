/**
 * EG-A-03: the local coordinator's own record of pre-sign validity.
 *
 * Before this, two facts in the demo evidence came only from the browser: that
 * the transaction simulated cleanly before the activation, and that Phantom
 * returned signed bytes before the activation. A dishonest frontend could
 * assert both. The execution outcome was always validator-derived, so the
 * *rejection* was never in doubt — but "it was valid when you signed it" was.
 *
 * The coordinator now establishes both itself:
 *
 *  1. it simulates the exact unsigned message against 127.0.0.1:8899, reads
 *     the validator Clock itself, and refuses unless the Clock is in the
 *     window the authorization's own encoded phase requires and the
 *     simulation succeeded through EquityGuard, Jupiter and Whirlpool;
 *  2. it receives the Phantom-signed bytes, verifies the Ed25519 signature
 *     over them, requires the signed message to be byte-identical to the one
 *     it simulated, reads the Clock again, and applies the same phase rule.
 *
 * Both legs go through this. A `PENDING` authorization must be attested
 * strictly before `localT`; an `ACTIVATED` one at or after it. The phase is
 * read out of the ABI payload the wallet signs, so the browser cannot choose
 * which window it is held to (see `assertClockMatchesPhase`).
 *
 * The inference that replaces the browser's timestamp: if the coordinator
 * holds a valid Phantom signature over message M while its own Clock read is
 * still before `localT`, then the signature existed before `localT`. The
 * browser is not trusted for any of it, and nothing here can be talked into
 * recording a simulation it did not run.
 *
 * Nothing in this module touches the signed bytes. It hashes and verifies
 * them; the browser keeps holding the only copy it will submit.
 */

import { createHash, createPublicKey, verify } from "node:crypto";

import {
  getAddressEncoder,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";

import {
  EQUITY_GUARD_DEVNET_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ADDRESS,
} from "../../../packages/guard-client/src/index.ts";

/** ABI v2 payload offsets (`programs/equity_guard/src/instruction.rs`). */
const GUARD_DATA_LEN = 99;
const GUARD_VERSION_V2 = 2;
const GUARD_MINT_OFFSET = 1;
const GUARD_EFFECTIVE_TIMESTAMP_OFFSET = 49;
const GUARD_PHASE_OFFSET = 57;
const GUARD_ADAPTER_OFFSET = 66;
const JUPITER_BUY_USDC = 2;
const JUPITER_SELL_USDC = 3;

/** The grammar adapter kinds 2/3 admit after the guard. */
const SUFFIX_LENGTHS = [3, 4];

export const EQUITY_GUARD_PROGRAM = EQUITY_GUARD_DEVNET_PROGRAM_ID;
export const JUPITER_PROGRAM = JUPITER_V6_PROGRAM_ADDRESS;
export const WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Programs whose success the pre-sign simulation must show. */
const REQUIRED_SUCCESS = [EQUITY_GUARD_PROGRAM, JUPITER_PROGRAM, WHIRLPOOL_PROGRAM] as const;

/** DER SPKI prefix for a raw Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Non-secret context for a refusal, so the coordinator can log *why* it said
 * no without logging anything signed. Deliberately carries no wire bytes, no
 * message bytes and no signature.
 */
export interface AttestationContext {
  readonly endpoint?: string;
  readonly proofId?: string;
  readonly phase?: EncodedPhase;
  readonly clock?: string;
  readonly localT?: string;
}

export class AttestationError extends Error {
  readonly code: string;
  readonly context: AttestationContext;
  constructor(code: string, message: string, context: AttestationContext = {}) {
    super(message);
    this.name = "AttestationError";
    this.code = code;
    this.context = context;
  }
}

export interface AttestationClock {
  readonly unixTimestamp: bigint;
  readonly slot: bigint;
}

export interface SimulationResult {
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;
  readonly contextSlot: bigint | null;
}

/** The activation phase an ABI v2 payload names. */
export type EncodedPhase = "PENDING" | "ACTIVATED";

/** Where a Clock reading sits relative to the armed activation. */
export type ClockRelation = "BEFORE_ACTIVATION" | "AT_OR_AFTER_ACTIVATION";

/**
 * What the coordinator's own Clock read proves about *this* authorization.
 *
 * Phase-neutral by construction. An earlier schema recorded
 * `simulatedBeforeLocalT: true` and `receivedBeforeLocalT: true` as literals,
 * which was accurate only for the stale leg: the refreshed leg is attested
 * after `localT` by design, so those booleans asserted the opposite of what
 * the same record's own `clock` showed.
 *
 * Nothing here is a claim about "before"; it is the measured relation, the
 * relation the encoded phase requires, and whether they agree.
 */
export interface PhaseTiming {
  /** The phase the signed ABI payload itself encodes. */
  readonly encodedPhase: EncodedPhase;
  /** Where the coordinator's Clock actually sat. */
  readonly clockRelationToLocalT: ClockRelation;
  /** What `encodedPhase` requires it to be. */
  readonly requiredRelationToLocalT: ClockRelation;
  /** The invariant the coordinator enforced: the two above agree. */
  readonly clockMatchesExpectedPhase: true;
}

/** The relation `phase` requires of the Clock. */
export function requiredRelation(phase: EncodedPhase): ClockRelation {
  return phase === "PENDING" ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
}

/** The relation a Clock reading actually has to `localT`. */
export function observedRelation(clock: AttestationClock, localT: bigint): ClockRelation {
  return clock.unixTimestamp < localT ? "BEFORE_ACTIVATION" : "AT_OR_AFTER_ACTIVATION";
}

/**
 * The timing record for a reading that has already passed
 * `assertClockMatchesPhase`. Throws if it has not, so the `true` literal on
 * `clockMatchesExpectedPhase` can never be written unchecked.
 */
export function phaseTiming(clock: AttestationClock, localT: bigint, encodedPhase: EncodedPhase): PhaseTiming {
  const clockRelationToLocalT = observedRelation(clock, localT);
  const required = requiredRelation(encodedPhase);
  if (clockRelationToLocalT !== required) {
    throw new AttestationError("PHASE_TIMING_MISMATCH", `Clock is ${clockRelationToLocalT}, but ${encodedPhase} requires ${required}`);
  }
  return { encodedPhase, clockRelationToLocalT, requiredRelationToLocalT: required, clockMatchesExpectedPhase: true };
}

/** What the coordinator understood the transaction to be. */
export interface ProtectedTradeShape {
  readonly version: 0;
  readonly signerCount: 1;
  readonly feePayer: Address;
  readonly protectedMint: Address;
  readonly adapterKind: number;
  readonly encodedPhase: EncodedPhase;
  readonly effectiveTimestamp: bigint;
  readonly instructionPrograms: readonly string[];
}

export interface DecodedWire {
  readonly messageBytes: Uint8Array;
  readonly messageSha256: string;
  readonly wireSha256: string;
  readonly wireLength: number;
  readonly feePayer: Address;
  readonly signature: Uint8Array | null;
  readonly signatureBase58: string | null;
  readonly shape: ProtectedTradeShape;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Whether the validator Clock is in the window the authorization's *own*
 * encoded phase requires.
 *
 * The phase comes from the ABI v2 payload the wallet signs, decoded
 * server-side — never from the browser, and never from a caller-supplied
 * flag. The two legs of the reproduction sit on opposite sides of `localT` by
 * construction:
 *
 * - `PENDING` describes pre-activation state, so it may only be attested
 *   strictly before `localT`. Attesting one at or after `localT` would be
 *   claiming an authorization was current when the state had already moved.
 * - `ACTIVATED` describes post-activation state, so it may only be attested
 *   at or after `localT`. Attesting one before `localT` would be claiming a
 *   future state was already live.
 *
 * Neither phase can be attested inside the other's window.
 *
 * This is phase *direction* only. It is not a transition-window check: an
 * `ACTIVATED` authorization exactly at `localT` passes here and is then
 * rejected by the guard itself during simulation
 * (`InsideTransitionWindow`), which is the program's decision to make, not
 * this coordinator's.
 */
function assertClockMatchesPhase(
  clock: AttestationClock,
  localT: bigint,
  phase: EncodedPhase,
  context: AttestationContext,
): void {
  const detail = { ...context, phase, clock: clock.unixTimestamp.toString(), localT: localT.toString() };
  if (phase === "PENDING" && clock.unixTimestamp >= localT) {
    throw new AttestationError(
      "CLOCK_AT_OR_PAST_ACTIVATION",
      `a PENDING authorization needs a validator Clock before the armed activation; Clock ${clock.unixTimestamp} is not before ${localT}`,
      detail,
    );
  }
  if (phase === "ACTIVATED" && clock.unixTimestamp < localT) {
    throw new AttestationError(
      "CLOCK_BEFORE_ACTIVATION",
      `an ACTIVATED authorization needs a validator Clock at or after the armed activation; Clock ${clock.unixTimestamp} is before ${localT}`,
      detail,
    );
  }
}

/**
 * Decodes a transaction wire and checks it is the protected KOx trade this
 * reproduction is about: guard first with an ABI v2 Jupiter payload naming
 * `protectedMint` and `localT`, ComputeBudget next, Jupiter last, one signer.
 *
 * Throws rather than returning a verdict: every caller here refuses on any
 * doubt, and a typed throw keeps that from being accidentally ignored.
 */
export function decodeProtectedTradeWire(
  wireBase64: string,
  expected: { readonly protectedMint: string; readonly localT: bigint },
): DecodedWire {
  let wire: Uint8Array;
  try {
    wire = Uint8Array.from(Buffer.from(wireBase64, "base64"));
  } catch {
    throw new AttestationError("UNDECODABLE_WIRE", "transaction is not base64");
  }
  if (wire.length === 0) throw new AttestationError("UNDECODABLE_WIRE", "transaction is empty");

  let transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  try {
    transaction = getTransactionDecoder().decode(wire);
  } catch {
    throw new AttestationError("UNDECODABLE_WIRE", "transaction does not decode");
  }
  const messageBytes = Uint8Array.from(transaction.messageBytes);

  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  } catch {
    throw new AttestationError("UNDECODABLE_WIRE", "transaction message does not decode");
  }
  if (message.version !== 0) throw new AttestationError("UNSUPPORTED_VERSION", `expected a v0 transaction, got ${String(message.version)}`);

  const signers = Object.keys(transaction.signatures) as Address[];
  const feePayer = signers[0];
  if (signers.length !== 1 || !feePayer) {
    throw new AttestationError("UNEXPECTED_SIGNERS", `expected exactly one signer, got ${signers.length}`);
  }
  if (message.header.numSignerAccounts !== 1 || message.staticAccounts[0] !== feePayer) {
    throw new AttestationError("UNEXPECTED_SIGNERS", "the message's single signer is not its fee payer");
  }

  const programOf = (index: number): string => {
    const key = message.staticAccounts[index];
    if (!key) throw new AttestationError("UNRESOLVED_PROGRAM", `instruction program index ${index} is not a static account`);
    return key;
  };
  const instructions = message.instructions;
  const programs = instructions.map((instruction) => programOf(instruction.programAddressIndex));
  if (!SUFFIX_LENGTHS.includes(instructions.length - 1)) {
    throw new AttestationError("UNSUPPORTED_GRAMMAR", `expected 4 or 5 instructions, got ${instructions.length}`);
  }
  if (programs[0] !== EQUITY_GUARD_PROGRAM) throw new AttestationError("GUARD_NOT_FIRST", `instruction 0 is ${String(programs[0])}, not EquityGuard`);
  if (programs.at(-1) !== JUPITER_PROGRAM) throw new AttestationError("JUPITER_NOT_LAST", `the last instruction is ${String(programs.at(-1))}, not Jupiter`);
  for (const index of [1, 2]) {
    if (programs[index] !== COMPUTE_BUDGET_PROGRAM) {
      throw new AttestationError("UNSUPPORTED_GRAMMAR", `instruction ${index} is ${String(programs[index])}, not ComputeBudget`);
    }
  }

  const guardData = instructions[0]?.data;
  if (!guardData || guardData.length !== GUARD_DATA_LEN) {
    throw new AttestationError("UNSUPPORTED_GUARD_PAYLOAD", `guard payload is ${guardData?.length ?? 0} bytes, expected ${GUARD_DATA_LEN}`);
  }
  if (guardData[0] !== GUARD_VERSION_V2) throw new AttestationError("UNSUPPORTED_GUARD_PAYLOAD", `guard ABI version ${String(guardData[0])}`);

  const adapterKind = guardData[GUARD_ADAPTER_OFFSET]!;
  if (adapterKind !== JUPITER_BUY_USDC && adapterKind !== JUPITER_SELL_USDC) {
    throw new AttestationError("UNSUPPORTED_GUARD_PAYLOAD", `adapter kind ${adapterKind} is not a Jupiter adapter`);
  }
  const protectedMint = getBase58Decoder().decode(guardData.subarray(GUARD_MINT_OFFSET, GUARD_MINT_OFFSET + 32)) as Address;
  if (protectedMint !== expected.protectedMint) {
    throw new AttestationError("UNEXPECTED_MINT", `guard protects ${protectedMint}, not ${expected.protectedMint}`);
  }
  const effectiveTimestamp = new DataView(guardData.buffer, guardData.byteOffset, guardData.byteLength)
    .getBigInt64(GUARD_EFFECTIVE_TIMESTAMP_OFFSET, true);
  if (effectiveTimestamp !== expected.localT) {
    throw new AttestationError("UNEXPECTED_ACTIVATION", `guard names activation ${effectiveTimestamp}, not the armed ${expected.localT}`);
  }
  const phaseByte = guardData[GUARD_PHASE_OFFSET];
  if (phaseByte !== 0 && phaseByte !== 1) throw new AttestationError("UNSUPPORTED_GUARD_PAYLOAD", `activation phase byte ${String(phaseByte)}`);

  const signature = transaction.signatures[feePayer] ?? null;
  return {
    messageBytes,
    messageSha256: sha256(messageBytes),
    wireSha256: sha256(wire),
    wireLength: wire.length,
    feePayer,
    signature: signature ? Uint8Array.from(signature) : null,
    signatureBase58: signature ? getBase58Decoder().decode(signature) : null,
    shape: {
      version: 0,
      signerCount: 1,
      feePayer,
      protectedMint,
      adapterKind,
      encodedPhase: phaseByte === 0 ? "PENDING" : "ACTIVATED",
      effectiveTimestamp,
      instructionPrograms: programs,
    },
  };
}

/** Verifies a raw Ed25519 signature over `message` by `signer`. */
export function verifySignature(signer: Address, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    const raw = Buffer.from(getAddressEncoder().encode(signer));
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export interface PreSignSimulationRecord {
  readonly proofId: string;
  readonly source: "LOCAL_COORDINATOR";
  readonly capturedAtUtc: string;
  readonly localT: string;
  readonly clock: { readonly unixTimestamp: string; readonly slot: string };
  readonly contextSlot: string | null;
  /** What the coordinator's Clock read proves for this leg. */
  readonly timing: PhaseTiming;
  readonly messageSha256: string;
  readonly unsignedWireSha256: string;
  readonly wireLength: number;
  readonly shape: ProtectedTradeShape;
  readonly err: null;
  readonly logs: readonly string[];
  readonly computeUnits: number | null;
  readonly programsSucceeded: readonly string[];
}

export interface SignedAuthorizationRecord {
  readonly proofId: string;
  readonly source: "LOCAL_COORDINATOR";
  readonly capturedAtUtc: string;
  readonly localT: string;
  readonly clock: { readonly unixTimestamp: string; readonly slot: string };
  /** What the coordinator's Clock read proves for this leg. */
  readonly timing: PhaseTiming;
  readonly signer: Address;
  readonly signature: string;
  readonly signatureVerified: true;
  readonly signedWireSha256: string;
  readonly wireLength: number;
  readonly messageSha256: string;
  readonly messageMatchesSimulated: true;
  readonly simulationProofId: string;
}

export interface AttestationDependencies {
  /** Reads the validator Clock. Server-side; never supplied by the browser. */
  readonly clock: () => Promise<AttestationClock>;
  /** Runs `simulateTransaction` against the local validator. */
  readonly simulate: (wireBase64: string) => Promise<SimulationResult>;
  readonly protectedMint: string;
  /** Defaults to a random id; injectable so tests are deterministic. */
  readonly newProofId?: () => string;
  readonly now?: () => Date;
}

/**
 * The coordinator's attestation store.
 *
 * Every refusal is an `AttestationError`; there is no partial success and no
 * path that records something weaker than it was asked to prove.
 */
export class CoordinatorAttestations {
  readonly #deps: AttestationDependencies;
  readonly #simulations = new Map<string, PreSignSimulationRecord>();
  readonly #authorizations = new Map<string, SignedAuthorizationRecord>();
  #counter = 0;

  constructor(deps: AttestationDependencies) {
    this.#deps = deps;
  }

  #proofId(): string {
    this.#counter += 1;
    return this.#deps.newProofId?.() ?? `presign-${this.#counter}`;
  }

  #timestamp(): string {
    return (this.#deps.now?.() ?? new Date()).toISOString();
  }

  /**
   * Simulates the exact unsigned message and records that it was valid before
   * `localT`. The browser supplies only the bytes; the Clock read and the
   * simulation are both the coordinator's own.
   */
  async recordPreSignSimulation(input: { readonly unsignedWireBase64: string; readonly localT: bigint }): Promise<PreSignSimulationRecord> {
    const decoded = decodeProtectedTradeWire(input.unsignedWireBase64, {
      protectedMint: this.#deps.protectedMint,
      localT: input.localT,
    });
    const clock = await this.#deps.clock();
    const context: AttestationContext = { endpoint: "pre-sign-simulation" };
    assertClockMatchesPhase(clock, input.localT, decoded.shape.encodedPhase, context);
    const detail: AttestationContext = {
      ...context,
      phase: decoded.shape.encodedPhase,
      clock: clock.unixTimestamp.toString(),
      localT: input.localT.toString(),
    };
    // The guard's own verdict, including the transition window, is decided
    // here by the program during simulation — not by the phase rule above.
    const simulation = await this.#deps.simulate(input.unsignedWireBase64);
    if (simulation.err !== null && simulation.err !== undefined) {
      throw new AttestationError("SIMULATION_FAILED", `pre-sign simulation failed: ${JSON.stringify(simulation.err)}`, detail);
    }
    const succeeded = REQUIRED_SUCCESS.filter((program) => simulation.logs.includes(`Program ${program} success`));
    if (succeeded.length !== REQUIRED_SUCCESS.length) {
      const missing = REQUIRED_SUCCESS.filter((program) => !succeeded.includes(program));
      throw new AttestationError("SIMULATION_INCOMPLETE", `pre-sign simulation did not show success for ${missing.join(", ")}`, detail);
    }
    const record: PreSignSimulationRecord = {
      proofId: this.#proofId(),
      source: "LOCAL_COORDINATOR",
      capturedAtUtc: this.#timestamp(),
      localT: input.localT.toString(),
      clock: { unixTimestamp: clock.unixTimestamp.toString(), slot: clock.slot.toString() },
      contextSlot: simulation.contextSlot === null ? null : simulation.contextSlot.toString(),
      timing: phaseTiming(clock, input.localT, decoded.shape.encodedPhase),
      messageSha256: decoded.messageSha256,
      unsignedWireSha256: decoded.wireSha256,
      wireLength: decoded.wireLength,
      shape: decoded.shape,
      err: null,
      logs: simulation.logs,
      computeUnits: simulation.unitsConsumed,
      programsSucceeded: succeeded,
    };
    this.#simulations.set(record.proofId, record);
    return record;
  }

  /**
   * Receives the Phantom-signed bytes, verifies the signature over them, and
   * records that the coordinator held them before `localT`.
   *
   * The signed message must be byte-identical to the simulated one: that is
   * what links "this simulated cleanly before T" to "this is what was signed",
   * and later to "these exact bytes executed after T".
   */
  async recordSignedAuthorization(input: {
    readonly proofId: string;
    readonly signedWireBase64: string;
    readonly localT: bigint;
  }): Promise<SignedAuthorizationRecord> {
    const where: AttestationContext = { endpoint: "signed-authorization", proofId: input.proofId, localT: input.localT.toString() };
    const simulation = this.#simulations.get(input.proofId);
    if (!simulation) throw new AttestationError("UNKNOWN_PROOF", `no pre-sign simulation ${input.proofId}`, where);
    if (simulation.localT !== input.localT.toString()) {
      throw new AttestationError("ACTIVATION_MISMATCH", "signed authorization names a different activation than its simulation", where);
    }
    if (this.#authorizations.has(input.proofId)) {
      throw new AttestationError("ALREADY_ATTESTED", `pre-sign simulation ${input.proofId} already has a signed authorization`, where);
    }
    const decoded = decodeProtectedTradeWire(input.signedWireBase64, {
      protectedMint: this.#deps.protectedMint,
      localT: input.localT,
    });
    const detail: AttestationContext = { ...where, phase: decoded.shape.encodedPhase };
    if (decoded.messageSha256 !== simulation.messageSha256) {
      throw new AttestationError(
        "MESSAGE_MISMATCH",
        `signed message ${decoded.messageSha256} is not the simulated ${simulation.messageSha256}`,
        detail,
      );
    }
    if (!decoded.signature || !decoded.signatureBase58) {
      throw new AttestationError("MISSING_SIGNATURE", "the submitted transaction carries no signature", detail);
    }
    if (!verifySignature(decoded.feePayer, decoded.messageBytes, decoded.signature)) {
      throw new AttestationError("INVALID_SIGNATURE", `the signature does not verify under ${decoded.feePayer}`, detail);
    }
    // Read the Clock only after the signature is known good, so a rejected
    // authorization can never consume the pre-activation window.
    const clock = await this.#deps.clock();
    assertClockMatchesPhase(clock, input.localT, decoded.shape.encodedPhase, {
      endpoint: "signed-authorization",
      proofId: input.proofId,
    });
    const record: SignedAuthorizationRecord = {
      proofId: input.proofId,
      source: "LOCAL_COORDINATOR",
      capturedAtUtc: this.#timestamp(),
      localT: input.localT.toString(),
      clock: { unixTimestamp: clock.unixTimestamp.toString(), slot: clock.slot.toString() },
      timing: phaseTiming(clock, input.localT, decoded.shape.encodedPhase),
      signer: decoded.feePayer,
      signature: decoded.signatureBase58,
      signatureVerified: true,
      signedWireSha256: decoded.wireSha256,
      wireLength: decoded.wireLength,
      messageSha256: decoded.messageSha256,
      messageMatchesSimulated: true,
      simulationProofId: simulation.proofId,
    };
    this.#authorizations.set(input.proofId, record);
    return record;
  }

  /** Everything the coordinator attested, for the run record. */
  snapshot(): {
    readonly preSignSimulations: readonly PreSignSimulationRecord[];
    readonly signedAuthorizations: readonly SignedAuthorizationRecord[];
  } {
    return {
      preSignSimulations: [...this.#simulations.values()],
      signedAuthorizations: [...this.#authorizations.values()],
    };
  }

  /** The authoritative record for one signature, by signed-wire hash. */
  authorizationForWire(signedWireSha256: string): SignedAuthorizationRecord | null {
    return [...this.#authorizations.values()].find((record) => record.signedWireSha256 === signedWireSha256) ?? null;
  }
}
