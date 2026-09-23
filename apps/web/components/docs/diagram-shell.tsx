"use client";

import { useRef, type ReactNode } from "react";

export function DiagramShell({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: ReactNode;
}): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <figure className="docs-diagram">
      <figcaption className="docs-diagram__heading">
        <div>
          <strong>{title}</strong>
          <span>{caption}</span>
        </div>
        <button
          className="docs-diagram__expand focus-ring"
          type="button"
          onClick={() => dialogRef.current?.showModal()}
          aria-label={`Open ${title} in a larger view`}
        >
          Expand <span aria-hidden="true">↗</span>
        </button>
      </figcaption>
      <div className="docs-diagram__viewport">{children}</div>

      <dialog ref={dialogRef} className="docs-diagram-dialog">
        <div className="docs-diagram-dialog__header">
          <div>
            <strong>{title}</strong>
            <span>{caption}</span>
          </div>
          <form method="dialog">
            <button className="docs-diagram__close focus-ring" type="submit">
              Close <span aria-hidden="true">×</span>
            </button>
          </form>
        </div>
        <div className="docs-diagram-dialog__body">{children}</div>
      </dialog>
    </figure>
  );
}
