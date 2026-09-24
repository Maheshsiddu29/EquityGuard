import { BrandLogo } from "@/components/brand/brand-logo";
import { siteConfig } from "@/lib/metadata";
import Link from "next/link";
import type { ReactNode } from "react";

export function SiteFooter(): ReactNode {
  return (
    <footer className="site-footer">
      <div className="site-footer__waves" aria-hidden="true" />
      <div className="site-footer__inner page-container">
        <div className="site-footer__brand">
          <Link
            href="/"
            className="site-footer__logo focus-ring"
            aria-label="EquityGuard home"
          >
            <BrandLogo />
          </Link>
          <p>
            Execution-integrity infrastructure for protected tokenized-asset
            trading on Solana.
          </p>
        </div>

        <nav className="site-footer__nav" aria-label="Footer navigation">
          <Link className="focus-ring" href="/demo">Demo</Link>
          <Link className="focus-ring" href="/docs">Docs</Link>
          <a
            className="focus-ring"
            href={siteConfig.repository}
            target="_blank"
            rel="noreferrer"
          >
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}
