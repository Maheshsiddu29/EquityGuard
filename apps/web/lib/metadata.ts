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
  description:
    "Execution-time protection for tokenized-equity transactions on Solana.",
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
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  keywords: [...siteConfig.keywords],
  creator: "EquityGuard",
  publisher: "EquityGuard",
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteConfig.url,
    title: siteConfig.name,
    description: siteConfig.description,
    siteName: siteConfig.name,
  },
  twitter: {
    card: "summary",
    title: siteConfig.name,
    description: siteConfig.description,
  },
  icons: {
    icon: "/icon.svg",
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
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: new URL(path, siteConfig.url),
    },
    twitter: {
      title,
      description,
    },
  };
}
