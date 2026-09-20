/** JSON-safe evidence contract embedded into the one-click reference replay. */
export interface ExecutionView {
  readonly authorizationSource: string;
  readonly signature: string;
  readonly slot: string;
  readonly succeeded: boolean;
  readonly failedInstruction: number | null;
  readonly guardErrorName: string | null;
  readonly equityGuard: "PASSED" | "REJECTED";
  readonly jupiter: "EXECUTED" | "NOT_INVOKED";
  readonly whirlpool: "EXECUTED" | "NOT_INVOKED";
  readonly usdcBefore: string;
  readonly usdcAfter: string;
  readonly usdcDelta: string;
  readonly koxBefore: string;
  readonly koxAfter: string;
  readonly koxDelta: string;
  readonly computeUnits: string;
  readonly transactionBytes: number;
  readonly guardDataUnchanged: boolean;
}

export interface ReferenceState {
  readonly generatedFrom: readonly { readonly name: string; readonly sha256: string }[];
  readonly asset: { readonly name: string; readonly symbol: string; readonly mint: string; readonly decimals: number };
  readonly order: {
    readonly side: "Buy";
    readonly inputAmount: string;
    readonly inputSymbol: "USDC";
    readonly estimatedOutput: string;
    readonly outputSymbol: "KOx";
  };
  readonly marketEvidence: {
    readonly sourceCapture: string;
    readonly sourceSha256: string;
    readonly eventWindowSha256: string;
    readonly preparedAt: string;
    readonly preparedSlot: string;
    readonly activationAt: string;
    readonly postAt: string;
    readonly postSlot: string;
    readonly multiplierHex: string;
    readonly newMultiplierHex: string;
    readonly accountBytesIdenticalAcrossBoundary: boolean;
  };
  readonly routeEvidence: {
    readonly capturedAt: string;
    readonly fixtureSha256: string;
    readonly venue: string;
    readonly pool: string;
    readonly inputRaw: string;
    readonly outputRaw: string;
    readonly commitmentHex: string;
  };
  readonly localExecution: {
    readonly environment: "solana-test-validator";
    readonly executionDidNotOccurOnMainnet: true;
    readonly clock: string;
    readonly guardProgram: string;
    readonly guardBinarySha256: string;
  };
  readonly staleExecution: ExecutionView;
  readonly refreshedExecution: ExecutionView;
  readonly liveDevnetProofUrl: string;
}
