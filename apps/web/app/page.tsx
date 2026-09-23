import { LandingPage } from "@/components/landing/landing-page";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Execution integrity for tokenized assets",
  description:
    "EquityGuard prevents tokenized-asset transactions authorized under one economic state from silently executing under another.",
  path: "/",
});

export default function HomePage(): ReactNode {
  return <LandingPage />;
}
