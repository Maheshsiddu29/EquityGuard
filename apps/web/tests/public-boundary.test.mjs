import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const APP_URL = new URL("../app/", import.meta.url);
const COMPONENT_URL = new URL("../components/", import.meta.url);
const PUBLIC_URL = new URL("../public/", import.meta.url);
const SOURCE_BRAND_URL = new URL("../../../EquityGuard_Logo_Assets/", import.meta.url);

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

test("the technical docs expose the complete implementation-led information architecture", async () => {
  const pageSource = await readFile(new URL("docs/page.tsx", APP_URL), "utf8");
  const diagramSource = await readFile(
    new URL("docs/docs-diagrams.tsx", COMPONENT_URL),
    "utf8"
  );

  for (const section of [
    "overview",
    "problem",
    "how-it-works",
    "architecture",
    "transaction-model",
    "economic-state-model",
    "sdk",
    "integrations",
    "security",
    "evidence",
    "deployment",
    "limitations",
    "future-work",
    "references",
  ]) {
    assert.match(pageSource, new RegExp(`\\[\"${section}\"`));
    assert.match(pageSource, new RegExp(`id=\"${section}\"`));
  }

  for (const boundary of [
    "No mainnet EquityGuard transaction",
    "Strict route subset",
    "No universal protection window",
    "Upgrade-authority TOCTOU",
    "No external audit",
    "Packages are unpublished",
    "Two public demo modes",
  ]) {
    assert.match(pageSource, new RegExp(boundary));
  }

  assert.match(pageSource, /The trade you approved should be the trade that executes/);
  assert.match(pageSource, /19,986/);
  assert.match(pageSource, /294,527/);
  assert.match(pageSource, /1,000,000/);
  assert.match(pageSource, /@equityguard\/jupiter\/protect/);
  assert.match(pageSource, /packages are private and unpublished/i);
  assert.match(diagramSource, /SystemArchitectureDiagram/);
  assert.match(diagramSource, /SequenceDiagram/);
  assert.match(diagramSource, /TransactionDiagram/);
  assert.match(diagramSource, /EconomicStateDiagram/);
  assert.match(diagramSource, /RouterIntegrationDiagram/);
});

test("the docs keep recorded proof and Live Devnet as separate claims", async () => {
  const pageSource = await readFile(new URL("docs/page.tsx", APP_URL), "utf8");

  assert.match(pageSource, /Recorded proof/);
  assert.match(pageSource, /Live Devnet/);
  assert.match(pageSource, /connects to Phantom on Solana Devnet/);
  assert.match(pageSource, /Token-2022 TransferChecked/);
  assert.match(pageSource, /does not execute Jupiter or Whirlpool/);
  assert.match(pageSource, /not real securities, no market value, and not issuer-affiliated/);
  assert.match(pageSource, /The program does not exist on mainnet/);
  assert.match(pageSource, /Mainnet<\/dt><dd>No deployment/);
  assert.doesNotMatch(pageSource, /website demo does not connect to Phantom/i);
  assert.doesNotMatch(pageSource, /deployed on mainnet/i);
  assert.match(pageSource, /2G9qfs13xnUxYheu7t2cqY2EE9sBKodkpCuahMcGDtRZtRt5cwwjU7qYRGZVoMBegfZdqsmZEdqPU5CLUe4G92zj/);
  assert.match(pageSource, /2rxQmrThkTgQiG1M4WFLM1YjJtE4mBj93YjSBeDPdnEai3vJ44gU7dSAfcaq1vWLWXCv2GYLrxZGBMhReCGuyddp/);
  assert.match(pageSource, /cluster=devnet/);
});

test("the public shell uses the approved final brand assets", async () => {
  const [navSource, footerSource, brandSource, layoutSource] = await Promise.all([
    readFile(new URL("layout/nav.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("layout/site-footer.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("brand/brand-logo.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("layout.tsx", APP_URL), "utf8"),
  ]);

  assert.match(navSource, /<BrandLogo\s*\/>/);
  assert.doesNotMatch(navSource, /brand-mark__symbol/);
  assert.doesNotMatch(navSource, />\s*E\s*</);
  assert.match(footerSource, /<BrandLogo\s*\/>/);
  assert.match(layoutSource, /<SiteFooter\s*\/>/);
  assert.match(brandSource, /equityguard-logo\.svg/);
  assert.match(brandSource, /equityguard-mark\.svg/);

  const [productionLogo, sourceLogo, productionMark, sourceMark] =
    await Promise.all([
      readFile(new URL("brand/equityguard-logo.svg", PUBLIC_URL)),
      readFile(new URL("horizontal_primary_transparent.svg", SOURCE_BRAND_URL)),
      readFile(new URL("brand/equityguard-mark.svg", PUBLIC_URL)),
      readFile(new URL("symbol_primary_transparent.svg", SOURCE_BRAND_URL)),
    ]);

  assert.deepEqual(productionLogo, sourceLogo);
  assert.deepEqual(productionMark, sourceMark);
});

test("production metadata, icons, social preview, and 404 are complete", async () => {
  const [metadataSource, manifestSource, notFoundSource, readmeSource, ignoreSource] =
    await Promise.all([
      readFile(new URL("../lib/metadata.ts", import.meta.url), "utf8"),
      readFile(new URL("manifest.ts", APP_URL), "utf8"),
      readFile(new URL("not-found.tsx", APP_URL), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    ]);

  assert.match(metadataSource, /EquityGuard — Execution Integrity for Tokenized Assets/);
  assert.match(metadataSource, /summary_large_image/);
  assert.match(metadataSource, /opengraph-image\.png/);
  assert.match(metadataSource, /NEXT_PUBLIC_SITE_URL/);
  assert.match(metadataSource, /VERCEL_PROJECT_PRODUCTION_URL/);
  assert.match(manifestSource, /equityguard-app-icon\.png/);
  assert.match(manifestSource, /display: "standalone"/);
  assert.match(notFoundSource, /Page not found/);
  assert.match(notFoundSource, /Back to EquityGuard/);
  assert.match(readmeSource, /Root Directory: `apps\/web`/);
  assert.match(readmeSource, /Output Directory: leave unset/);
  assert.match(ignoreSource, /^next-env\.d\.ts$/m);

  const openGraphImage = await readFile(new URL("opengraph-image.png", APP_URL));
  assert.equal(openGraphImage.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(openGraphImage.readUInt32BE(16), 1200);
  assert.equal(openGraphImage.readUInt32BE(20), 630);
  assert.ok(openGraphImage.byteLength < 500_000);

  for (const path of ["favicon.ico", "icon.svg", "apple-icon.png"]) {
    assert.ok((await stat(new URL(path, APP_URL))).size > 0);
  }
});
