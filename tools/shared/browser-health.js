import { URL } from 'node:url';

const DEFAULT_BROWSER_HTTP_ENDPOINT = 'http://localhost:9222';

export function cdpHttpUrlFromWsEndpoint(wsEndpoint) {
  try {
    const parsed = new URL(String(wsEndpoint || '').trim());
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol)) {
      return DEFAULT_BROWSER_HTTP_ENDPOINT;
    }

    const httpProtocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
    return `${httpProtocol}//${parsed.host}`;
  } catch {
    return DEFAULT_BROWSER_HTTP_ENDPOINT;
  }
}

export async function probeBrowserEndpoint(wsEndpoint, timeoutMs = 3000) {
  const configuredWsEndpoint = String(wsEndpoint || '').trim();
  const baseUrl = cdpHttpUrlFromWsEndpoint(configuredWsEndpoint);
  const probeUrl = `${baseUrl}/json/version`;

  try {
    const response = await fetch(probeUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        healthy: false,
        configured_ws_endpoint: configuredWsEndpoint,
        probe_url: probeUrl,
        error: `Browser endpoint returned HTTP ${response.status}`,
      };
    }

    const payload = await response.json();
    return {
      healthy: true,
      configured_ws_endpoint: configuredWsEndpoint,
      probe_url: probeUrl,
      reported_ws_endpoint: payload?.webSocketDebuggerUrl || '',
      browser: payload?.Browser || '',
    };
  } catch (error) {
    return {
      healthy: false,
      configured_ws_endpoint: configuredWsEndpoint,
      probe_url: probeUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
