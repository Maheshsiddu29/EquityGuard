import { GradientWaves } from "@/components/react-bits/gradient-waves";
import type { ReactNode } from "react";

export function AnimatedPublicPageAtmosphere({
  className = "",
}: {
  className?: string;
}): ReactNode {
  return (
    <GradientWaves
      className={`public-page-atmosphere public-page-atmosphere--animated ${className}`.trim()}
      horizonColor="#07142e"
      waveColor="#1f49b6"
      crestColor="#668fff"
    />
  );
}
