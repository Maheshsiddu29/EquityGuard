import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const APP_URL = new URL("../app/", import.meta.url);

test("the public app exposes exactly the three requested page routes", async () => {
  const rootEntries = await readdir(APP_URL, { withFileTypes: true });
  const nestedRouteNames = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("_"))
    .sort();

  assert.deepEqual(nestedRouteNames, ["demo", "docs"]);
  await Promise.all([
    readFile(new URL("page.tsx", APP_URL), "utf8"),
    readFile(new URL("demo/page.tsx", APP_URL), "utf8"),
    readFile(new URL("docs/page.tsx", APP_URL), "utf8"),
  ]);
});

test("the public demo states its replay boundary", async () => {
  const source = await readFile(new URL("demo/page.tsx", APP_URL), "utf8");

  assert.match(source, /canonical evidence-driven lifecycle/i);
  assert.match(source, /does not connect to a visitor's localhost validator/i);
  assert.match(source, /separate Phantom-signed proof environment/i);
});
