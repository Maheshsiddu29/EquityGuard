import Image from "next/image";
import type { ReactNode } from "react";

type BrandLogoProps = {
  className?: string;
  variant?: "horizontal" | "mark";
};

export function BrandLogo({
  className = "",
  variant = "horizontal",
}: BrandLogoProps): ReactNode {
  const isMark = variant === "mark";

  return (
    <span
      className={`brand-logo brand-logo--${variant} ${className}`.trim()}
      aria-hidden="true"
    >
      <Image
        src="/brand/stateguard-mark.svg"
        alt=""
        width={800}
        height={600}
        sizes={isMark ? "48px" : "28px"}
      />
      {isMark ? null : <span className="brand-logo__word">StateGuard</span>}
    </span>
  );
}
