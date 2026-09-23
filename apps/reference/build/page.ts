/**
 * The global site shell.
 *
 * Every route is rendered from this one template at build time, so the
 * navigation, footer and document head exist in a single place and the active
 * route is already marked in the served HTML — the shell is complete and
 * keyboard-navigable before any script runs.
 */

export const REPOSITORY_URL = "https://github.com/Maheshsiddu29/EquityGuard";

export const STATE_PLACEHOLDER = "<!--EG_REFERENCE_STATE-->";

export interface RouteDefinition {
  /** Served path. Also the nav link target. */
  readonly path: string;
  /** Path of the emitted file relative to dist/. */
  readonly output: string;
  /** Navigation label. */
  readonly label: string;
}

export const ROUTES: readonly RouteDefinition[] = [
  { path: "/", output: "index.html", label: "Product" },
  { path: "/demo", output: "demo/index.html", label: "Demo" },
  { path: "/docs", output: "docs/index.html", label: "Docs" },
];

export interface PageSpec {
  /** Which route this page is; controls the active nav treatment. */
  readonly route: string;
  readonly title: string;
  readonly description: string;
  /** Inner HTML of <main>. */
  readonly main: string;
  /** Module scripts to load, in order, as absolute paths. */
  readonly scripts?: readonly string[];
  /** Emit the placeholder that build.ts replaces with the derived state. */
  readonly withStateSlot?: boolean;
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const MARK = `<span class="eg-nav__mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5.4c0 4.5-2.8 8-7 9.6-4.2-1.6-7-5.1-7-9.6V6z"/><path d="M8.5 12l2.2 2.2 4.8-5"/></svg></span>`;

/** `aria-current` is the accessible source of truth; CSS follows it. */
const current = (route: string, path: string) => (route === path ? ` aria-current="page"` : "");

function renderNav(route: string): string {
  const links = ROUTES.map(
    (item) =>
      `<li><a class="eg-nav__link" href="${item.path}"${current(route, item.path)}>${item.label}</a></li>`,
  ).join("");
  const sheetLinks = ROUTES.map(
    (item) =>
      `<a class="eg-mobile-nav__link" href="${item.path}"${current(route, item.path)}>${item.label}<span class="eg-link__arrow" aria-hidden="true">→</span></a>`,
  ).join("");

  return `<header class="eg-nav-wrap">
      <nav class="eg-nav eg-glass" aria-label="Primary">
        <a class="eg-nav__brand" href="/">${MARK}<span>EquityGuard</span></a>
        <ul class="eg-nav__links" data-nav-links>
          <span class="eg-nav__indicator" data-nav-indicator aria-hidden="true"></span>
          ${links}
        </ul>
        <div class="eg-nav__actions">
          <a class="eg-btn eg-btn--secondary" href="${REPOSITORY_URL}" target="_blank" rel="noreferrer">GitHub<span class="eg-link__arrow" aria-hidden="true">↗</span><span class="eg-sr-only">(opens in a new tab)</span></a>
        </div>
        <button class="eg-nav__toggle" type="button" data-nav-toggle aria-expanded="false" aria-controls="eg-mobile-nav" aria-label="Open menu">
          <span class="eg-nav__toggle-bars" aria-hidden="true"><span></span><span></span></span>
        </button>
      </nav>
      <div class="eg-mobile-nav eg-glass" id="eg-mobile-nav" data-nav-sheet data-state="closed" hidden>
        ${sheetLinks}
        <a class="eg-btn eg-btn--secondary eg-btn--wide" href="${REPOSITORY_URL}" target="_blank" rel="noreferrer">GitHub<span class="eg-link__arrow" aria-hidden="true">↗</span><span class="eg-sr-only">(opens in a new tab)</span></a>
      </div>
    </header>`;
}

function renderFooter(): string {
  const links = ROUTES.map((item) => `<li><a href="${item.path}">${item.label}</a></li>`).join("");
  return `<footer class="eg-footer">
      <div class="eg-container eg-footer__inner">
        <div class="eg-footer__brand">
          <span class="eg-footer__name">EquityGuard</span>
          <span>Corporate-action-aware execution infrastructure for tokenized equities on Solana.</span>
        </div>
        <nav aria-label="Footer">
          <ul class="eg-footer__nav">
            ${links}
            <li><a href="${REPOSITORY_URL}" target="_blank" rel="noreferrer">GitHub<span class="eg-link__arrow" aria-hidden="true">↗</span><span class="eg-sr-only">(opens in a new tab)</span></a></li>
          </ul>
        </nav>
        <p class="eg-footer__note">Not a mainnet purchase. No transaction is sent by this page.</p>
      </div>
    </footer>`;
}

export function renderPage(spec: PageSpec): string {
  const scripts = (spec.scripts ?? [])
    .map((src) => `  <script type="module" src="${src}"></script>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${spec.title}</title>
  <meta name="description" content="${escapeAttribute(spec.description)}">
  <link rel="preload" href="/fonts/geist-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css">${spec.withStateSlot ? `\n  ${STATE_PLACEHOLDER}` : ""}
${scripts}
</head>
<body>
  <div class="eg-field" aria-hidden="true"></div>
  <a class="eg-skip-link" href="#main">Skip to content</a>
  ${renderNav(spec.route)}
  <main id="main" class="eg-page-enter">
${spec.main.trimEnd()}
  </main>
  ${renderFooter()}
</body>
</html>
`;
}
