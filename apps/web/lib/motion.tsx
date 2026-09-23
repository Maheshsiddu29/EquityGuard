"use client";

import { motion, type MotionProps, type Variants } from "motion/react";
import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

function subscribeToReducedMotion(callback: () => void): () => void {
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const ReducedMotionContext = createContext(false);

export function ReducedMotionProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const prefersReducedMotion = useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    () => false
  );

  return (
    <ReducedMotionContext.Provider value={prefersReducedMotion}>
      {children}
    </ReducedMotionContext.Provider>
  );
}

export function useReducedMotion(): boolean {
  return useContext(ReducedMotionContext);
}

const enter: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
};

const reducedEnter: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

type MotionElementProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
} & Omit<MotionProps, "children" | "className">;

export function MotionDiv({
  children,
  className,
  delay = 0,
  ...props
}: MotionElementProps): ReactNode {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={prefersReducedMotion ? reducedEnter : enter}
      transition={
        prefersReducedMotion
          ? { duration: 0.01 }
          : { duration: 0.72, delay, ease: [0.22, 1, 0.36, 1] }
      }
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}
