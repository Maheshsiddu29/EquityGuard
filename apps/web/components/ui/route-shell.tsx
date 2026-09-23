import { MotionDiv } from "@/lib/motion";
import Link from "next/link";
import type { ReactNode } from "react";

export function RouteShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  children: ReactNode;
}): ReactNode {
  return (
    <main id="main-content" className="route-main">
      <section className="route-hero page-container">
        <MotionDiv className="route-hero__copy">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="route-hero__intro">{intro}</p>
        </MotionDiv>
        {children}
      </section>
    </main>
  );
}

export function TextLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Link href={href} className="text-link focus-ring">
      {children}
      <span aria-hidden="true">→</span>
    </Link>
  );
}
