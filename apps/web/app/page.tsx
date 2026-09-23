import { LandingPage } from "@/components/landing/landing-page";
import { createMetadata } from "@/lib/metadata";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Execution integrity for tokenized assets",
  description:
    "EquityGuard prevents tokenized-asset transactions authorized under one economic state from silently executing under another.",
  path: "/",
});

export const viewport: Viewport = {
  themeColor: "#050914",
};

export default function HomePage(): ReactNode {
  return <LandingPage />;
}
