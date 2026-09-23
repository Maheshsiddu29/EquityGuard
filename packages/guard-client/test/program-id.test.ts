import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { EQUITY_GUARD_DEVNET_PROGRAM_ID } from "../src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APPROVED_DEVNET_PROGRAM_ID = "EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT";

test("pinned TypeScript program ID is the approved devnet deployment", () => {
  assert.equal(EQUITY_GUARD_DEVNET_PROGRAM_ID, APPROVED_DEVNET_PROGRAM_ID);
});

test("Rust declare_id! matches the pinned ID", () => {
  const lib = readFileSync(join(ROOT, "programs/equity_guard/src/lib.rs"), "utf8");
  const declared = [...lib.matchAll(/declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(declared, [EQUITY_GUARD_DEVNET_PROGRAM_ID]);
});

test("devnet deployment record matches the pinned ID", () => {
  const state = JSON.parse(readFileSync(join(ROOT, "scripts/devnet/devnet.json"), "utf8")) as {
    deployment: { programId: string } | null;
  };
  assert.equal(state.deployment?.programId, EQUITY_GUARD_DEVNET_PROGRAM_ID);
});

test("no other source file hardcodes the program ID", () => {
  const allowed = new Set([
    "packages/guard-client/src/program-id.ts",
    "packages/guard-client/test/program-id.test.ts",
    "programs/equity_guard/src/lib.rs",
    // Pre-existing spellings under `apps`, which this scan did not reach until
    // the coordinator's attestation module was caught duplicating the ID.
    // Listed rather than silently skipped so what is left is visible; none is
    // a new spelling, and nothing may be added to this list.
    "apps/phantom-local-feasibility/src/rpc-failure.ts",
    "apps/phantom-local-feasibility/test/buy-error.test.ts",
    "apps/phantom-local-feasibility/test/local-preparation.test.ts",
    "apps/phantom-local-feasibility/test/replay-model.test.ts",
    "apps/phantom-local-feasibility/test/rpc-failure.test.ts",
  ]);
  // `apps` is scanned too: the coordinator in `apps/phantom-local-feasibility`
  // decides which program a signed message must invoke, so a second copy of
  // the ID there is exactly as dangerous as one under `packages`.
  const scanned = ["packages", "scripts", "programs", "apps"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === "node_modules" || name === "target" || name === "fixtures" || name === "dist") continue;
      const rel = join(dir, name);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|mjs|rs)$/.test(name) && !allowed.has(rel) && readFileSync(join(ROOT, rel), "utf8").includes(APPROVED_DEVNET_PROGRAM_ID)) {
        offenders.push(rel);
      }
    }
  };
  scanned.forEach(walk);
  assert.deepEqual(offenders, []);
});
