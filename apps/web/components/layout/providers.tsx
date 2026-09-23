"use client";

import { SmoothScroll } from "@/components/layout/smooth-scroll";
import { ReducedMotionProvider } from "@/lib/motion";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <ReducedMotionProvider>
      <SmoothScroll>{children}</SmoothScroll>
    </ReducedMotionProvider>
  );
}
