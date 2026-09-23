"use client";

import { useReducedMotion } from "@/lib/motion";
import { useEffect, useRef, type ReactNode } from "react";

const vertexShader = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `#version 300 es
precision highp float;
uniform vec2 iResolution;
uniform float iTime;
uniform vec3 uHorizonColor;
uniform vec3 uWaveColor;
uniform vec3 uCrestColor;
out vec4 fragColor;

const float MAX_DIST = 20000.0;

float plasma(vec3 ray, vec2 frequency, vec4 timeCycle) {
  float waveX = ray.x + timeCycle.x;
  waveX += 27.0 * sin((ray.y + waveX) / 20.0 + timeCycle.y);
  float waveY = ray.y - timeCycle.z;
  waveY += 13.0 * cos(ray.x / 23.0 + timeCycle.w);
  return ray.z - (sin(waveX * frequency.x) * 2.15 + sin(waveY * frequency.y) * 2.15 + 5.5);
}

float raymarch(vec3 position, vec3 direction, vec2 frequency, vec4 timeCycle) {
  float distanceTravelled = 0.0;
  for (int index = 0; index < 48; index++) {
    float distanceToScene = plasma(position + distanceTravelled * direction, frequency, timeCycle);
    if (abs(distanceToScene) < 0.1) break;
    distanceTravelled += 0.9 * distanceToScene;
    if (!(abs(distanceTravelled) < MAX_DIST)) return MAX_DIST;
  }
  return distanceTravelled;
}

void main() {
  float time = iTime * 0.16;
  vec2 frequency = vec2(0.082, 0.16);
  vec4 timeCycle = vec4(time / 0.130, time / 0.810, time / 0.200, time / 0.710);
  float verticalFov = 3.14159 / 2.55;
  vec3 camera = vec3(0.0, 0.0, 30.0);
  vec2 uv = (gl_FragCoord.xy / iResolution.xy) - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv.y *= -1.0;

  vec3 direction = vec3(0.0, 0.0, -1.0);
  float uvLength = length(uv);
  float xRotation = verticalFov * uvLength;
  float cosine = cos(xRotation);
  float sine = sin(xRotation);
  direction = mat3(1.0, 0.0, 0.0, 0.0, cosine, -sine, 0.0, sine, cosine) * direction;
  vec2 normalizedUv = uvLength > 1e-5 ? uv / uvLength : vec2(1.0, 0.0);
  cosine = normalizedUv.x;
  sine = normalizedUv.y;
  direction = mat3(cosine, -sine, 0.0, sine, cosine, 0.0, 0.0, 0.0, 1.0) * direction;
  cosine = cos(1.04);
  sine = sin(1.04);
  direction = mat3(cosine, 0.0, sine, 0.0, 1.0, 0.0, -sine, 0.0, cosine) * direction;

  float distanceTravelled = raymarch(camera, direction, frequency, timeCycle);
  vec3 position = camera + distanceTravelled * direction;
  float fog = clamp(15.0 / max(distanceTravelled, 0.001), 0.0, 1.0);
  vec3 body = mix(uWaveColor, uCrestColor, clamp(position.z * 0.08 + 0.5, 0.0, 1.0));
  vec3 color = clamp(mix(uHorizonColor, body, fog) * 1.08, 0.0, 1.0);
  float alpha = clamp(fog, 0.0, 1.0);
  fragColor = vec4(color * alpha, alpha);
}
`;

function hexToRgb(hex: string): Float32Array {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) {
    return new Float32Array([1, 1, 1]);
  }

  return new Float32Array([
    Number.parseInt(match[1] ?? "ff", 16) / 255,
    Number.parseInt(match[2] ?? "ff", 16) / 255,
    Number.parseInt(match[3] ?? "ff", 16) / 255,
  ]);
}

type GradientWavesProps = {
  className?: string;
  horizonColor?: string;
  waveColor?: string;
  crestColor?: string;
};

/**
 * Adapted from React Bits Gradient Waves (JS/CSS registry variant).
 * Copyright (c) 2026 David Haz; MIT + Commons Clause.
 *
 * The EquityGuard version uses one low-detail WebGL2 canvas, removes pointer
 * tracking and grain, pauses outside the viewport, and does not initialize
 * WebGL when reduced motion is requested.
 */
export function GradientWaves({
  className = "",
  horizonColor = "#07142e",
  waveColor = "#2450c9",
  crestColor = "#789cff",
}: GradientWavesProps): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    if (!container || prefersReducedMotion) {
      return;
    }

    let disposed = false;
    let cleanup: (() => void) | undefined;

    void import("ogl")
      .then(({ Mesh, Program, Renderer, Triangle }) => {
        if (disposed) {
          return;
        }

        try {
          const renderer = new Renderer({
            webgl: 2,
            alpha: true,
            premultipliedAlpha: true,
            antialias: false,
            dpr: Math.min(window.devicePixelRatio || 1, 1.5),
          });
          const gl = renderer.gl;
          gl.clearColor(0, 0, 0, 0);
          const canvas = gl.canvas as HTMLCanvasElement;
          canvas.className = "gradient-waves__canvas";
          container.appendChild(canvas);

          const geometry = new Triangle(gl);
          const program = new Program(gl, {
            vertex: vertexShader,
            fragment: fragmentShader,
            uniforms: {
              iTime: { value: 0 },
              iResolution: { value: new Float32Array([1, 1]) },
              uHorizonColor: { value: hexToRgb(horizonColor) },
              uWaveColor: { value: hexToRgb(waveColor) },
              uCrestColor: { value: hexToRgb(crestColor) },
            },
          });
          const mesh = new Mesh(gl, { geometry, program });

          const render = (): void => renderer.render({ scene: mesh });
          const setSize = (): void => {
            const bounds = container.getBoundingClientRect();
            renderer.setSize(
              Math.max(1, Math.floor(bounds.width)),
              Math.max(1, Math.floor(bounds.height))
            );
            const resolution = program.uniforms.iResolution?.value as Float32Array;
            resolution[0] = gl.drawingBufferWidth;
            resolution[1] = gl.drawingBufferHeight;
            render();
          };

          let animationFrame = 0;
          let inViewport = true;
          let pageVisible = !document.hidden;
          const startedAt = performance.now();

          const animate = (time: number): void => {
            const timeUniform = program.uniforms.iTime;
            if (timeUniform) {
              timeUniform.value = (time - startedAt) * 0.001;
            }
            render();
            animationFrame = requestAnimationFrame(animate);
          };

          const stop = (): void => {
            if (animationFrame) {
              cancelAnimationFrame(animationFrame);
              animationFrame = 0;
            }
          };

          const start = (): void => {
            if (inViewport && pageVisible && !animationFrame) {
              animationFrame = requestAnimationFrame(animate);
            }
          };

          const resizeObserver = new ResizeObserver(setSize);
          resizeObserver.observe(container);
          const intersectionObserver = new IntersectionObserver(([entry]) => {
            inViewport = entry?.isIntersecting ?? false;
            if (inViewport) start();
            else stop();
          });
          intersectionObserver.observe(container);

          const handleVisibility = (): void => {
            pageVisible = !document.hidden;
            if (pageVisible) start();
            else stop();
          };

          document.addEventListener("visibilitychange", handleVisibility);
          setSize();
          start();

          cleanup = () => {
            stop();
            resizeObserver.disconnect();
            intersectionObserver.disconnect();
            document.removeEventListener("visibilitychange", handleVisibility);
            canvas.remove();
            gl.getExtension("WEBGL_lose_context")?.loseContext();
          };
        } catch {
          container.dataset.rendering = "static";
        }
      })
      .catch(() => {
        if (!disposed) {
          container.dataset.rendering = "static";
        }
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [crestColor, horizonColor, prefersReducedMotion, waveColor]);

  return (
    <div
      ref={containerRef}
      className={`gradient-waves ${prefersReducedMotion ? "gradient-waves--static" : ""} ${className}`.trim()}
      aria-hidden="true"
    />
  );
}
