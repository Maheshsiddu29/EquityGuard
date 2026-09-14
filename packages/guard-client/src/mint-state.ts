/**
 * Token-2022 ScaledUiAmount decoding. Mirrors the program's fail-closed
 * `decode_protected_state` so clients reject what the guard would reject.
 * The on-chain program remains the authority.
 */

import { isValidStoredMultiplier, type ProtectedState } from "./abi.ts";
import { GuardClientError } from "./errors.ts";

export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Token-2022 account layout constants (spl-token-2022-interface 3.1.1).
const BASE_MINT_LEN = 82;
const MULTISIG_LEN = 355;
/** Extensions accounts share this prefix length before the account-type byte. */
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = ACCOUNT_TYPE_OFFSET + 1;
const ACCOUNT_TYPE_MINT = 1;
const MINT_AUTHORITY_TAG_OFFSET = 0;
const MINT_IS_INITIALIZED_OFFSET = 45;
const FREEZE_AUTHORITY_TAG_OFFSET = 46;
const TLV_HEADER_LEN = 4;

/** Extension type codes used by the decoder. */
const ExtensionType = {
  Uninitialized: 0,
  TransferFeeConfig: 1,
  ConfidentialTransferMint: 4,
  NonTransferable: 9,
  InterestBearingConfig: 10,
  ConfidentialTransferFeeConfig: 16,
  ConfidentialMintBurn: 24,
  ScaledUiAmount: 25,
  /** Highest extension type known to spl-token-2022-interface 3.1.1. */
  MaxKnown: 28,
} as const;

/** authority (32) + multiplier (8) + effective timestamp (8) + new multiplier (8). */
const SCALED_UI_AMOUNT_CONFIG_LEN = 56;

/**
 * Decodes the protected ScaledUiAmount state from a mint account's owner and
 * raw data. Throws {@link GuardClientError} on anything the program rejects.
 */
export function decodeProtectedState(owner: string, data: Uint8Array): ProtectedState {
  if (owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new GuardClientError("InvalidMintOwner", `owner ${owner} is not Token-2022`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  validateBaseMint(data, view);

  if (data.length === BASE_MINT_LEN) {
    throw new GuardClientError("MissingScaledUiAmount", "mint has no extensions");
  }
  if (data.length < TLV_START) {
    throw new GuardClientError("InvalidMintData", "extension header truncated");
  }
  if (data.subarray(BASE_MINT_LEN, ACCOUNT_TYPE_OFFSET).some((byte) => byte !== 0)) {
    throw new GuardClientError("InvalidMintData", "non-zero padding before account type");
  }
  if (data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) {
    throw new GuardClientError("InvalidMintData", "account type is not Mint");
  }

  const entries = readTlvEntries(data, view);
  const types = new Set(entries.map((entry) => entry.type));
  const scaledUi = entries.find((entry) => entry.type === ExtensionType.ScaledUiAmount);
  if (!scaledUi) {
    throw new GuardClientError("MissingScaledUiAmount", "mint has no ScaledUiAmount extension");
  }
  assertValidMintExtensionCombination(types);
  if (scaledUi.length !== SCALED_UI_AMOUNT_CONFIG_LEN) {
    throw new GuardClientError("InvalidMintData", "ScaledUiAmount config has wrong length");
  }

  const value = scaledUi.valueOffset;
  const multiplier = data.slice(value + 32, value + 40);
  const newMultiplier = data.slice(value + 48, value + 56);
  if (!isValidStoredMultiplier(multiplier) || !isValidStoredMultiplier(newMultiplier)) {
    throw new GuardClientError("InvalidMultiplier", "stored multiplier is not positive and normal");
  }
  return {
    multiplier,
    newMultiplier,
    newMultiplierEffectiveTimestamp: view.getBigInt64(value + 40, true),
  };
}

function validateBaseMint(data: Uint8Array, view: DataView): void {
  if (data.length < BASE_MINT_LEN || data.length === MULTISIG_LEN) {
    throw new GuardClientError("InvalidMintData", `unexpected account length ${data.length}`);
  }
  for (const offset of [MINT_AUTHORITY_TAG_OFFSET, FREEZE_AUTHORITY_TAG_OFFSET]) {
    const tag = view.getUint32(offset, true);
    if (tag !== 0 && tag !== 1) {
      throw new GuardClientError("InvalidMintData", "invalid COption tag");
    }
  }
  if (data[MINT_IS_INITIALIZED_OFFSET] !== 1) {
    throw new GuardClientError("InvalidMintData", "mint is not initialized");
  }
}

interface TlvEntry {
  readonly type: number;
  readonly length: number;
  readonly valueOffset: number;
}

/** Walks the whole TLV area, so corruption anywhere fails closed. */
function readTlvEntries(data: Uint8Array, view: DataView): TlvEntry[] {
  const entries: TlvEntry[] = [];
  let offset = TLV_START;
  // Fewer than two remaining bytes cannot hold a type; Token-2022 treats that
  // as the end of the TLV area.
  while (data.length - offset >= 2) {
    const type = view.getUint16(offset, true);
    if (type === ExtensionType.Uninitialized) break;
    if (type > ExtensionType.MaxKnown) {
      throw new GuardClientError("InvalidMintData", `unknown extension type ${type}`);
    }
    if (data.length - offset < TLV_HEADER_LEN) {
      throw new GuardClientError("InvalidMintData", "TLV length truncated");
    }
    const length = view.getUint16(offset + 2, true);
    const valueOffset = offset + TLV_HEADER_LEN;
    if (valueOffset + length > data.length) {
      throw new GuardClientError("InvalidMintData", "TLV value overruns account");
    }
    entries.push({ type, length, valueOffset });
    offset = valueOffset + length;
  }
  return entries;
}

/** Token-2022's `check_for_invalid_mint_extension_combinations`. */
function assertValidMintExtensionCombination(types: ReadonlySet<number>): void {
  const has = (type: number) => types.has(type);
  const invalid =
    (has(ExtensionType.ConfidentialTransferFeeConfig) &&
      !(has(ExtensionType.TransferFeeConfig) && has(ExtensionType.ConfidentialTransferMint))) ||
    (has(ExtensionType.TransferFeeConfig) &&
      has(ExtensionType.ConfidentialTransferMint) &&
      !has(ExtensionType.ConfidentialTransferFeeConfig)) ||
    (has(ExtensionType.ConfidentialMintBurn) && !has(ExtensionType.ConfidentialTransferMint)) ||
    (has(ExtensionType.ScaledUiAmount) && has(ExtensionType.InterestBearingConfig)) ||
    (has(ExtensionType.NonTransferable) &&
      has(ExtensionType.ConfidentialTransferMint) &&
      !has(ExtensionType.ConfidentialMintBurn));
  if (invalid) {
    throw new GuardClientError("InvalidExtensionCombination", "mint extension set is forbidden by Token-2022");
  }
}
