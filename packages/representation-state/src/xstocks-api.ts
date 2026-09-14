/**
 * xStocks public API observations (read-only evidence).
 *
 * Decodes the API watcher's JSONL: `{ wallclock, response }` or
 * `{ wallclock, error }`. The response of
 * `GET api.xstocks.fi/api/v2/public/assets/<symbol>/multiplier` has
 * `currentMultiplier`, `newMultiplier`, `activationDateTime` and `reason`.
 * `newMultiplier = 0`, `activationDateTime = 0` and `reason = null` is a valid
 * "no pending update" state, not malformed data.
 *
 * Pure and deterministic: no network, no clock, no file access. The raw line
 * is preserved on every observation as evidence.
 */

/** Where a piece of timing or multiplier evidence came from. */
export type EvidenceSource = "DOCUMENTED_SCHEDULE" | "HISTORICAL_API_STATE" | "LIVE_API_STATE" | "LIVE_CHAIN_STATE";

export interface EvidenceAuthority {
  /**
   * Whether the on-chain guard can enforce it atomically. Only live mint state
   * qualifies: the program reads the mint, not any API or document.
   */
  readonly authoritativeForOnchainGuard: boolean;
  /**
   * Whether off-chain execution policy (preflight, transition avoidance) may
   * act on it. Live issuer API signals qualify even though the guard cannot
   * enforce them. Historical records and documentation are calibration and
   * context only, never live execution authority.
   */
  readonly relevantToExecutionPolicy: boolean;
}

export const EVIDENCE_AUTHORITY: Readonly<Record<EvidenceSource, EvidenceAuthority>> = {
  LIVE_CHAIN_STATE: { authoritativeForOnchainGuard: true, relevantToExecutionPolicy: true },
  LIVE_API_STATE: { authoritativeForOnchainGuard: false, relevantToExecutionPolicy: true },
  HISTORICAL_API_STATE: { authoritativeForOnchainGuard: false, relevantToExecutionPolicy: false },
  DOCUMENTED_SCHEDULE: { authoritativeForOnchainGuard: false, relevantToExecutionPolicy: false },
};

export function authoritativeForOnchainGuard(source: EvidenceSource): boolean {
  return EVIDENCE_AUTHORITY[source].authoritativeForOnchainGuard;
}

export function relevantToExecutionPolicy(source: EvidenceSource): boolean {
  return EVIDENCE_AUTHORITY[source].relevantToExecutionPolicy;
}

/** How a raw `activationDateTime` value was turned into a time. */
export type ActivationTimeInterpretation = "none" | "iso-8601" | "unix-seconds" | "unix-milliseconds";

export interface ActivationTime {
  readonly interpretation: ActivationTimeInterpretation;
  /** Null when there is no activation time (raw value 0 or null). */
  readonly unixMs: number | null;
}

export type ApiDecodeStatus = "ok" | "request-error" | "malformed";

export interface XStocksApiObservation {
  readonly source: "LIVE_API_STATE";
  readonly lineNumber: number;
  readonly wallclock: string | null;
  readonly wallclockMs: number | null;
  readonly decodeStatus: ApiDecodeStatus;
  readonly currentMultiplier: number | null;
  readonly newMultiplier: number | null;
  /** Exactly as present in the response. */
  readonly activationDateTimeRaw: unknown;
  readonly activationTime: ActivationTime | null;
  readonly reason: string | null;
  /** True when the response advertises a pending update; null unless decoded. */
  readonly hasPendingUpdate: boolean | null;
  readonly error: string | null;
  readonly rawLine: string;
}

/** Historical API record (e.g. the multiplier history of an asset). */
export interface XStocksHistoricalRecord {
  readonly source: "HISTORICAL_API_STATE";
  readonly previousMultiplier: number;
  readonly multiplier: number;
  readonly activationTime: ActivationTime;
  readonly reason: string | null;
}

export class XStocksApiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XStocksApiParseError";
  }
}

/**
 * Numbers at or above this are taken as milliseconds: as seconds they would
 * be past year 5000. Below it, positive numbers are seconds. The chosen
 * interpretation is always reported, never hidden.
 */
const MILLISECONDS_THRESHOLD = 100_000_000_000;

/** Interprets an `activationDateTime` value; throws on anything unrecognized. */
export function interpretActivationTime(raw: unknown): ActivationTime {
  if (raw === 0 || raw === null) return { interpretation: "none", unixMs: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw >= MILLISECONDS_THRESHOLD
      ? { interpretation: "unix-milliseconds", unixMs: raw }
      : { interpretation: "unix-seconds", unixMs: raw * 1000 };
  }
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return { interpretation: "iso-8601", unixMs: ms };
  }
  throw new XStocksApiParseError(`unrecognized activationDateTime ${JSON.stringify(raw)}`);
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Decodes one watcher line. Never throws on bad input. */
export function decodeXStocksApiLine(line: string, lineNumber: number): XStocksApiObservation | null {
  if (line.trim() === "") return null;
  const base = {
    source: "LIVE_API_STATE" as const,
    lineNumber,
    currentMultiplier: null,
    newMultiplier: null,
    activationDateTimeRaw: null,
    activationTime: null,
    reason: null,
    hasPendingUpdate: null,
    rawLine: line,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ...base, wallclock: null, wallclockMs: null, decodeStatus: "malformed", error: "line is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...base, wallclock: null, wallclockMs: null, decodeStatus: "malformed", error: "line is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const wallclock = typeof record.wallclock === "string" ? record.wallclock : null;
  const parsedMs = wallclock === null ? Number.NaN : Date.parse(wallclock);
  const wallclockMs = Number.isNaN(parsedMs) ? null : parsedMs;
  const context = { ...base, wallclock, wallclockMs };
  if (wallclockMs === null) return { ...context, decodeStatus: "malformed", error: "missing or invalid wallclock" };

  if (typeof record.error === "string") return { ...context, decodeStatus: "request-error", error: record.error };

  const response = record.response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return { ...context, decodeStatus: "malformed", error: "response is not a JSON object" };
  }
  const r = response as Record<string, unknown>;
  if (!positiveFinite(r.currentMultiplier)) {
    return { ...context, decodeStatus: "malformed", error: "currentMultiplier must be a positive finite number" };
  }
  if (!(r.newMultiplier === 0 || positiveFinite(r.newMultiplier))) {
    return { ...context, decodeStatus: "malformed", error: "newMultiplier must be 0 or a positive finite number" };
  }
  if (!(r.reason === null || typeof r.reason === "string")) {
    return { ...context, decodeStatus: "malformed", error: "reason must be a string or null" };
  }
  let activationTime: ActivationTime;
  try {
    activationTime = interpretActivationTime(r.activationDateTime);
  } catch (error) {
    return { ...context, decodeStatus: "malformed", error: (error as Error).message, activationDateTimeRaw: r.activationDateTime };
  }
  return {
    ...context,
    decodeStatus: "ok",
    currentMultiplier: r.currentMultiplier,
    newMultiplier: r.newMultiplier,
    activationDateTimeRaw: r.activationDateTime,
    activationTime,
    reason: r.reason,
    hasPendingUpdate: r.newMultiplier > 0 || activationTime.unixMs !== null,
    error: null,
  };
}

/** Parses a historical multiplier record; throws on malformed input. */
export function parseXStocksHistoricalRecord(value: unknown): XStocksHistoricalRecord {
  if (typeof value !== "object" || value === null) throw new XStocksApiParseError("historical record must be an object");
  const r = value as Record<string, unknown>;
  if (!positiveFinite(r.previousMultiplier) || !positiveFinite(r.multiplier)) {
    throw new XStocksApiParseError("historical multipliers must be positive finite numbers");
  }
  if (!(r.reason === null || r.reason === undefined || typeof r.reason === "string")) {
    throw new XStocksApiParseError("reason must be a string or null");
  }
  const activationTime = interpretActivationTime(r.activationDateTime);
  if (activationTime.unixMs === null) throw new XStocksApiParseError("historical record needs an activation time");
  return {
    source: "HISTORICAL_API_STATE",
    previousMultiplier: r.previousMultiplier,
    multiplier: r.multiplier,
    activationTime,
    reason: typeof r.reason === "string" ? r.reason : null,
  };
}

/** Little-endian f64 bytes, for exact comparison with on-chain stored multipliers. */
export function f64Hex(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return Buffer.from(bytes).toString("hex");
}

export type ApiEventType =
  | "API_PENDING_UPDATE_PUBLISHED"
  | "API_PENDING_UPDATE_CHANGED"
  | "API_PENDING_UPDATE_CLEARED"
  | "API_CURRENT_MULTIPLIER_CHANGED"
  | "API_ACTIVATION_TIME_CHANGED"
  | "API_REASON_CHANGED"
  | "API_REQUEST_ERROR"
  | "API_MALFORMED_RECORD";

export interface ApiEvent {
  readonly type: ApiEventType;
  readonly wallclock: string | null;
  readonly lineNumber: number;
  /** Previous successfully decoded observation, if any. */
  readonly previous: XStocksApiObservation | null;
  readonly current: XStocksApiObservation;
  readonly detail: readonly string[];
}

/**
 * Streaming API change detector. Consecutive errors of the same kind emit one
 * event; changes are always relative to the previous successful observation.
 */
export class XStocksApiEventDetector {
  private lastOk: XStocksApiObservation | null = null;
  private lastErrorKey: string | null = null;

  push(observation: XStocksApiObservation): ApiEvent[] {
    const event = (type: ApiEventType, detail: string[]): ApiEvent => ({
      type,
      wallclock: observation.wallclock,
      lineNumber: observation.lineNumber,
      previous: this.lastOk,
      current: observation,
      detail,
    });
    if (observation.decodeStatus !== "ok") {
      const key = `${observation.decodeStatus}:${observation.error}`;
      if (key === this.lastErrorKey) return [];
      this.lastErrorKey = key;
      return [event(observation.decodeStatus === "request-error" ? "API_REQUEST_ERROR" : "API_MALFORMED_RECORD", [observation.error ?? ""])];
    }
    this.lastErrorKey = null;
    const previous = this.lastOk;
    const events: ApiEvent[] = [];
    if (previous) {
      if (previous.currentMultiplier !== observation.currentMultiplier) {
        events.push(event("API_CURRENT_MULTIPLIER_CHANGED", [`${previous.currentMultiplier} -> ${observation.currentMultiplier}`]));
      }
      const wasPending = previous.hasPendingUpdate === true;
      const isPending = observation.hasPendingUpdate === true;
      if (!wasPending && isPending) {
        events.push(event("API_PENDING_UPDATE_PUBLISHED", [`newMultiplier ${observation.newMultiplier}`, `activationDateTime ${JSON.stringify(observation.activationDateTimeRaw)}`]));
      } else if (wasPending && !isPending) {
        events.push(event("API_PENDING_UPDATE_CLEARED", [`newMultiplier ${previous.newMultiplier} -> ${observation.newMultiplier}`]));
      } else if (wasPending && isPending) {
        if (previous.newMultiplier !== observation.newMultiplier) {
          events.push(event("API_PENDING_UPDATE_CHANGED", [`newMultiplier ${previous.newMultiplier} -> ${observation.newMultiplier}`]));
        }
        if (JSON.stringify(previous.activationDateTimeRaw) !== JSON.stringify(observation.activationDateTimeRaw)) {
          events.push(event("API_ACTIVATION_TIME_CHANGED", [`${JSON.stringify(previous.activationDateTimeRaw)} -> ${JSON.stringify(observation.activationDateTimeRaw)}`]));
        }
      }
      if (previous.reason !== observation.reason && wasPending === isPending) {
        events.push(event("API_REASON_CHANGED", [`${JSON.stringify(previous.reason)} -> ${JSON.stringify(observation.reason)}`]));
      }
    }
    this.lastOk = observation;
    return events;
  }
}
