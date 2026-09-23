"use client";

/**
 * The React binding for the local live-Phantom demo.
 *
 * It owns no protocol logic. The state rules and the invariant checks are in
 * `@/lib/live-demo`; the execution — arming, authorization construction, the
 * protected Jupiter build, the Phantom signature, local submission and
 * confirmation — is the proven implementation in
 * apps/phantom-local-feasibility, loaded here as a bundled adapter.
 *
 * The adapter is fetched with a runtime dynamic import that the Next bundler
 * is told to leave alone, so the public build neither contains it nor knows
 * the path exists. It is requested only after `liveDemoAvailable` has already
 * said yes.
 */

import {
  IDLE_LIVE_STATE,
  LIVE_ADAPTER_MODULE,
  LIVE_COORDINATOR_ORIGIN,
  LIVE_DEMO_ENV_VAR,
  assertStaleInvariants,
  assertUpdatedInvariants,
  beginStale,
  beginUpdated,
  liveDemoAvailable,
  livePanels,
  withFailure,
  withReview,
  withStageMessage,
  withStaleResult,
  withUpdatedResult,
  type LiveAdapter,
  type LivePanels,
  type LiveState,
} from "@/lib/live-demo";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";

// Read as a literal so Next inlines the build-time value into the bundle.
const FLAG = process.env.NEXT_PUBLIC_EQUITYGUARD_LIVE_DEMO;

let adapterPromise: Promise<LiveAdapter> | null = null;

async function loadAdapter(): Promise<LiveAdapter> {
  if (adapterPromise === null) {
    adapterPromise = (async () => {
      const loaded = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        LIVE_ADAPTER_MODULE
      )) as LiveAdapter;
      loaded.configureLiveDemo(LIVE_COORDINATOR_ORIGIN);
      return loaded;
    })().catch((error: unknown) => {
      adapterPromise = null;
      throw new Error(
        "The local live-demo adapter could not be loaded. Run `npm run live-demo:build` from the repository root.",
        { cause: error }
      );
    });
  }
  return adapterPromise;
}

const subscribeToNothing = (): (() => void) => () => {};

function readAvailability(): boolean {
  return liveDemoAvailable({
    flag: FLAG,
    hostname: window.location.hostname,
    protocol: window.location.protocol,
  });
}

export interface LiveDemoController {
  /** Whether this page may offer the live mode at all. */
  readonly available: boolean;
  readonly state: LiveState;
  readonly panels: LivePanels;
  readonly buy: () => void;
  readonly review: () => void;
  readonly confirm: () => void;
  readonly reset: () => void;
}

export function useLiveDemo(): LiveDemoController {
  // The loopback half of the gate is a runtime fact that the server render
  // cannot know, so it is read as an external value: false on the server and
  // on the first client render, then its real value. It never changes after
  // that, so the subscription is a no-op.
  const available = useSyncExternalStore(subscribeToNothing, readAvailability, () => false);
  const [state, setState] = useState<LiveState>(IDLE_LIVE_STATE);
  const running = useRef(false);

  const run = useCallback(
    async (leg: "STALE" | "REFRESHED"): Promise<void> => {
      if (running.current) return;
      running.current = true;
      let adapter: LiveAdapter | null = null;
      try {
        adapter = await loadAdapter();
        const onStage = (update: { message: string }): void => {
          setState((current) => withStageMessage(current, update.message));
        };
        if (leg === "STALE") {
          const result = await adapter.startStaleAttempt(onStage);
          // Verified here, before any state moves: an updater that threw
          // would crash the tree instead of showing an honest failure.
          assertStaleInvariants(result);
          setState((current) => withStaleResult(current, result));
        } else {
          const result = await adapter.confirmUpdatedOrder(onStage);
          assertUpdatedInvariants(result);
          setState((current) => withUpdatedResult(current, result));
        }
      } catch (error) {
        // No silent fallback: a failed live run is shown as a failed live run.
        const failure = adapter
          ? adapter.describeLiveFailure(leg === "STALE" ? "buy" : "confirm", error)
          : {
              headline: "The local live demo could not start.",
              technical: error instanceof Error ? error.message : String(error),
              stage: "ENVIRONMENT_CHECK",
              cancelled: false,
              walletRequested: false,
              submitted: false,
            };
        setState((current) => withFailure(current, leg, failure));
      } finally {
        running.current = false;
      }
    },
    []
  );

  const buy = useCallback((): void => {
    setState(beginStale());
    void run("STALE");
  }, [run]);

  const review = useCallback((): void => {
    setState((current) => withReview(current));
  }, []);

  // Only ever called from the trader's own click on the updated order, and
  // only from the reviewing state, so nothing here can pre-authorize it.
  const confirm = useCallback((): void => {
    if (state.kind !== "REVIEWING") return;
    setState(beginUpdated(state));
    void run("REFRESHED");
  }, [state, run]);

  const reset = useCallback((): void => {
    if (running.current) return;
    setState(IDLE_LIVE_STATE);
    void loadAdapter()
      .then((adapter) => {
        adapter.resetLiveSession();
      })
      .catch(() => {
        /* Nothing to reset if the adapter never loaded. */
      });
  }, []);

  const panels = useMemo(() => livePanels(state), [state]);

  return { available, state, panels, buy, review, confirm, reset };
}

export { LIVE_DEMO_ENV_VAR };
