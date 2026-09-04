/** Return only a same-origin in-app path suitable for post-auth navigation. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "http://owc.invalid";
  try {
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
