/**
 * Where the proven local flow reaches its coordinator and its fixture files.
 *
 * The feasibility app is served by the coordinator itself, so its fetches are
 * same-origin and this module's default is the empty origin: `/api/arm` and
 * `./route-fixture.json`, exactly as before.
 *
 * A second local host — the Next.js site at apps/web running on loopback —
 * needs the same flow to reach the coordinator cross-origin. It calls
 * `configureLocalCoordinator` once, before anything else, and every fetch in
 * the proven path follows. Nothing else about the flow changes.
 *
 * `assertLocalRpcUrl` is the gate: http on 127.0.0.1 or localhost only. A
 * remote origin can never be configured here, so this cannot become a way to
 * point the privileged local path at a host on the internet.
 */
import { assertLocalRpcUrl } from "./feasibility.ts";

let configured = "";

/** Points the proven flow at a loopback coordinator. Refuses anything else. */
export function configureLocalCoordinator(origin: string): void {
  configured = assertLocalRpcUrl(origin).origin;
}

/** The configured coordinator origin, or "" while the host is same-origin. */
export function localCoordinatorOrigin(): string {
  return configured;
}

/** An absolute coordinator endpoint. `path` always begins with "/". */
export function coordinatorUrl(path: string): string {
  return configured + path;
}

/** A sealed fixture file, served by the coordinator beside the app bundle. */
export function fixtureUrl(name: string): string {
  return configured === "" ? `./${name}` : `${configured}/${name}`;
}
