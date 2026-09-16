import { readFileSync } from "node:fs";

/** Shared fixtures owned by the Rust program crate, so both languages test the same bytes. */
const FIXTURES = new URL("../../../programs/equity_guard/tests/fixtures/", import.meta.url);

export interface GoldenVector {
  name: string;
  request: {
    expectedMint: string;
    multiplierHex: string;
    newMultiplierHex: string;
    newMultiplierEffectiveTimestamp: string;
    expectedPhase: number;
    protectionBeforeSecs: number;
    protectionAfterSecs: number;
    adapterKind: number;
    downstreamCommitmentHex: string;
  };
  encodedHex: string;
}

export interface CommitmentVector {
  name: string;
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  dataHex: string;
  commitmentHex: string;
}

export interface SuffixCommitmentVector {
  name: string;
  feePayer: string | null;
  /** The suffix as the Instructions sysvar exposes it. */
  instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; dataHex: string }[];
  commitmentHex: string;
}

export interface Golden {
  abiVersion: number;
  encodedLength: number;
  offsets: Record<string, number>;
  commitmentDomain: string;
  jupiterSuffixCommitmentDomain: string;
  suffixCommitmentVectors: SuffixCommitmentVector[];
  errorCodes: Record<string, number>;
  vectors: GoldenVector[];
  invalid: { name: string; dataHex: string; error: string }[];
  commitmentVectors: CommitmentVector[];
}

export interface DecodedMint {
  symbol: string;
  multiplierHex: string;
  newMultiplierHex: string;
  newMultiplierEffectiveTimestamp: string;
}

export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export function readGolden(): Golden {
  return JSON.parse(readFileSync(new URL("abi_v2_golden.json", FIXTURES), "utf8")) as Golden;
}

export function readDecodedMints(): DecodedMint[] {
  const parsed = JSON.parse(readFileSync(new URL("mainnet/decoded.json", FIXTURES), "utf8")) as {
    mints: DecodedMint[];
  };
  return parsed.mints;
}

export function mainnetMint(symbol: string): Uint8Array {
  const encoded = readFileSync(new URL(`mainnet/${symbol}.base64`, FIXTURES), "utf8").trim();
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}
