import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const APP_URL = new URL("../app/", import.meta.url);
const COMPONENT_URL = new URL("../components/", import.meta.url);

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
  const pageSource = await readFile(new URL("demo/page.tsx", APP_URL), "utf8");
  const componentSource = await readFile(
    new URL("demo/demo-experience.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.match(componentSource, /canonical evidence-driven lifecycle/i);
  assert.match(componentSource, /does not connect to a\s+visitor.*localhost validator/i);
  assert.match(componentSource, /separate Phantom-signed\s+proof environment/i);
  assert.match(pageSource, /reference\/data\/kox-trade-replay\.json/);
  assert.match(pageSource, /ActivationPhaseChanged/);
  assert.match(pageSource, /0\.05504261/);
  assert.doesNotMatch(componentSource, /fetch\(|sendTransaction|signTransaction/);
});

test("the landing page keeps the approved six-section narrative", async () => {
  const pageSource = await readFile(new URL("page.tsx", APP_URL), "utf8");
  const landingSource = await readFile(
    new URL("landing/landing-page.tsx", COMPONENT_URL),
    "utf8"
  );
  const heroSource = await readFile(
    new URL("landing/scroll-expand-hero.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.match(pageSource, /<LandingPage\s*\/>/);
  assert.match(heroSource, /The trade you approved/);
  assert.match(heroSource, /should be the trade that executes/);
  assert.match(heroSource, /<ScrollExpand/);
  assert.match(heroSource, /No protected action executed/);

  for (const section of [
    "invisible-section",
    "principles-section",
    "proof-section",
    "stack-section",
    "final-cta-section",
  ]) {
    assert.match(landingSource, new RegExp(section));
  }
});

test("landing proof values and environment boundary remain exact", async () => {
  const source = await readFile(
    new URL("landing/landing-page.tsx", COMPONENT_URL),
    "utf8"
  );

  for (const value of ["19,986", "294,527", "7,029 / 7,029", "1,000,000"]) {
    assert.match(source, new RegExp(value.replace("/", "\\/")));
  }

  assert.match(source, /value: "0", label: "disagreements"/);
  assert.match(source, /Real Solana mainnet state was observed read-only/);
  assert.match(source, /proven separately on local/);
  assert.match(source, /No EquityGuard\s+transaction was sent on mainnet/);
});

test("the revised landing uses one wave canvas and shared outcome structures", async () => {
  const landingSource = await readFile(
    new URL("landing/landing-page.tsx", COMPONENT_URL),
    "utf8"
  );
  const heroSource = await readFile(
    new URL("landing/scroll-expand-hero.tsx", COMPONENT_URL),
    "utf8"
  );
  const waveSource = await readFile(
    new URL("react-bits/gradient-waves.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.equal(heroSource.match(/<GradientWaves/g)?.length, 1);
  assert.doesNotMatch(heroSource, /hero-story__grid/);
  assert.match(landingSource, /OUTCOMES\.map/);
  assert.match(landingSource, /0\.05504261/);
  assert.match(landingSource, /Economic state changed/);
  assert.match(landingSource, /Needs review/);
  assert.match(waveSource, /prefersReducedMotion/);
  assert.match(waveSource, /IntersectionObserver/);
  assert.match(waveSource, /visibilitychange/);
});

test("the public routes share the dark surface system without a grid", async () => {
  const demoSource = await readFile(
    new URL("demo/demo-experience.tsx", COMPONENT_URL),
    "utf8"
  );
  const docsSource = await readFile(new URL("docs/page.tsx", APP_URL), "utf8");
  const backdropSource = await readFile(
    new URL("layout/page-backdrop.tsx", COMPONENT_URL),
    "utf8"
  );
  const visualSystem = await readFile(
    new URL("ui/public-visual-system.css", COMPONENT_URL),
    "utf8"
  );

  assert.doesNotMatch(backdropSource, /grid/);
  assert.match(demoSource, /PublicSurface/);
  assert.match(demoSource, /AnimatedPublicPageAtmosphere/);
  assert.match(demoSource, /Order needs review/);
  assert.match(demoSource, /Protected trade replay completed/);
  assert.match(docsSource, /PublicSurface/);
  assert.match(docsSource, /PublicPageAtmosphere/);
  assert.match(visualSystem, /Manrope Variable/);
  assert.match(visualSystem, /--public-gradient-surface/);
});
