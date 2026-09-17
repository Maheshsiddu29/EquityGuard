#!/usr/bin/env node
/**
 * Static preview server for the built reference app. Loopback only; it
 * serves files from apps/reference/dist and nothing else.
 *
 *   npm run app:serve [-- --port 4173]
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const { values } = parseArgs({ options: { port: { type: "string", default: "4173" } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid --port ${values.port}`);

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  const file = DIST + relative;
  const type = TYPES[extname(file)];
  if (relative.startsWith("..") || relative.includes(`${sep}..`) || !type) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`reference app: http://127.0.0.1:${port}/  (demo controls: ?demo)`));
