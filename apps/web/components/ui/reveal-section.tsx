"use client";

import { useReducedMotion } from "@/lib/motion";
import { motion } from "motion/react";
import type { ReactNode } from "react";

export function RevealSection({
  children,
  className,
  id,
  labelledBy,
}: {
  children: ReactNode;
  className: string;
  id?: string;
  labelledBy: string;
}): ReactNode {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.section
      id={id}
      aria-labelledby={labelledBy}
      className={className}
      initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.14 }}
      transition={
        prefersReducedMotion
          ? { duration: 0 }
          : { duration: 0.72, ease: [0.22, 1, 0.36, 1] }
      }
    >
      {children}
    </motion.section>
  );
}
