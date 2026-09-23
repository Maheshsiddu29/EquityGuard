# Public web application

`apps/web` is the canonical public website under construction. It is separate
from `apps/reference`, `apps/devnet-wallet-demo`, and
`apps/phantom-local-feasibility`, which remain execution, evidence, and local
proof infrastructure.

## Dependency boundary

The repository root retains its TypeScript 7 toolchain. `apps/web` is not added
to the root npm workspaces and has its own `package.json`, `package-lock.json`,
`node_modules`, and TypeScript 5 compiler. Run its commands from `apps/web` or
with `npm --prefix apps/web run <script>`.

The public app imports the already-vendored Geist and Geist Mono font files
from `apps/shared/design-system/fonts`; it makes no runtime font request.

## Route and execution boundary

The only public page routes are `/`, `/demo`, and `/docs`. The public `/demo`
is a deterministic presentation of canonical evidence. It must never attempt
to connect to a visitor's localhost validator and must not be described as the
separate Phantom-signed localhost proof environment.

## Vercel

Use these project settings:

- Root Directory: `apps/web`
- Framework Preset: Next.js
- Install Command: `npm install` (or the default detected command)
- Build Command: `npm run build`
- Output Directory: leave unset; use standard Next.js output
- Node.js: 22.x, with `package.json` enforcing Node.js 22.18 or newer

The build script uses Next's supported Webpack builder. This avoids the
loopback port required by Turbopack's PostCSS worker in constrained build
environments while retaining standard Next.js deployment output.

Standard Next.js deployment is preferred over static export. It preserves the
App Router's metadata/runtime options and avoids prematurely constraining later
demo work. Set `NEXT_PUBLIC_SITE_URL` to the final canonical origin when it is
known. No Vercel project or remote state is created by this milestone.

## Planned frontend consolidation

After all three public routes are complete, a Vercel preview works, and the
human owner has approved the visuals, run a separate cleanup milestone. That
milestone will inventory every UI, preserve execution/evidence interfaces,
remove only confirmed-obsolete frontend code, update scripts and docs, and run
the complete regression suite. No cleanup is part of the current foundation
milestone.
