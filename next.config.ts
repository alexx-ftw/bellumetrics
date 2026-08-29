import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "1";

const nextConfig: NextConfig = isGitHubPages
  ? {
      output: "export",
      basePath: "/bellumetrics",
      assetPrefix: "/bellumetrics/",
      trailingSlash: true,
      // GitHub Pages serves only the public static application. Auth route
      // handlers remain available to a server-capable deployment and are
      // intentionally omitted from this export.
      pageExtensions: ["tsx"],
      images: {
        unoptimized: true,
      },
    }
  : {
      experimental: {
        authInterrupts: true,
      },
      pageExtensions: ["tsx", "ts", "jsx", "js", "server.tsx"],
    };

export default nextConfig;
