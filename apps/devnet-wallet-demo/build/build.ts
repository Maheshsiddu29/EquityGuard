import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(rootDir, "..", "..");
const distDir = path.join(rootDir, "dist");
const webDir = path.join(rootDir, "web");

async function build() {
  console.log("Building Devnet Wallet Demo app...");

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const cryptoShimPath = path.join(rootDir, "src", "crypto-shim.ts");
  const bufferShimPath = path.join(rootDir, "src", "buffer-shim.ts");
  const entryPoint = path.join(rootDir, "src", "app.ts");
  const outFile = path.join(distDir, "app.js");

  const esbuild = path.join(repoRoot, "node_modules", "esbuild", "bin", "esbuild");
  execFileSync(
    esbuild,
    [
      entryPoint,
      "--bundle",
      `--outfile=${outFile}`,
      "--format=esm",
      "--target=es2023",
      "--platform=browser",
      "--sourcemap",
      `--alias:node:crypto=${cryptoShimPath}`,
      `--inject:${bufferShimPath}`,
      "--define:process.env.NODE_ENV=\"production\"",
      "--define:global=window",
    ],
    { stdio: "inherit", cwd: repoRoot }
  );

  // Copy static web assets (index.html, styles.css) to dist/
  fs.copyFileSync(path.join(webDir, "index.html"), path.join(distDir, "index.html"));
  const sharedCss = fs.readFileSync(path.join(repoRoot, "apps", "shared", "equityguard.css"), "utf8");
  const appCss = fs.readFileSync(path.join(webDir, "styles.css"), "utf8");
  fs.writeFileSync(path.join(distDir, "styles.css"), `${sharedCss}\n${appCss}`);

  console.log(`Build complete! Static files ready in ${distDir}`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
