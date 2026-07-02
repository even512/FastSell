/** @type {import('next').NextConfig} */
const nextConfig = {
  // sharp, @imgly background removal and playwright must stay external (native / large deps)
  serverExternalPackages: [
    "sharp",
    "@imgly/background-removal-node",
    "playwright",
    "playwright-extra",
    "puppeteer-extra-plugin-stealth",
  ],
  experimental: {
    // allow larger multipart uploads (a few photos) to the route handlers
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
