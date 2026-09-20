import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const walletHtml = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const walletApp = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const walletBuild = readFileSync(new URL("../build/build.ts", import.meta.url), "utf8");
const walletServer = readFileSync(new URL("../build/serve.ts", import.meta.url), "utf8");
const referenceHtml = readFileSync(new URL("../../reference/web/index.html", import.meta.url), "utf8");
const referenceApp = readFileSync(new URL("../../reference/src/app.ts", import.meta.url), "utf8");
const referenceServer = readFileSync(new URL("../../reference/build/serve.ts", import.meta.url), "utf8");

describe("frontend proof boundaries", () => {
  it("uses matching cross-app ports and loopback-only servers", () => {
    assert.match(referenceHtml, /127\.0\.0\.1:4174/);
    assert.match(walletHtml, /127\.0\.0\.1:4173/);
    assert.match(referenceServer, /listen\(port, "127\.0\.0\.1"/);
    assert.match(walletServer, /4174/);
    assert.match(walletServer, /listen\(PORT, "127\.0\.0\.1"/);
  });

  it("marks recorded proof and keeps raw activity closed by default", () => {
    assert.match(walletHtml, /Recorded devnet proof/i);
    assert.match(walletHtml, /<details class="technical card">/);
    assert.doesNotMatch(walletHtml, /<details class="technical card" open/);
  });

  it("uses devnet explorer links only", () => {
    const links = walletHtml.match(/https:\/\/explorer\.solana\.com\/tx\/[^"<]+/g) ?? [];
    assert.equal(links.length, 3);
    for (const link of links) assert.match(link, /\?cluster=devnet$/);
  });

  it("keeps the reference app network-free", () => {
    assert.doesNotMatch(referenceApp, /createSolanaRpc|fetch\(|XMLHttpRequest|WebSocket|phantom|signTransaction/);
    assert.match(referenceHtml, /nothing is signed · no wallet, RPC, or network access/i);
  });

  it("does not import developer CLI signing paths into the browser", () => {
    assert.doesNotMatch(walletApp, /scripts\/devnet|run-m12a-devnet-proof|connectDevnet|sendInstructions/);
    assert.match(walletApp, /submitAndConfirm/);
  });

  it("bundles the Node compatibility bindings required by the frozen guard client", () => {
    assert.match(walletBuild, /alias:node:crypto/);
    assert.match(walletBuild, /buffer-shim\.ts/);
    assert.match(walletBuild, /--inject:/);
  });

  it("shows recovery UI for missing Phantom and missing demo assets", () => {
    assert.match(walletHtml, /id="wallet-status"/);
    assert.match(walletApp, /Phantom was not detected/);
    assert.match(walletApp, /Demo asset not found\. Create a new demo asset to continue\./);
  });

  it("verifies the mutation environment before requesting faucet funds", () => {
    const faucet = walletApp.slice(walletApp.indexOf("async function requestFaucet"), walletApp.indexOf("function randomSeed"));
    assert.ok(faucet.indexOf("await verifyMutationEnvironment()") < faucet.indexOf("requestAirdrop"));
  });

  it("keeps full technical identifiers and raw activity behind collapsed details", () => {
    assert.match(walletHtml, /ProgramData/);
    assert.match(walletHtml, /id="wallet-full"/);
    assert.match(walletHtml, /id="mint-full"/);
    assert.match(walletHtml, /id="token-raw"/);
    assert.match(walletHtml, /Technical transaction IDs/);
    assert.doesNotMatch(walletHtml, /<details class="technical card" open/);
  });
});
