import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // version-skew protection: an open tab of an older build is hard-navigated instead of calling stale server actions
  deploymentId: process.env.APP_BUILD_ID && process.env.APP_BUILD_ID !== "dev" ? process.env.APP_BUILD_ID : undefined,
  typedRoutes: false,
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
