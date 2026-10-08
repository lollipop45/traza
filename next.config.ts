import type { NextConfig } from "next";

// Security headers for every response. Deliberately conservative: none of them restricts which
// scripts, styles or connections Next.js, Supabase or the service worker use. A full nonce-based
// Content-Security-Policy is deferred (it would need per-request nonces on every page).
//   - nosniff: no MIME sniffing;
//   - Referrer-Policy: other sites see the origin only, never TRAZA paths or query strings;
//   - no framing (clickjacking): X-Frame-Options + CSP frame-ancestors;
//   - base-uri / object-src: no <base> hijacking, no plugins;
//   - Permissions-Policy: TRAZA uses no camera, microphone, location, payment or USB (notifications
//     are not governed by Permissions-Policy and keep working);
//   - HSTS only on a Vercel production deployment (always HTTPS there).
const FRAME_AND_BASE_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: FRAME_AND_BASE_POLICY },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  ...(process.env.VERCEL_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // The service worker is always revalidated (an update is picked up on the next visit) and may
        // only run same-origin script. It caches no private data (see public/sw.js). Listed after
        // the global rule so this Content-Security-Policy replaces the general one for /sw.js.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self'; ${FRAME_AND_BASE_POLICY}` },
        ],
      },
      {
        // The generic offline page: public, static, and fetched fresh when the worker installs.
        source: "/offline.html",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

export default nextConfig;
