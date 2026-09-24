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
        src={
          isMark
            ? "/brand/equityguard-mark.svg"
            : "/brand/equityguard-logo.svg"
        }
        alt=""
        width={isMark ? 800 : 1600}
        height={isMark ? 600 : 400}
        sizes={isMark ? "48px" : "(max-width: 520px) 120px, 152px"}
      />
    </span>
  );
}
