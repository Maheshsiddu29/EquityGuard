import type { ReactNode } from "react";

export function PageBackdrop(): ReactNode {
  return (
    <div className="page-backdrop" aria-hidden="true">
      <div className="page-backdrop__glow" />
      <div className="page-backdrop__grid" />
    </div>
  );
}
