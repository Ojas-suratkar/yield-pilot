/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
];

export default {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // a new value on every build: answers a browser saved under an older release are never shown with newer code
  env: { BUILD_ID: String(Date.now()) },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
