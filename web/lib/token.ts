/**
 * Typed seed for the operator-console auth-token contract.
 *
 * Mirrors the storage behavior of `lib/api.js` (`owc_token` key, empty-string
 * fallback when storage is unavailable or the token is absent) so the Bearer
 * attach path can migrate onto this module without changing runtime behavior.
 *
 * The token is a compact JWT: `<header>.<payload>.<signature>` where the
 * payload segment is base64url-encoded JSON shaped `{ sub, role, exp }`.
 * All parsing here is defensive: malformed input yields `null` / `false`,
 * never a throw.
 */

export const TOKEN_STORAGE_KEY = "owc_token";

/** Narrow shape the backend issues inside the JWT payload. */
export interface TokenPayload {
  /** Subject: operator identifier. */
  sub: string;
  /** Role claim used by backend authorization. */
  role: string;
  /** Expiry as a UNIX timestamp in seconds. */
  exp: number;
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    // Storage access can throw in privacy modes / embedded contexts.
    return null;
  }
}

/**
 * Reads the stored token. Returns "" when unavailable (SSR, disabled storage,
 * or unset) — matching the `lib/api.js` contract.
 */
export function getToken(): string {
  const storage = safeLocalStorage();
  if (!storage) return "";
  try {
    return storage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/** Persists the token. No-op when storage is unavailable or write fails. */
export function setToken(token: string): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Quota exceeded / storage disabled: token stays session-only.
  }
}

/** Removes the stored token. No-op when storage is unavailable. */
export function clearToken(): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clear if storage rejects access.
  }
}

/**
 * Structural check on an already-decoded payload object:
 * exactly `{ sub: string; role: string; exp: number }` with a finite `exp`.
 */
export function isTokenPayloadShaped(value: unknown): value is TokenPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sub === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.exp === "number" &&
    Number.isFinite(candidate.exp)
  );
}

/** Decodes one base64url segment to UTF-8 text, or null on any failure. */
function base64UrlDecode(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded =
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) return null;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parses a compact JWT and returns its payload when it has exactly three
 * dot-separated segments and the decoded payload matches `TokenPayload`.
 * Returns null for anything else — garbage in, null out.
 */
export function parseTokenPayload(token: string): TokenPayload | null {
  if (typeof token !== "string") return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [header, payloadSegment, signature] = segments;
  if (!header || !payloadSegment || !signature) return null;

  const raw = base64UrlDecode(payloadSegment);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isTokenPayloadShaped(parsed) ? parsed : null;
}

/**
 * End-to-end validity check for a stored token string: correct JWT structure,
 * decodable payload, and the narrow `{ sub, role, exp }` shape.
 */
export function isTokenShaped(token: string): boolean {
  return parseTokenPayload(token) !== null;
}
