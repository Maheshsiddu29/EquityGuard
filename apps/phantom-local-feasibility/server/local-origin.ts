/**
 * Which browser origins may drive the privileged local flow.
 *
 * The coordinator's own page (:4175) and the apps/web live demo on a local
 * Next.js server. Every entry is plain http on 127.0.0.1 or localhost, so a
 * remote host can never match and the local proof environment stays local.
 *
 * Pure and dependency-free so it is testable without starting the server,
 * which spawns a validator at import time.
 */
export const LOCAL_DEMO_PORTS: ReadonlySet<string> = new Set(["4175", "3000", "3001"]);

export function isLocalDemoOrigin(origin: string | undefined): boolean {
  if (typeof origin !== "string") return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    && LOCAL_DEMO_PORTS.has(url.port);
}
