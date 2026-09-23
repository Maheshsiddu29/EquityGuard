"use client";

import { features } from "@/lib/config";
import { useReducedMotion } from "@/lib/motion";
import Lenis from "lenis";
import { useEffect, type ReactNode } from "react";

const LENIS_OPTIONS = {
  duration: 1.25,
  easing: (time: number) => Math.min(1, 1.001 - Math.pow(2, -10 * time)),
  orientation: "vertical" as const,
  gestureOrientation: "vertical" as const,
  smoothWheel: true,
  wheelMultiplier: 0.9,
  touchMultiplier: 1.4,
};

export function SmoothScroll({ children }: { children: ReactNode }): ReactNode {
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (!features.smoothScroll || prefersReducedMotion) {
      return;
    }

    const lenis = new Lenis(LENIS_OPTIONS);
    let animationFrame = 0;

    const update = (time: number): void => {
      lenis.raf(time);
      animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);

    const handleAnchorClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
      const href = anchor?.getAttribute("href");
      if (!href || href === "#") {
        return;
      }

      const destination = document.querySelector<HTMLElement>(href);
      if (!destination) {
        return;
      }

      event.preventDefault();
      lenis.scrollTo(destination, { offset: -112 });
    };

    document.addEventListener("click", handleAnchorClick);

    return () => {
      document.removeEventListener("click", handleAnchorClick);
      cancelAnimationFrame(animationFrame);
      lenis.destroy();
    };
  }, [prefersReducedMotion]);

  return children;
}
