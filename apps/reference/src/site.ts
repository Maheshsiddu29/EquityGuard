/**
 * Global site shell behaviour: the floating navigation's travelling pill, the
 * mobile glass menu, and the scroll-reveal primitive.
 *
 * Everything here is progressive enhancement. The server-rendered shell is
 * already navigable, keyboard-operable and fully visible with this module
 * absent or failed; the module only adds motion and the mobile sheet.
 */

const MOBILE_BREAKPOINT = 880;

const prefersReducedMotion = (): boolean =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------
 * Travelling active pill
 * ------------------------------------------------------------------ */

function mountNavIndicator(): void {
  const list = document.querySelector<HTMLElement>("[data-nav-links]");
  const indicator = document.querySelector<HTMLElement>("[data-nav-indicator]");
  if (!list || !indicator) return;

  const links = [...list.querySelectorAll<HTMLAnchorElement>(".eg-nav__link")];
  const active = links.find((link) => link.getAttribute("aria-current") === "page");
  if (links.length === 0) return;

  // Tells CSS that JS owns the highlight, so the static fallback pill is
  // dropped in favour of the animated one.
  list.setAttribute("data-enhanced", "");

  const moveTo = (target: HTMLElement | undefined): void => {
    if (!target) {
      indicator.style.setProperty("--eg-pill-opacity", "0");
      return;
    }
    indicator.style.setProperty("--eg-pill-width", `${target.offsetWidth}px`);
    indicator.style.setProperty("--eg-pill-x", `${target.offsetLeft}px`);
    indicator.style.setProperty("--eg-pill-opacity", "1");
  };

  const rest = (): void => moveTo(active);

  // Place the pill without animating in from the left edge on first paint.
  indicator.setAttribute("data-initial", "");
  rest();
  window.requestAnimationFrame(() => indicator.removeAttribute("data-initial"));

  for (const link of links) {
    link.addEventListener("pointerenter", () => moveTo(link));
    link.addEventListener("focus", () => moveTo(link));
    link.addEventListener("blur", rest);
  }
  list.addEventListener("pointerleave", rest);
  window.addEventListener("resize", () => {
    indicator.setAttribute("data-initial", "");
    rest();
    window.requestAnimationFrame(() => indicator.removeAttribute("data-initial"));
  });
}

/* ------------------------------------------------------------------
 * Mobile glass menu
 * ------------------------------------------------------------------ */

function mountMobileNav(): void {
  const toggle = document.querySelector<HTMLButtonElement>("[data-nav-toggle]");
  const sheet = document.querySelector<HTMLElement>("[data-nav-sheet]");
  if (!toggle || !sheet) return;

  let open = false;

  const setOpen = (next: boolean, returnFocus: boolean): void => {
    if (next === open) return;
    open = next;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (open) {
      sheet.hidden = false;
      sheet.setAttribute("data-state", "closed");
      // One frame at the closed state so the transition has somewhere to run
      // from; with reduced motion the durations collapse and this is a no-op.
      window.requestAnimationFrame(() => sheet.setAttribute("data-state", "open"));
      sheet.querySelector<HTMLAnchorElement>("a")?.focus();
      return;
    }
    sheet.setAttribute("data-state", "closed");
    const hide = () => {
      if (!open) sheet.hidden = true;
    };
    if (prefersReducedMotion()) hide();
    else window.setTimeout(hide, 220);
    if (returnFocus) toggle.focus();
  };

  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open menu");
  sheet.hidden = true;
  sheet.setAttribute("data-state", "closed");

  toggle.addEventListener("click", () => setOpen(!open, false));

  // Following a link inside the sheet navigates; close first so a same-page
  // anchor does not leave the sheet covering the target.
  sheet.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("a")) setOpen(false, false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false, true);
  });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!open || sheet.contains(target) || toggle.contains(target)) return;
    setOpen(false, false);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > MOBILE_BREAKPOINT) setOpen(false, false);
  });
}

/* ------------------------------------------------------------------
 * Scroll reveal
 * ------------------------------------------------------------------ */

function mountReveal(): void {
  const targets = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
  if (targets.length === 0) return;

  // Without an observer, or with motion suppressed, content stays as rendered.
  if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).setAttribute("data-reveal-state", "shown");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );

  for (const target of targets) {
    const delay = Number(target.dataset["revealDelay"] ?? "0");
    if (Number.isFinite(delay) && delay > 0) {
      target.style.setProperty("--eg-reveal-delay", `${delay}ms`);
    }
    target.setAttribute("data-reveal-state", "hidden");
    observer.observe(target);
  }
}

function main(): void {
  mountNavIndicator();
  mountMobileNav();
  mountReveal();
}

main();

export {};
