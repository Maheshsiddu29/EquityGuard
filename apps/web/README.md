# EquityGuard public web app

This directory is the isolated Next.js public website for EquityGuard. It owns
the three public page routes: `/`, `/demo`, and `/docs`.

## Local development

Use Node.js 22.18 or newer. Install and run from this directory so the app uses
its own lockfile and TypeScript 5 toolchain instead of the repository-root
TypeScript 7 toolchain.

```sh
npm install
npm run dev
```

`NEXT_PUBLIC_SITE_URL` may be set to the canonical production URL. Vercel URL
environment variables are used automatically when that variable is absent.
The production script selects Next's supported Webpack builder so it does not
depend on Turbopack's loopback PostCSS worker in constrained build sandboxes.

## Template attribution

The site foundation adapts the App Router layout, fixed site frame, floating
animated navigation, Lenis integration, Motion primitives, reduced-motion
provider, metadata helpers, spacing approach, and responsive conventions from
[DavidHDev/rbp-portfolio](https://github.com/DavidHDev/rbp-portfolio), reviewed
at commit `1581b9b8e5876f60e5eb844970747506980c4412`.

Portfolio-specific copy, portraits, About/Projects/Contact sections, external
portfolio imagery, Matter.js physics, dark-theme machinery, and the OGL WebGL
shader were intentionally not carried into EquityGuard.

The landing hero also adapts React Bits' TypeScript/CSS Scroll Expand component,
reviewed at commit `b6666e9f3a03a062143ce409f3aac53e27fdfaa8`. The adaptation keeps
the scroll-progress and reduced-motion model, replaces its media surface with
EquityGuard's transaction narrative, and adds no package dependency. See
`THIRD_PARTY_NOTICES.md` for the upstream license.
