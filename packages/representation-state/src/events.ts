/**
 * Read-only change detection over decoded observations. Produces events; it
 * has no output channel of its own (INV-CAP-01).
 */

import { bytesEqual } from "@equityguard/guard-client";

import type { CaptureObservation, CaptureRecord } from "./capture.ts";
import { StateSource, type ResolvedRepresentationState } from "./types.ts";

export type ObservationEventType =
  | "SCALED_UI_STATE_CHANGED"
  | "ACTIVATION_PHASE_CHANGED"
  | "PAUSE_STATE_CHANGED"
  | "STATE_SOURCE_CONFLICT"
  | "DECODE_ERROR";

export interface ObservationEvent {
  readonly type: ObservationEventType;
  readonly issuer: string | null;
  readonly symbol: string | null;
  readonly mint: string | null;
  readonly slot: bigint | null;
  readonly blockTime: bigint | null;
  readonly wallclock: string | null;
  readonly previous: CaptureObservation | ResolvedRepresentationState | null;
  readonly current: CaptureRecord | ResolvedRepresentationState;
  /** Which fields changed, or the decode error. */
  readonly detail: readonly string[];
}

/**
 * Streaming detector keyed by mint. Emits DECODE_ERROR when an error first
 * appears or its code changes (not on every repeated failing poll), and
 * compares each decoded observation with the previous decoded one.
 */
export class ObservationEventDetector {
  private readonly lastDecoded = new Map<string, CaptureObservation>();
  private readonly lastErrorCode = new Map<string, string>();

  push(record: CaptureRecord): ObservationEvent[] {
    if (record.kind === "line-error") {
      return [
        {
          type: "DECODE_ERROR",
          issuer: null,
          symbol: null,
          mint: null,
          slot: null,
          blockTime: null,
          wallclock: null,
          previous: null,
          current: record,
          detail: [`line ${record.lineNumber}: ${record.code}`],
        },
      ];
    }
    const context = {
      issuer: record.issuer,
      symbol: record.symbol,
      mint: record.mint,
      slot: record.slot,
      blockTime: record.blockTime,
      wallclock: record.wallclock,
      current: record,
    };
    const previous = this.lastDecoded.get(record.mint) ?? null;
    const evidence = record.evidence;

    if (evidence.kind === "decode-error") {
      if (this.lastErrorCode.get(record.mint) === evidence.code) return [];
      this.lastErrorCode.set(record.mint, evidence.code);
      return [{ ...context, type: "DECODE_ERROR", previous, detail: [`${evidence.code}: ${evidence.message}`] }];
    }
    this.lastErrorCode.delete(record.mint);
    this.lastDecoded.set(record.mint, record);
    if (!previous || previous.evidence.kind !== "decoded") return [];

    const before = previous.evidence;
    const events: ObservationEvent[] = [];
    const changed: string[] = [];
    if (!bytesEqual(before.protectedState.multiplier, evidence.protectedState.multiplier)) changed.push("multiplier");
    if (!bytesEqual(before.protectedState.newMultiplier, evidence.protectedState.newMultiplier)) changed.push("newMultiplier");
    if (before.protectedState.newMultiplierEffectiveTimestamp !== evidence.protectedState.newMultiplierEffectiveTimestamp) {
      changed.push("newMultiplierEffectiveTimestamp");
    }
    if (changed.length > 0) events.push({ ...context, type: "SCALED_UI_STATE_CHANGED", previous, detail: changed });
    if (before.phase !== null && evidence.phase !== null && before.phase !== evidence.phase) {
      events.push({ ...context, type: "ACTIVATION_PHASE_CHANGED", previous, detail: [`phase ${before.phase} -> ${evidence.phase}`] });
    }
    if (before.paused !== evidence.paused) {
      events.push({ ...context, type: "PAUSE_STATE_CHANGED", previous, detail: [`paused ${before.paused} -> ${evidence.paused}`] });
    }
    return events;
  }
}

/** Emits STATE_SOURCE_CONFLICT when a representation's resolved state enters conflict. */
export class ConflictEventDetector {
  private readonly last = new Map<string, ResolvedRepresentationState>();

  push(resolved: ResolvedRepresentationState): ObservationEvent[] {
    const previous = this.last.get(resolved.mint) ?? null;
    this.last.set(resolved.mint, resolved);
    const entered = resolved.stateSource === StateSource.CONFLICT && previous?.stateSource !== StateSource.CONFLICT;
    if (!entered) return [];
    return [
      {
        type: "STATE_SOURCE_CONFLICT",
        issuer: resolved.issuer,
        symbol: resolved.symbol,
        mint: resolved.mint,
        slot: resolved.slot,
        blockTime: resolved.blockTime,
        wallclock: resolved.observedAt,
        previous,
        current: resolved,
        detail: [`chain ${resolved.chainState} vs api ${resolved.apiState}`],
      },
    ];
  }
}
