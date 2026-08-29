// Z-safe timestamp parsing/formatting (plan T33).
//
// The API now emits ISO-8601 UTC stamps ending in `Z`. These helpers are the
// single parsing path for wire timestamps so a stamp without timezone info
// (legacy payload, cache) is still interpreted AS UTC — never browser-local —
// keeping displayed wall-clock times stable across timezones.

/**
 * Parse a wire timestamp into a Date (or null when unparseable).
 * Handles: Date instances, epoch seconds/ms numbers and numeric strings,
 * ISO strings with Z/offset, and naive ISO strings (assumed UTC).
 */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Heuristic: values below 1e12 can't be ms since epoch -> seconds.
    return new Date(Math.abs(value) < 1e12 ? value * 1000 : value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return new Date(String(Math.abs(n)).length <= 10 ? n * 1000 : n);
  }
  let candidate = trimmed;
  // Naive ISO (no zone designator): treat as UTC.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(candidate)) {
    candidate = `${candidate.replace(" ", "T")}Z`;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Full local display string, or "" when unparseable. */
export function formatTimestamp(value, options) {
  const date = parseTimestamp(value);
  return date ? date.toLocaleString(undefined, options) : "";
}

/** Local time-of-day display, or "" when unparseable. */
export function formatTime(value) {
  const date = parseTimestamp(value);
  return date ? date.toLocaleTimeString() : "";
}

/** Local date display, or "" when unparseable. */
export function formatDate(value) {
  const date = parseTimestamp(value);
  return date ? date.toLocaleDateString() : "";
}
