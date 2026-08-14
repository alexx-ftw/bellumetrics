import type { NextConfig } from "next";

const nextConfig: NextConfig = process.env.GITHUB_PAGES === "1"
  ? {
      output: "export",
      basePath: "/commander-elo",
      assetPrefix: "/commander-elo/",
      trailingSlash: true,
      images: {
        unoptimized: true,
      },
      typescript: {
        ignoreBuildErrors: true,
      },
    }
  : {};

export default nextConfig;
