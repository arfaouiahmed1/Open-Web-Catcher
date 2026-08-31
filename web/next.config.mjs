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
    // Server-side proxy target: API_BASE_URL (container-internal, set at boot by
    // compose) wins so the web container can reach the API over the docker
    // network; the build-time public origin is the fallback for host runs.
    const backend = (process.env.API_BASE_URL || apiBaseUrl).replace(/\/+$/, "");
    return [
      {
        // Operational health probe for the web container (compose healthcheck);
        // proxies to the backend's /health endpoint.
        source: "/api/health",
        destination: `${backend}/health`,
      },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb"
    }
  }
};

export default nextConfig;
