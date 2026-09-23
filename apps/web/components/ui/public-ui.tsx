import { createElement, type HTMLAttributes, type ReactNode } from "react";

type SurfaceElement = "article" | "aside" | "div" | "section";
type SurfaceTone = "dark" | "gradient" | "glass" | "technical";

export function PublicSurface({
  as = "div",
  tone = "dark",
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: SurfaceElement;
  tone?: SurfaceTone;
  children: ReactNode;
}): ReactNode {
  return createElement(
    as,
    {
      ...props,
      className: `public-surface public-surface--${tone} ${className}`.trim(),
    },
    children
  );
}

export function PublicPageAtmosphere({
  className = "",
}: {
  className?: string;
}): ReactNode {
  return (
    <div
      className={`public-page-atmosphere public-page-atmosphere--static ${className}`.trim()}
      aria-hidden="true"
    />
  );
}

export function SectionLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return <span className={`section-label ${className}`.trim()}>{children}</span>;
}

export function MonoLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return <span className={`mono-label ${className}`.trim()}>{children}</span>;
}

export function StatusLabel({
  children,
  icon,
  className = "",
}: {
  children: ReactNode;
  icon: string;
  className?: string;
}): ReactNode {
  return (
    <span className={`status-label ${className}`.trim()}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  );
}
