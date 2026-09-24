import { siteConfig } from "@/lib/metadata";
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: siteConfig.name,
    short_name: siteConfig.name,
    description: siteConfig.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#080A14",
    theme_color: "#080A14",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/brand/stateguard-app-icon.png",
        sizes: "1024x1024",
        type: "image/png",
      },
    ],
  };
}
