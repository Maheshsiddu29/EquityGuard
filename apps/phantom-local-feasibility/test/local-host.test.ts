import assert from "node:assert/strict";
import { test } from "node:test";

import { isLocalDemoOrigin } from "../server/local-origin.ts";
import { configureLocalCoordinator, coordinatorUrl, fixtureUrl, localCoordinatorOrigin } from "../src/local-host.ts";
import { FeasibilityError } from "../src/feasibility.ts";

test("the local host defaults to same-origin, which is what the proven app uses", () => {
  assert.equal(localCoordinatorOrigin(), "");
  assert.equal(coordinatorUrl("/api/arm"), "/api/arm");
  assert.equal(fixtureUrl("route-fixture.json"), "./route-fixture.json");
});

test("a loopback coordinator can be configured; anything remote is refused", () => {
  for (const remote of [
    "https://equityguard.example",
    "http://equityguard.example",
    "http://127.0.0.1.attacker.example:4175",
    "https://127.0.0.1:4175",
    "http://10.0.0.5:4175",
    "not a url",
  ]) {
    assert.throws(() => configureLocalCoordinator(remote), FeasibilityError, remote);
  }
  // The refusals above must not have left a configured origin behind.
  assert.equal(localCoordinatorOrigin(), "");

  configureLocalCoordinator("http://127.0.0.1:4175");
  assert.equal(coordinatorUrl("/api/arm"), "http://127.0.0.1:4175/api/arm");
  assert.equal(fixtureUrl("sealed-authorizations.json"), "http://127.0.0.1:4175/sealed-authorizations.json");
});

test("the coordinator admits loopback demo origins only", () => {
  for (const allowed of [
    "http://127.0.0.1:4175",
    "http://localhost:4175",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
  ]) {
    assert.equal(isLocalDemoOrigin(allowed), true, allowed);
  }
  for (const refused of [
    undefined,
    "null",
    "",
    "https://equityguard.example",
    "https://localhost:3000",
    "http://equityguard.example:3000",
    "http://127.0.0.1.attacker.example:3000",
    "http://127.0.0.1:8899",
    "http://127.0.0.1",
    "http://192.168.1.10:3000",
  ]) {
    assert.equal(isLocalDemoOrigin(refused), false, String(refused));
  }
});
