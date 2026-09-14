/**
 * Pure decoding of raw capture JSONL lines into chain observations.
 *
 * INV-CAP-01: this module never touches files. Callers hand it lines read
 * from a COPY of a capture; it has no way to write anywhere.
 *
 * Supported line formats:
 * - poll format (external recorder): `{ wallclock, slot, blockTime, accounts: [{ symbol, issuer, address, exists, owner, data, encoding }] }`
 * - repository recorder schema v1: `{ schemaVersion: 1, capturedAt, slot, blockTime, symbol, issuer, mint, exists, owner, dataBase64 }`
 */

import { observeMintAccount } from "./chain-observation.ts";
import type { ChainEvidence } from "./types.ts";

export interface CaptureObservation {
  readonly kind: "observation";
  readonly lineNumber: number;
  readonly wallclock: string | null;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  readonly symbol: string | null;
  readonly issuer: string | null;
  readonly mint: string;
  /** Decoded state at `blockTime`, or a decode failure kept as evidence. */
  readonly evidence: ChainEvidence;
}

/** A line (or account entry) that could not be attributed to a mint. */
export interface CaptureLineError {
  readonly kind: "line-error";
  readonly lineNumber: number;
  readonly code: "MalformedJson" | "UnrecognizedRecord" | "MissingMint";
  readonly message: string;
}

export type CaptureRecord = CaptureObservation | CaptureLineError;

interface AccountEntry {
  readonly symbol: string | null;
  readonly issuer: string | null;
  readonly mint: unknown;
  readonly exists: unknown;
  readonly owner: unknown;
  readonly data: unknown;
  readonly encoding: unknown;
}

/** Decodes one JSONL line into zero or more records. Never throws on bad input. */
export function decodeCaptureLine(line: string, lineNumber: number): CaptureRecord[] {
  if (line.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ kind: "line-error", lineNumber, code: "MalformedJson", message: "line is not valid JSON" }];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [lineError(lineNumber, "UnrecognizedRecord", "line is not a JSON object")];
  }
  const record = parsed as Record<string, unknown>;
  const slot = toBigInt(record.slot);
  const blockTime = toBigInt(record.blockTime);

  if (Array.isArray(record.accounts)) {
    const wallclock = typeof record.wallclock === "string" ? record.wallclock : null;
    return record.accounts.map((raw) => {
      const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      return decodeAccount(lineNumber, wallclock, slot, blockTime, {
        symbol: stringOrNull(a.symbol),
        issuer: stringOrNull(a.issuer),
        mint: a.address,
        exists: a.exists,
        owner: a.owner,
        data: a.data,
        encoding: a.encoding,
      });
    });
  }
  if (record.schemaVersion === 1) {
    return [
      decodeAccount(lineNumber, stringOrNull(record.capturedAt), slot, blockTime, {
        symbol: stringOrNull(record.symbol),
        issuer: stringOrNull(record.issuer),
        mint: record.mint,
        exists: record.exists,
        owner: record.owner,
        data: record.dataBase64,
        encoding: "base64",
      }),
    ];
  }
  return [lineError(lineNumber, "UnrecognizedRecord", "neither poll format nor schema v1")];
}

function decodeAccount(
  lineNumber: number,
  wallclock: string | null,
  slot: bigint | null,
  blockTime: bigint | null,
  entry: AccountEntry,
): CaptureRecord {
  if (typeof entry.mint !== "string" || entry.mint === "") {
    return lineError(lineNumber, "MissingMint", "account entry has no mint address");
  }
  const base = { kind: "observation" as const, lineNumber, wallclock, slot, blockTime, symbol: entry.symbol, issuer: entry.issuer, mint: entry.mint };
  const failure = (code: string, message: string): CaptureObservation => ({
    ...base,
    evidence: { kind: "decode-error", mint: entry.mint as string, slot, blockTime, observedAt: wallclock, code, message },
  });
  if (entry.exists === false) return failure("AccountNotFound", "account did not exist at this slot");
  if (typeof entry.owner !== "string") return failure("MissingOwner", "account owner missing");
  if (typeof entry.data !== "string" || entry.encoding !== "base64") {
    return failure("MissingData", "account data missing or not base64");
  }
  return {
    ...base,
    // Block time of the observed slot is the chain time for phase decisions.
    evidence: observeMintAccount({
      mint: entry.mint,
      owner: entry.owner,
      data: Uint8Array.from(Buffer.from(entry.data, "base64")),
      slot,
      blockTime,
      observedAt: wallclock,
      chainUnixTimestamp: blockTime,
    }),
  };
}

function lineError(lineNumber: number, code: CaptureLineError["code"], message: string): CaptureLineError {
  return { kind: "line-error", lineNumber, code, message };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Integers only; JSON numbers beyond 2^53 are not trusted for slots or times. */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

/** JSON-safe projection of a record (bytes as hex, integers as strings). */
export function captureRecordToJson(record: CaptureRecord): unknown {
  if (record.kind === "line-error") return record;
  const e = record.evidence;
  const evidence =
    e.kind === "decode-error"
      ? e
      : {
          ...e,
          protectedState: {
            multiplierHex: Buffer.from(e.protectedState.multiplier).toString("hex"),
            newMultiplierHex: Buffer.from(e.protectedState.newMultiplier).toString("hex"),
            newMultiplierEffectiveTimestamp: e.protectedState.newMultiplierEffectiveTimestamp,
          },
          phase: e.phase === null ? null : e.phase === 0 ? "pending" : "activated",
        };
  return JSON.parse(JSON.stringify({ ...record, evidence }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}
