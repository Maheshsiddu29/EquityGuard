import { siteConfig } from "@/lib/metadata";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/demo", "/docs"].map((path) => ({
    url: new URL(path, siteConfig.url).toString(),
    changeFrequency: "weekly" as const,
    priority: path === "/" ? 1 : 0.8,
  }));
}
