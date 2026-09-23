"use client";

import { useReducedMotion } from "@/lib/motion";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

const clamp = (value: number, minimum: number, maximum: number): number =>
  value < minimum ? minimum : value > maximum ? maximum : value;

const smoothstep = (edgeStart: number, edgeEnd: number, value: number): number => {
  const progress = clamp(
    (value - edgeStart) / (edgeEnd - edgeStart || 1e-6),
    0,
    1
  );
  return progress * progress * (3 - 2 * progress);
};

type ScrollExpandConfig = {
  startWidth: number;
  startHeight: number;
  startRadius: number;
  endRadius: number;
  mediaZoom: number;
  scrollDistance: number;
  holdDistance: number;
  smoothing: number;
};

type ScrollExpandProps = ScrollExpandConfig & {
  children: ReactNode;
  className?: string;
  scrollHint?: string;
};

function readRange(element: HTMLElement): readonly [number, number] {
  const [startValue, endValue] = (element.dataset.scrollStep ?? "0,1")
    .split(",")
    .map(Number);

  return [
    Number.isFinite(startValue) ? (startValue ?? 0) : 0,
    Number.isFinite(endValue) ? (endValue ?? 1) : 1,
  ];
}

/**
 * Adapted from React Bits ScrollExpand (TS/CSS variant).
 * Copyright (c) 2026 David Haz; MIT + Commons Clause.
 * The media frame is replaced with an application-native transaction story.
 */
export function ScrollExpand({
  children,
  className = "",
  scrollHint = "",
  startWidth,
  startHeight,
  startRadius,
  endRadius,
  mediaZoom,
  scrollDistance,
  holdDistance,
  smoothing,
}: ScrollExpandProps): ReactNode {
  const prefersReducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const stepsRef = useRef<HTMLElement[]>([]);
  const markersRef = useRef<HTMLElement[]>([]);
  const compactRef = useRef(false);

  const applyProgress = useCallback((progress: number) => {
    const root = rootRef.current;
    const frame = frameRef.current;
    const surface = surfaceRef.current;
    if (!root || !frame || !surface) {
      return;
    }

    const eased = smoothstep(0, 1, progress);
    const responsiveStartWidth = compactRef.current
      ? Math.max(startWidth, 88)
      : startWidth;
    const responsiveStartHeight = compactRef.current
      ? Math.max(startHeight, 68)
      : startHeight;
    const width = responsiveStartWidth + (100 - responsiveStartWidth) * eased;
    const height = responsiveStartHeight + (100 - responsiveStartHeight) * eased;
    const insetX = Math.max(0, (100 - width) / 2);
    const insetY = Math.max(0, (100 - height) / 2);
    const radius =
      startRadius + (endRadius - startRadius) * eased;

    frame.style.clipPath = `inset(${insetY}% ${insetX}% ${insetY}% ${insetX}% round ${radius}px)`;
    surface.style.transform = `scale(${mediaZoom + (1 - mediaZoom) * eased})`;
    root.style.setProperty("--scroll-expand-progress", progress.toFixed(4));

    if (hintRef.current) {
      const hidden = smoothstep(0, 0.12, progress);
      hintRef.current.style.opacity = `${1 - hidden}`;
      hintRef.current.style.transform = `translate3d(0, ${8 * hidden}px, 0)`;
    }

    for (const step of stepsRef.current) {
      const [rangeStart, rangeEnd] = readRange(step);
      const fadeLength = Math.min(0.11, Math.max(0.04, (rangeEnd - rangeStart) / 3));
      const enter =
        rangeStart === 0
          ? 1
          : smoothstep(rangeStart, rangeStart + fadeLength, progress);
      const exit =
        rangeEnd === 1
          ? 1
          : 1 - smoothstep(rangeEnd - fadeLength, rangeEnd, progress);
      const opacity = enter * exit;
      step.style.opacity = opacity.toFixed(4);
      step.style.transform = `translate3d(-50%, calc(-50% + ${18 * (1 - opacity)}px), 0)`;
      step.style.pointerEvents = opacity > 0.6 ? "auto" : "none";
    }

    const activeMarker = Math.min(
      markersRef.current.length - 1,
      Math.floor(progress * markersRef.current.length)
    );
    markersRef.current.forEach((marker, index) => {
      marker.dataset.state =
        index < activeMarker
          ? "complete"
          : index === activeMarker
            ? "active"
            : "pending";
    });
  }, [endRadius, mediaZoom, startHeight, startRadius, startWidth]);

  useEffect(() => {
    const root = rootRef.current;
    const track = trackRef.current;
    const stage = stageRef.current;
    if (!root || !track || !stage) {
      return;
    }

    stepsRef.current = Array.from(
      root.querySelectorAll<HTMLElement>("[data-scroll-step]")
    );
    markersRef.current = Array.from(
      root.querySelectorAll<HTMLElement>("[data-scroll-marker]")
    );

    if (prefersReducedMotion) {
      frameRef.current?.style.setProperty(
        "clip-path",
        `inset(0 0 0 0 round ${endRadius}px)`
      );
      surfaceRef.current?.style.setProperty("transform", "scale(1)");
      root.style.setProperty("--scroll-expand-progress", "1");
      return;
    }

    let animationFrame = 0;
    let current = 0;
    let target = 0;
    let stageHeight = 0;
    let running = false;

    const measure = (): void => {
      stageHeight = window.innerHeight;
      compactRef.current = root.clientWidth < 640;
      stage.style.height = `${stageHeight}px`;
      track.style.height = `${stageHeight * (1 + Math.max(0, scrollDistance) + Math.max(0, holdDistance))}px`;
    };

    const readProgress = (): number => {
      const span = stageHeight * Math.max(0.01, scrollDistance);
      return clamp(-track.getBoundingClientRect().top / span, 0, 1);
    };

    const tick = (): void => {
      const follow =
        smoothing <= 0
          ? 1
          : 1 - Math.exp(-1 / (60 * smoothing));
      current += (target - current) * follow;
      if (Math.abs(target - current) < 0.0004) {
        current = target;
        running = false;
      }
      applyProgress(current);
      animationFrame = running ? requestAnimationFrame(tick) : 0;
    };

    const kick = (): void => {
      if (running) {
        return;
      }
      running = true;
      if (!animationFrame) {
        animationFrame = requestAnimationFrame(tick);
      }
    };

    const handleScroll = (): void => {
      target = readProgress();
      if (smoothing <= 0) {
        current = target;
        applyProgress(current);
        return;
      }
      kick();
    };

    const handleResize = (): void => {
      measure();
      target = readProgress();
      current = target;
      applyProgress(current);
    };

    measure();
    target = readProgress();
    current = target;
    applyProgress(current);

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(root);

    return () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
    };
  }, [
    applyProgress,
    endRadius,
    holdDistance,
    prefersReducedMotion,
    scrollDistance,
    smoothing,
  ]);

  return (
    <div
      ref={rootRef}
      className={`scroll-expand ${prefersReducedMotion ? "scroll-expand--reduced" : ""} ${className}`.trim()}
    >
      <div ref={trackRef} className="scroll-expand__track">
        <div ref={stageRef} className="scroll-expand__stage">
          <div ref={frameRef} className="scroll-expand__frame">
            <div ref={surfaceRef} className="scroll-expand__surface">
              {children}
            </div>
          </div>
          {scrollHint ? (
            <p ref={hintRef} className="scroll-expand__hint">
              <span aria-hidden="true">↓</span>
              {scrollHint}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
