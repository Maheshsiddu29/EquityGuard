import { decodeInstructionError, type LocalSimulationFailure } from "./rpc-failure.ts";

/**
 * Stages of one Buy or Confirm click. A click never reuses a previous click's
 * blockhash, transaction, or simulation; the stage only names the await that failed.
 */
export const BUY_STAGES = [
  "ENVIRONMENT_CHECK",
  "PHANTOM_CONNECT",
  "TRANSACTION_BUILD",
  "SIGN_REQUEST",
  "SIGNED_BYTES_RETURNED",
  "SIMULATION",
  "PRE_SIGN_SIMULATION",
  "SIGNED_AUTHORIZATION_RECEIPT",
  "DEPLOYMENT_ATTESTATION",
  "WAITING_FOR_ACTIVATION",
  "BLOCKHASH_VALIDATION",
  "SUBMISSION",
  "CONFIRMATION",
  "BALANCE_VERIFICATION",
] as const;

export type BuyStage = (typeof BUY_STAGES)[number];

const STAGE_SET: ReadonlySet<string> = new Set(BUY_STAGES);

export function isBuyStage(value: string): value is BuyStage {
  return STAGE_SET.has(value);
}

export interface PreparationIdentity {
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly messageBytes: ArrayLike<number>;
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * True only when the build still carries a cached pre-reset blockhash and message
 * after the validator's latest blockhash has moved. A matching live blockhash is
 * a fresh read, not a cache hit.
 */
export function reusesStaleBlockhash(
  cached: PreparationIdentity | null,
  built: PreparationIdentity,
  latestBlockhash: string,
): boolean {
  if (cached === null) return false;
  return cached.blockhash === built.blockhash
    && cached.lastValidBlockHeight === built.lastValidBlockHeight
    && sameBytes(cached.messageBytes, built.messageBytes)
    && built.blockhash !== latestBlockhash;
}

interface NormalizedThrown {
  readonly type: string;
  readonly name: string | null;
  readonly message: string | null;
  readonly code: string | number | null;
  readonly cause: string | null;
  readonly rpcCode: number | null;
  readonly instruction: string | null;
  readonly program: string | null;
  readonly errorDetail: string | null;
  readonly logs: readonly string[];
  readonly stack: string | null;
  readonly meaningful: boolean;
}

function read(value: object, key: string): unknown {
  if (!(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readString(value: object, key: string): string | null {
  const field = read(value, key);
  return typeof field === "string" && field.length > 0 ? field : null;
}

function readCode(value: object): string | number | null {
  const code = read(value, "code");
  if (typeof code === "number" && Number.isFinite(code)) return code;
  if (typeof code === "bigint") return code.toString();
  if (typeof code === "string" && code.length > 0 && code !== "0") return code;
  const context = read(value, "context");
  if (typeof context === "object" && context !== null) {
    const inner = read(context, "__code");
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
    if (typeof inner === "bigint") return inner.toString();
  }
  return null;
}

function safeJson(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return null;
  if (value instanceof Error) return null;
  try {
    const json = JSON.stringify(value, (_key, inner: unknown) => typeof inner === "bigint" ? inner.toString() : inner);
    return json === "{}" || json === "null" || json === undefined ? null : json;
  } catch {
    return null;
  }
}

function describeCause(cause: unknown, depth = 0): string | null {
  if (cause == null || depth > 2) return null;
  if (typeof cause === "string") return cause.length > 0 ? cause : null;
  if (cause instanceof Error) {
    const code = readCode(cause);
    const nested = describeCause(read(cause, "cause"), depth + 1);
    return [cause.name, cause.message, code === null ? null : `code ${code}`, nested]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(": ");
  }
  if (typeof cause === "object") {
    const message = readString(cause, "message") ?? readString(cause, "reason");
    const code = readCode(cause);
    const err = read(cause, "err") ?? (typeof read(cause, "data") === "object" && read(cause, "data") !== null
      ? read(read(cause, "data") as object, "err")
      : undefined);
    const parts = [message, code === null ? null : `code ${code}`, err == null ? null : safeJson(err)]
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    if (parts.length > 0) return parts.join("; ");
    return safeJson(cause);
  }
  return String(cause);
}

function thrownType(error: unknown): string {
  if (error instanceof Error) return error.name || error.constructor.name || "Error";
  if (typeof error === "string") return "string";
  if (typeof error === "number") return "number";
  if (typeof error === "bigint") return "bigint";
  if (typeof error === "boolean") return "boolean";
  if (error === undefined) return "undefined";
  if (error === null) return "null";
  if (typeof error === "object") {
    const name = readString(error, "name");
    if (name) return name;
    const constructorName = error.constructor?.name;
    return constructorName && constructorName !== "Object" ? constructorName : "object";
  }
  return typeof error;
}

function failureOf(error: object): LocalSimulationFailure | null {
  const failure = read(error, "failure");
  if (typeof failure !== "object" || failure === null) return null;
  if (!("rpcCode" in failure) || !("dataErr" in failure)) return null;
  return failure as LocalSimulationFailure;
}

function messageOf(error: unknown): string | null {
  if (typeof error === "string") return error.length > 0 ? error : null;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error);
  if (typeof error !== "object" || error === null) return null;
  return readString(error, "message") ?? readString(error, "reason") ?? readString(error, "errorMessage");
}

function rpcDetail(error: object, failure: LocalSimulationFailure | null): {
  readonly rpcCode: number | null;
  readonly instruction: string | null;
  readonly program: string | null;
  readonly errorDetail: string | null;
  readonly logs: readonly string[];
  readonly dataErr: unknown;
} {
  if (failure) {
    const named = failure.customName
      ? `${failure.customName}${failure.customCode === null ? "" : ` (${failure.customCode} / 0x${failure.customCode.toString(16)})`}`
      : null;
    return {
      rpcCode: failure.rpcCode,
      instruction: failure.failedInstruction === null ? null : String(failure.failedInstruction),
      program: failure.program,
      errorDetail: named ?? safeJson(failure.dataErr),
      logs: failure.logs,
      dataErr: failure.dataErr,
    };
  }
  const data = read(error, "data");
  const dataRecord = typeof data === "object" && data !== null ? data : null;
  const dataErr = dataRecord ? read(dataRecord, "err") : read(error, "err");
  const decoded = dataErr == null ? null : decodeInstructionError(dataErr);
  const logs = dataRecord && Array.isArray(read(dataRecord, "logs"))
    ? (read(dataRecord, "logs") as readonly unknown[]).map((line) => String(line))
    : [];
  const named = decoded?.customName
    ? `${decoded.customName}${decoded.customCode === null ? "" : ` (${decoded.customCode} / 0x${decoded.customCode.toString(16)})`}`
    : null;
  const rpcCode = typeof read(error, "code") === "number" ? read(error, "code") as number : null;
  return {
    rpcCode: dataErr == null ? null : rpcCode,
    instruction: decoded?.failedInstruction == null ? null : String(decoded.failedInstruction),
    program: decoded?.program ?? null,
    errorDetail: dataErr == null ? null : named ?? safeJson(dataErr),
    logs,
    dataErr,
  };
}

export function normalizeThrown(error: unknown, development = false): NormalizedThrown {
  const type = thrownType(error);
  const record = typeof error === "object" && error !== null ? error : null;
  const failure = record ? failureOf(record) : null;
  const rpc = record ? rpcDetail(record, failure) : {
    rpcCode: null,
    instruction: null,
    program: null,
    errorDetail: null,
    logs: [],
    dataErr: null,
  };
  const message = messageOf(error);
  const code = record ? readCode(record) : null;
  const cause = record ? describeCause(read(record, "cause")) : null;
  const name = error instanceof Error ? error.name : record ? readString(record, "name") : null;
  const stack = development && error instanceof Error && typeof error.stack === "string" && error.stack.length > 0
    ? error.stack
    : null;
  const objectDetail = message === null && record && !(error instanceof Error) ? safeJson(error) : null;
  const meaningful = Boolean(
    message
    || objectDetail
    || code !== null
    || cause
    || rpc.rpcCode !== null
    || rpc.dataErr != null
    || rpc.errorDetail
    || (name !== null && name !== "Error"),
  );
  return {
    type,
    name,
    message: message ?? objectDetail,
    code,
    cause,
    rpcCode: rpc.rpcCode,
    instruction: rpc.instruction,
    program: rpc.program,
    errorDetail: rpc.errorDetail,
    logs: rpc.logs,
    stack,
    meaningful,
  };
}

function push(lines: string[], label: string, value: string | number | null): void {
  if (value === null || value === "") return;
  lines.push(`${label}: ${value}`);
}

/** Technical drawer text. "Unexpected error" is used only when the thrown value has no readable fields. */
export function formatTechnicalDetails(error: unknown, stage: BuyStage, development = false): string {
  const normalized = normalizeThrown(error, development);
  if (!normalized.meaningful) return "Unexpected error";
  const lines: string[] = [`Stage: ${stage}`, `Type: ${normalized.type}`];
  if (normalized.name && normalized.name !== normalized.type) push(lines, "Name", normalized.name);
  push(lines, "Message", normalized.message);
  if (normalized.rpcCode !== null) push(lines, "RPC code", normalized.rpcCode);
  else push(lines, "Code", normalized.code);
  if (normalized.rpcCode !== null && normalized.code !== null && normalized.code !== normalized.rpcCode) {
    push(lines, "Code", normalized.code);
  }
  push(lines, "Instruction", normalized.instruction);
  push(lines, "Program", normalized.program);
  push(lines, "Error", normalized.errorDetail);
  push(lines, "Cause", normalized.cause);
  if (normalized.logs.length > 0) {
    lines.push("Logs:");
    lines.push(...normalized.logs);
  }
  if (normalized.stack) {
    lines.push("Stack:");
    lines.push(normalized.stack);
  }
  return lines.join("\n");
}
