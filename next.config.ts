import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Phase 2+ will add the eBay / Google OAuth callback routes under /api/auth/*.
  // Keeping serverExternalPackages declared avoids bundling the Prisma engine.
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
