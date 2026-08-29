let cachedApiBase = null;

/**
 * Resolve the configured backend once. There is deliberately no localhost
 * fallback: every runtime must declare its API origin explicitly.
 */
export function resolveApiBase() {
  if (cachedApiBase) return cachedApiBase;
  const raw =
    typeof window === "undefined"
      ? process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL
      : process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!raw || !raw.trim()) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL is required; the localhost API fallback was removed.",
    );
  }
  cachedApiBase = raw.trim().replace(/\/+$/, "");
  return cachedApiBase;
}

/** Test-only reset for environment-isolated API-base assertions. */
export function resetApiBaseCache() {
  cachedApiBase = null;
}

export const TOKEN_STORAGE_KEY = "owc_token";

export function apiUrl(path) {
  return `${resolveApiBase()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getToken() {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function eventSourceUrl(path) {
  const url = new URL(apiUrl(path));
  const token = getToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const response = await fetch(apiUrl(path), {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 401 && typeof window !== "undefined") {
    const returnPath = encodeURIComponent(
      window.location.pathname + window.location.search
    );
    window.location.href = `/login?next=${returnPath}`;
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return response.json();
}
