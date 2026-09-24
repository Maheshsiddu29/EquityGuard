# StateGuard public web app

This directory is the isolated Next.js public website for StateGuard. It owns
the three public page routes: `/`, `/demo`, and `/docs`.

## Local development

Use Node.js 22.18 or newer. Install and run from this directory so the app uses
its own lockfile and TypeScript 5 toolchain instead of the repository-root
TypeScript 7 toolchain.

```sh
npm install
npm run dev
```

`NEXT_PUBLIC_SITE_URL` may be set to the canonical production URL, including
its `https://` scheme. Vercel's `VERCEL_PROJECT_PRODUCTION_URL` and
`VERCEL_URL` values are used automatically when that variable is absent; local
development falls back to `http://localhost:3000`. Once the production domain
is known, configure `NEXT_PUBLIC_SITE_URL` in Vercel for Production so canonical,
Open Graph, robots, and sitemap URLs use that domain. Preview deployments work
without it.

## Vercel configuration

- Root Directory: `apps/web`
- Framework Preset: Next.js
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: leave unset
- Node.js: 22.x

No `vercel.json` is required. The site uses framework defaults.
The production script selects Next's supported Webpack builder so it does not
depend on Turbopack's loopback PostCSS worker in constrained build sandboxes.

## Template attribution

The site foundation adapts the App Router layout, fixed site frame, floating
animated navigation, Lenis integration, Motion primitives, reduced-motion
provider, metadata helpers, spacing approach, and responsive conventions from
[DavidHDev/rbp-portfolio](https://github.com/DavidHDev/rbp-portfolio), reviewed
at commit `1581b9b8e5876f60e5eb844970747506980c4412`.

Portfolio-specific copy, portraits, About/Projects/Contact sections, external
portfolio imagery, Matter.js physics, dark-theme machinery, and that
portfolio's OGL WebGL shader were intentionally not carried into StateGuard.

The landing hero also adapts React Bits' TypeScript/CSS Scroll Expand and
Gradient Waves components, reviewed at commit
`b6666e9f3a03a062143ce409f3aac53e27fdfaa8`. Scroll Expand replaces its media
surface with StateGuard's transaction narrative. Gradient Waves uses one
low-detail `ogl` WebGL2 canvas, pauses when offscreen or when the page is
hidden, and is replaced by a static CSS treatment when reduced motion is
requested. See `THIRD_PARTY_NOTICES.md` for the upstream license.

Manrope is self-hosted through `@fontsource-variable/manrope`; no font or image
asset is requested from a third-party origin at runtime.

The landing, deterministic demo, and documentation routes share the same dark
navy/cobalt surface tokens and Manrope UI typography. The landing and demo each
mount at most one page-level Gradient Waves canvas; documentation uses a static
CSS atmosphere. Cards and technical panels use static gradient surfaces rather
than additional canvases.
