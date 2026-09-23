import { Nav } from "@/components/layout/nav";
import { PageBackdrop } from "@/components/layout/page-backdrop";
import { Providers } from "@/components/layout/providers";
import { SkipToContent } from "@/components/layout/skip-to-content";
import { baseMetadata } from "@/lib/metadata";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "@fontsource-variable/manrope";
import "./globals.css";
import "../components/react-bits/gradient-waves.css";
import "../components/landing/landing-dark.css";
import "../components/ui/public-visual-system.css";

const geistSans = localFont({
  src: "../../shared/design-system/fonts/geist-sans-latin.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  weight: "100 900",
});

const geistMono = localFont({
  src: "../../shared/design-system/fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = baseMetadata;

export const viewport: Viewport = {
  themeColor: "#050914",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <Providers>
          <div className="site-frame site-frame--top" aria-hidden="true" />
          <div className="site-frame site-frame--left" aria-hidden="true" />
          <div className="site-frame site-frame--right" aria-hidden="true" />
          <svg
            className="site-corner site-corner--top-left"
            width="42"
            height="42"
            viewBox="0 0 42 42"
            aria-hidden="true"
          >
            <path d="M0 0c0 31.33 7.56 42 42 42H0V0Z" fill="currentColor" />
          </svg>
          <svg
            className="site-corner site-corner--top-right"
            width="42"
            height="42"
            viewBox="0 0 42 42"
            aria-hidden="true"
          >
            <path d="M0 0c0 31.33 7.56 42 42 42H0V0Z" fill="currentColor" />
          </svg>
          <SkipToContent />
          <PageBackdrop />
          <Nav />
          {children}
        </Providers>
      </body>
    </html>
  );
}
