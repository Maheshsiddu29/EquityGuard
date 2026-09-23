import { EQUITY_GUARD_DEVNET_PROGRAM_ID, equityGuardErrorName } from "../../../packages/guard-client/src/index.ts";

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const EQUITY_GUARD = EQUITY_GUARD_DEVNET_PROGRAM_ID;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

/** Published Jupiter v6 IDL custom errors we actually observe. */
const JUPITER_CUSTOM_ERRORS: Readonly<Record<number, string>> = {
  6001: "SlippageToleranceExceeded",
  6008: "NotEnoughAccountKeys",
  6014: "IncorrectTokenProgramID",
  6017: "ExactOutAmountNotMatched",
  6024: "InsufficientFunds",
  6025: "InvalidTokenAccount",
};

export type FailureStage = "simulation" | "sendRawTransaction" | "confirmation";

export interface LocalSimulationFailure {
  readonly stage: FailureStage;
  readonly rpcCode: number | null;
  readonly rpcMessage: string | null;
  readonly dataErr: unknown;
  readonly failedInstruction: number | null;
  readonly customCode: number | null;
  readonly customName: string | null;
  readonly program: string | null;
  readonly logs: readonly string[];
  readonly unitsConsumed: string | null;
  readonly replacementBlockhash: unknown;
}

export class ReplaySimulationError extends Error {
  readonly failure: LocalSimulationFailure;

  constructor(failure: LocalSimulationFailure) {
    super(formatFailureHeadline(failure));
    this.name = "ReplaySimulationError";
    this.failure = failure;
  }
}

export function formatFailureHeadline(failure: LocalSimulationFailure, kind = "SAFE"): string {
  const instruction = failure.failedInstruction === null ? "unknown" : String(failure.failedInstruction);
  const program = failure.program ?? "unknown";
  const error = failure.customName
    ? `${failure.customName}${failure.customCode === null ? "" : ` (${failure.customCode} / 0x${failure.customCode.toString(16)})`}`
    : failure.customCode === null
      ? JSON.stringify(failure.dataErr)
      : `custom ${failure.customCode}`;
  return `${kind} failed during local ${failure.stage}\nInstruction: ${instruction}\nProgram: ${program}\nError: ${error}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function instructionError(value: unknown): { instruction: number | null; inner: unknown } {
  const record = asRecord(value);
  const detail = record && "InstructionError" in record ? record.InstructionError : undefined;
  if (!Array.isArray(detail) || detail.length < 2) return { instruction: null, inner: value };
  return { instruction: Number(detail[0]), inner: detail[1] };
}

function customCode(inner: unknown): number | null {
  if (typeof inner === "number" && Number.isInteger(inner)) return inner;
  const record = asRecord(inner);
  if (!record || !("Custom" in record)) return null;
  const code = record.Custom;
  if (typeof code === "bigint") return Number(code);
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return null;
}

function customName(program: string | null, code: number | null): string | null {
  if (code === null) return null;
  if (program === JUPITER_V6) return JUPITER_CUSTOM_ERRORS[code] ?? `Jupiter custom ${code}`;
  if (program === EQUITY_GUARD) return equityGuardErrorName(code) ?? `EquityGuard custom ${code}`;
  return null;
}

function logsFrom(value: unknown): readonly string[] {
  const record = asRecord(value);
  const logs = record?.logs;
  return Array.isArray(logs) ? logs.map((line) => String(line)) : [];
}

export function decodeInstructionError(
  dataErr: unknown,
  programs: readonly string[] = [],
): Pick<LocalSimulationFailure, "failedInstruction" | "customCode" | "customName" | "program"> {
  const { instruction, inner } = instructionError(dataErr);
  const code = customCode(inner);
  const program = instruction === null ? null : programs[instruction] ?? null;
  return {
    failedInstruction: instruction,
    customCode: code,
    customName: customName(program, code),
    program,
  };
}

function rpcPayload(error: unknown): { code: number | null; message: string | null; data: Record<string, unknown> | null; causeErr: unknown } {
  const record = asRecord(error);
  if (!record) return { code: null, message: error instanceof Error ? error.message : String(error), data: null, causeErr: null };
  const context = asRecord(record.context);
  if (typeof record.code === "number" || typeof context?.__code === "number") {
    const data = context ?? asRecord(record.data);
    const cause = asRecord(record.cause);
    return {
      code: typeof record.code === "number" ? record.code : Number(context?.__code ?? null),
      message: typeof record.message === "string" ? record.message : null,
      data,
      causeErr: cause?.context ?? record.cause ?? data?.err ?? null,
    };
  }
  const data = asRecord(record.data);
  return {
    code: typeof record.code === "number" ? record.code : null,
    message: typeof record.message === "string" ? record.message : null,
    data,
    causeErr: data?.err ?? null,
  };
}

export function decodeLocalRpcFailure(
  error: unknown,
  stage: FailureStage,
  programs: readonly string[] = [],
): LocalSimulationFailure {
  const payload = rpcPayload(error);
  const dataErr = payload.data?.err ?? payload.causeErr ?? null;
  const decoded = decodeInstructionError(dataErr, programs);
  const data = payload.data;
  return {
    stage,
    rpcCode: payload.code,
    rpcMessage: payload.message,
    dataErr,
    ...decoded,
    logs: logsFrom(data),
    unitsConsumed: data?.unitsConsumed === undefined || data.unitsConsumed === null ? null : String(data.unitsConsumed),
    replacementBlockhash: data?.replacementBlockhash ?? null,
  };
}

export function invoked(logs: readonly string[], program: string): boolean {
  return logs.some((line) => line.startsWith(`Program ${program} invoke [`));
}

export function programRole(program: string | null): "EquityGuard" | "ATA" | "Jupiter" | "Whirlpool" | "other" | "unknown" {
  if (program === null) return "unknown";
  if (program === EQUITY_GUARD) return "EquityGuard";
  if (program === ATA_PROGRAM) return "ATA";
  if (program === JUPITER_V6) return "Jupiter";
  if (program === WHIRLPOOL) return "Whirlpool";
  return "other";
}
