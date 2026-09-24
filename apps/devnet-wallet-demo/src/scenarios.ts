/**
 * The only corporate-action templates the devnet demo may run.
 * Multipliers are exact binary64 values. Nothing here is a market price,
 * a real security, or a shared mint.
 */

export const DEMO_ASSET_DISCLAIMER =
  "Devnet demonstration asset. Not a real security and has no market value.";

export interface EquityScenario {
  readonly id: "KO-DEMO" | "UNH-DEMO" | "CRM-DEMO";
  readonly symbol: "KO-DEMO" | "UNH-DEMO" | "CRM-DEMO";
  readonly displayName: string;
  readonly eventLabel: string;
  readonly initialMultiplier: 1;
  readonly newMultiplier: 2 | 1.5 | 0.5;
}

export const SCENARIO_CATALOG: readonly EquityScenario[] = Object.freeze([
  Object.freeze({
    id: "KO-DEMO",
    symbol: "KO-DEMO",
    displayName: "Coca-Cola Demo Equity",
    eventLabel: "2-for-1 stock split",
    initialMultiplier: 1,
    newMultiplier: 2,
  }),
  Object.freeze({
    id: "UNH-DEMO",
    symbol: "UNH-DEMO",
    displayName: "UnitedHealth Demo Equity",
    eventLabel: "3-for-2 stock split",
    initialMultiplier: 1,
    newMultiplier: 1.5,
  }),
  Object.freeze({
    id: "CRM-DEMO",
    symbol: "CRM-DEMO",
    displayName: "Salesforce Demo Equity",
    eventLabel: "1-for-2 reverse split",
    initialMultiplier: 1,
    newMultiplier: 0.5,
  }),
]);

const APPROVED_MULTIPLIERS: readonly number[] = [1, 1.5, 2, 0.5];

export function isApprovedMultiplier(value: number): boolean {
  return APPROVED_MULTIPLIERS.some((approved) => Object.is(approved, value));
}

/** Little-endian binary64 bytes, the representation EquityGuard compares. */
export function storedMultiplier(value: number): Uint8Array {
  if (!isApprovedMultiplier(value)) throw new Error("Multiplier is not in the approved scenario catalog");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
}

export function formatMultiplier(value: number): string {
  if (!isApprovedMultiplier(value)) throw new Error("Multiplier is not in the approved scenario catalog");
  return `${value.toFixed(2)}×`;
}

export function validateScenarioCatalog(catalog: readonly EquityScenario[] = SCENARIO_CATALOG): void {
  if (catalog.length !== 3) throw new Error("Scenario catalog must contain exactly three templates");
  const ids = new Set(catalog.map((scenario) => scenario.id));
  if (ids.size !== catalog.length) throw new Error("Scenario ids must be unique");
  for (const scenario of catalog) {
    if (scenario.symbol !== scenario.id) throw new Error("Scenario symbol must match its id");
    if (scenario.initialMultiplier !== 1) throw new Error("Every demo scenario starts at 1.00×");
    if (!isApprovedMultiplier(scenario.newMultiplier) || Object.is(scenario.newMultiplier, scenario.initialMultiplier)) {
      throw new Error("Scheduled multiplier must be an approved change");
    }
    if (storedMultiplier(scenario.initialMultiplier).length !== 8 || storedMultiplier(scenario.newMultiplier).length !== 8) {
      throw new Error("Stored multipliers must be 8 bytes");
    }
  }
}

validateScenarioCatalog();

export function scenarioById(id: string): EquityScenario {
  const scenario = SCENARIO_CATALOG.find((item) => item.id === id);
  if (!scenario) throw new Error("Unknown scenario");
  return scenario;
}

/**
 * Picks one template. `random` must return a number in `[0, 1)`, as
 * `Math.random` does. Values outside that range are refused rather than
 * wrapped into some other multiplier.
 */
export function randomScenario(random: () => number = Math.random): EquityScenario {
  const sample = random();
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("Random selection left the approved scenario catalog");
  }
  const index = Math.floor(sample * SCENARIO_CATALOG.length);
  const scenario = SCENARIO_CATALOG[index];
  if (!scenario) throw new Error("Random selection left the approved scenario catalog");
  return scenario;
}

export interface ActiveAttempt {
  readonly scenario: EquityScenario;
  readonly status: "ACTIVE";
}

export function startAttempt(scenario: EquityScenario): ActiveAttempt {
  return Object.freeze({ scenario: scenarioById(scenario.id), status: "ACTIVE" as const });
}

export function scenarioForAttempt(attempt: ActiveAttempt, requestedId: string): EquityScenario {
  if (attempt.status !== "ACTIVE" || requestedId !== attempt.scenario.id) {
    throw new Error("Scenario cannot change during an active attempt");
  }
  return attempt.scenario;
}
