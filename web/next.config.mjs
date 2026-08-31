const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
if (!apiBaseUrl) {
  throw new Error(
    "NEXT_PUBLIC_API_BASE_URL is required for web builds; localhost fallback is disabled.",
  );
}
try {
  new URL(apiBaseUrl);
} catch {
  throw new Error("NEXT_PUBLIC_API_BASE_URL must be an absolute URL.");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  async rewrites() {
    return [];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  }
};

export default nextConfig;
