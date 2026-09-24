import type { Metadata } from "next";

function getSiteUrl(): URL {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;

  if (configuredUrl) {
    return new URL(configuredUrl);
  }

  if (vercelHost) {
    return new URL(`https://${vercelHost}`);
  }

  return new URL("http://localhost:3000");
}

export const siteConfig = {
  name: "EquityGuard",
  title: "EquityGuard — Execution Integrity for Tokenized Assets",
  description:
    "EquityGuard is execution-integrity infrastructure for protected tokenized-asset trading on Solana.",
  url: getSiteUrl(),
  repository: "https://github.com/Maheshsiddu29/EquityGuard",
  keywords: [
    "EquityGuard",
    "Solana",
    "Token-2022",
    "tokenized equities",
    "corporate actions",
    "transaction protection",
  ],
} as const;

export const baseMetadata: Metadata = {
  metadataBase: siteConfig.url,
  title: {
    default: siteConfig.title,
    template: `%s — ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  keywords: [...siteConfig.keywords],
  creator: "EquityGuard",
  publisher: "EquityGuard",
  category: "technology",
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteConfig.url,
    title: siteConfig.title,
    description: siteConfig.description,
    siteName: siteConfig.name,
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "EquityGuard — The trade you approved should be the trade that executes.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.title,
    description: siteConfig.description,
    images: ["/opengraph-image.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export function createMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: `/${string}` | "/";
}): Metadata {
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: new URL(path, siteConfig.url),
      images: [
        {
          url: "/opengraph-image.png",
          width: 1200,
          height: 630,
          alt: "EquityGuard — The trade you approved should be the trade that executes.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/opengraph-image.png"],
    },
  };
}
