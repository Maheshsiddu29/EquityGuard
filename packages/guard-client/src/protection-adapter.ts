/**
 * Which assets EquityGuard claims to protect, and under which economic-state
 * model. One resolver owns this decision; callers must not re-derive it from
 * mint bytes themselves.
 *
 * Two questions are deliberately kept apart:
 *
 *   1. Does this mint account present a state model the guard can assert?
 *      Answered generically, by the reviewed decoder: Token-2022 with a
 *      decodable ScaledUiAmount extension. This is what the program checks, so
 *      it — not a hard-coded list — is what makes an asset protectable.
 *   2. Is this mint a KNOWN tokenized equity?
 *      Answered by a small registry of representations this repository holds
 *      chain evidence for.
 *
 * The second question exists for one reason: a known tokenized equity that
 * stops presenting a supported state model must FAIL CLOSED, not be mistaken
 * for an ordinary token. Unknown protection semantics must never become
 * permission.
 *
 * Deliberately NOT a gate here: the Token-2022 Pausable flag. The guard does
 * not inspect it, because Token-2022 itself blocks transfers of a paused mint,
 * so a downstream swap fails regardless (`docs/threat-model.md`). Adding a
 * pause check here would claim a protection the program does not provide.
 */

import type { Address } from "@solana/kit";

import type { ProtectedState } from "./abi.ts";
import { GuardClientError, type GuardClientErrorCode } from "./errors.ts";
import { decodeProtectedState } from "./mint-state.ts";

/**
 * Economic-state models EquityGuard can assert on chain. Exactly one exists:
 * ABI v2 binds the ScaledUiAmount multipliers, the scheduled activation
 * timestamp and the activation phase, and nothing else.
 */
export const PROTECTED_STATE_MODEL = {
  TOKEN_2022_SCALED_UI_AMOUNT: "TOKEN_2022_SCALED_UI_AMOUNT",
} as const;
export type ProtectedStateModel = (typeof PROTECTED_STATE_MODEL)[keyof typeof PROTECTED_STATE_MODEL];

const IMPLEMENTED_STATE_MODELS: ReadonlySet<string> = new Set(Object.values(PROTECTED_STATE_MODEL));

export interface KnownProtectedAsset {
  readonly mint: Address;
  readonly symbol: string;
  readonly issuer: "xStocks" | "Ondo";
  readonly underlying: string;
  /**
   * The economic-state model this representation is known to use. A model this
   * client does not implement fails closed rather than being ignored.
   */
  readonly stateModel: string;
  /** Why this entry claims that model. Chain evidence only. */
  readonly evidence: string;
}

const XSTOCKS_EVIDENCE =
  "mainnet account decoded at slot 446827429; multipliers kept distinct with a scheduled activation (KOx schedule + Clock activation observed 2026-09-14/15, docs/m10a-corporate-action-validation.md)";
/**
 * Ondo representations carry the same extension and decode under the same
 * model; their observed shape is an immediate update (multiplier and new
 * multiplier equal, no pending phase), which the guard's stored-state identity
 * check covers without a protection window. Nothing here claims anything about
 * the Ondo API, which was never observed.
 */
const ONDO_EVIDENCE =
  "mainnet account decoded at slot 446827429; immediate multiplier updates observed on KOon and UNHon, both mapped to the current semantics (docs/m10a-corporate-action-validation.md)";

/**
 * Representations this repository holds decoded mainnet evidence for. It is
 * not a claim that these are the only protected assets: an unlisted mint that
 * presents a supported state model is still protected.
 *
 * Every entry is frozen, not just the array: results hand these objects to
 * callers as `knownAsset`, and a caller writing to one must not change how the
 * next request is classified.
 */
export const KNOWN_PROTECTED_ASSETS: readonly KnownProtectedAsset[] = Object.freeze(
  ([
    { mint: "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ" as Address, symbol: "KOx", issuer: "xStocks", underlying: "KO", stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT, evidence: XSTOCKS_EVIDENCE },
    { mint: "XszvaiXGPwvk2nwb3o9C1CX4K6zH8sez11E6uyup6fe" as Address, symbol: "UNHx", issuer: "xStocks", underlying: "UNH", stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT, evidence: XSTOCKS_EVIDENCE },
    { mint: "XsczbcQ3zfcgAEt9qHQES8pxKAVG5rujPSHQEXi4kaN" as Address, symbol: "CRMx", issuer: "xStocks", underlying: "CRM", stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT, evidence: XSTOCKS_EVIDENCE },
    { mint: "e6G4pfFcrdKxJuZ4YXixRFfMbpMvgXG2Mjcus71ondo" as Address, symbol: "KOon", issuer: "Ondo", underlying: "KO", stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT, evidence: ONDO_EVIDENCE },
    { mint: "kPBGL8vAwKN3UGmr9cjkM2dU79SC3nzTC9yu7F8ondo" as Address, symbol: "UNHon", issuer: "Ondo", underlying: "UNH", stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT, evidence: ONDO_EVIDENCE },
    { mint: "7D7ukbcnUNYt7Et5vtsDZhAy28MKu9pkHka1Hp9ondo" as Address, symbol: "CRMon", issuer: "Ondo", underlying: "CRM", stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT, evidence: ONDO_EVIDENCE },
  ] satisfies KnownProtectedAsset[]).map((asset) => Object.freeze(asset)),
);

/** Why a known protected asset cannot be protected right now. */
export type UnsupportedAssetReason =
  /** The registry declares a state model this client does not implement. */
  | "UNSUPPORTED_STATE_MODEL"
  /** The account does not present the supported state model at all. */
  | "NO_SUPPORTED_STATE_ADAPTER";

/** Why a mint is outside EquityGuard's protected universe. Positive classifications only. */
export type NotProtectedReason =
  /** The mint is not owned by Token-2022, so it has no protected state. */
  | "NOT_TOKEN_2022"
  /** A Token-2022 mint, not a known representation, carrying no supported state model. */
  | "NO_PROTECTED_STATE_MODEL";

export type ProtectionResolution =
  /** Ordinary asset: EquityGuard does not apply and the caller's own path is correct. */
  | { readonly kind: "NOT_PROTECTED"; readonly reason: NotProtectedReason }
  /** A supported economic-state model was established from the account. */
  | { readonly kind: "SUPPORTED"; readonly stateModel: ProtectedStateModel; readonly state: ProtectedState; readonly knownAsset: KnownProtectedAsset | null }
  /** A known tokenized equity whose protection semantics cannot be established. Fail closed. */
  | { readonly kind: "KNOWN_PROTECTED_UNSUPPORTED"; readonly reason: UnsupportedAssetReason; readonly message: string; readonly knownAsset: KnownProtectedAsset }
  /** The state model should be there but the account cannot be read. Fail closed. */
  | { readonly kind: "INVALID_STATE"; readonly errorCode: GuardClientErrorCode; readonly message: string; readonly knownAsset: KnownProtectedAsset | null };

/** The registry entry for a mint, if this repository knows it. */
export function findKnownProtectedAsset(
  mint: Address | string,
  registry: readonly KnownProtectedAsset[] = KNOWN_PROTECTED_ASSETS,
): KnownProtectedAsset | null {
  return registry.find((asset) => asset.mint === mint) ?? null;
}

/**
 * Classifies one mint account. `registry` is a parameter so the resolver can
 * be extended — and tested — without touching its callers.
 */
export function resolveProtectionAdapter(input: {
  readonly mint: Address;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly registry?: readonly KnownProtectedAsset[];
}): ProtectionResolution {
  const knownAsset = findKnownProtectedAsset(input.mint, input.registry ?? KNOWN_PROTECTED_ASSETS);
  if (knownAsset && !IMPLEMENTED_STATE_MODELS.has(knownAsset.stateModel)) {
    return {
      kind: "KNOWN_PROTECTED_UNSUPPORTED",
      reason: "UNSUPPORTED_STATE_MODEL",
      message: `${knownAsset.symbol} (${knownAsset.issuer}) uses economic-state model ${knownAsset.stateModel}, which this EquityGuard client does not implement`,
      knownAsset,
    };
  }

  try {
    return {
      kind: "SUPPORTED",
      stateModel: PROTECTED_STATE_MODEL.TOKEN_2022_SCALED_UI_AMOUNT,
      state: decodeProtectedState(input.owner, input.data),
      knownAsset,
    };
  } catch (error) {
    if (!(error instanceof GuardClientError)) throw error;
    // The account simply does not carry a protected state model.
    if (error.code === "InvalidMintOwner" || error.code === "MissingScaledUiAmount") {
      if (knownAsset) {
        return {
          kind: "KNOWN_PROTECTED_UNSUPPORTED",
          reason: "NO_SUPPORTED_STATE_ADAPTER",
          message: `${knownAsset.symbol} (${knownAsset.issuer}) is a known tokenized ${knownAsset.underlying} representation, but its mint account does not present ${knownAsset.stateModel}: ${error.message}`,
          knownAsset,
        };
      }
      return { kind: "NOT_PROTECTED", reason: error.code === "InvalidMintOwner" ? "NOT_TOKEN_2022" : "NO_PROTECTED_STATE_MODEL" };
    }
    // Token-2022, plausibly protected, unreadable: never an ordinary asset.
    return { kind: "INVALID_STATE", errorCode: error.code, message: error.message, knownAsset };
  }
}
