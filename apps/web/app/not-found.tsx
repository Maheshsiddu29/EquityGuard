import { BrandLogo } from "@/components/brand/brand-logo";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { absolute: "Page Not Found — EquityGuard" },
  description: "The requested route is not part of the EquityGuard public site.",
};

export default function NotFound(): ReactNode {
  return (
    <main id="main-content" className="not-found-page">
      <div className="not-found-page__atmosphere" aria-hidden="true" />
      <section className="not-found-page__card" aria-labelledby="not-found-title">
        <BrandLogo variant="mark" />
        <p className="section-label">Error · 404</p>
        <h1 id="not-found-title">Page not found</h1>
        <p>The route you&apos;re looking for isn&apos;t part of EquityGuard.</p>
        <Link className="button button--primary focus-ring" href="/">
          Back to EquityGuard <span aria-hidden="true">→</span>
        </Link>
      </section>
    </main>
  );
}
