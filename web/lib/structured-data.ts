export function decodeUriStringSafe(value: unknown): string {
  const text = String(value ?? "");
  if (!text || text.startsWith("data:")) return text;
  if (!/%[0-9a-fA-F]{2}/.test(text) && !text.includes("+")) return text;

  const candidates = text.includes("+") ? [text.replace(/\+/g, "%20"), text] : [text];
  for (const candidate of candidates) {
    for (const decoder of [decodeURIComponent, decodeURI] as const) {
      try {
        const decoded = decoder(candidate);
        if (decoded) return decoded;
      } catch {
        // Keep trying candidates.
      }
    }
  }
  return text;
}

export function normalizeStructuredValueForDisplay(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  let parsed: unknown = value;
  if (typeof value === "string") {
    const decoded = decodeUriStringSafe(value);
    const trimmed = decoded.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        parsed = decoded;
      }
    } else {
      parsed = decoded;
    }
  }
  if (parsed == null || typeof parsed !== "object") return parsed;
  const obj = parsed as object;
  if (seen.has(obj)) return parsed;
  seen.add(obj);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizeStructuredValueForDisplay(entry, seen));
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, nested]) => [
      key,
      normalizeStructuredValueForDisplay(nested, seen),
    ]),
  );
}

function primitiveLabel(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value || '""';
  return String(value);
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") return `${Object.keys(value as Record<string, unknown>).length} field${Object.keys(value as Record<string, unknown>).length === 1 ? "" : "s"}`;
  return primitiveLabel(value);
}

function isFilteredEmpty(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

export function filterStructuredValueForDisplay(value: unknown, term: unknown): unknown {
  const query = String(term ?? "").trim().toLowerCase();
  if (!query) return value;
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return primitiveLabel(value).toLowerCase().includes(query) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map((entry, index) => {
        const direct = [`[${index}]`, summarizeValue(entry)].join(" ").toLowerCase().includes(query);
        if (direct) return entry;
        const filtered = filterStructuredValueForDisplay(entry, query);
        return isFilteredEmpty(filtered) ? undefined : entry;
      })
      .filter((entry) => entry !== undefined);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map<[string, unknown] | null>(([key, nested]) => {
        const direct = [key, summarizeValue(nested)].join(" ").toLowerCase().includes(query);
        if (direct) return [key, nested];
        const filtered = filterStructuredValueForDisplay(nested, query);
        return filtered === undefined ? null : [key, filtered as unknown];
      })
      .filter((entry): entry is [string, unknown] => entry !== null),
  );
}

export interface StructuredTableRow {
  path: string;
  type: string;
  summary: string;
  value: unknown;
}

export function buildStructuredTableRows(value: unknown, limit = 0): StructuredTableRow[] {
  const cap = Number(limit || 0);
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? (value as unknown[]).map((entry, index) => [`[${index}]`, entry] as [string, unknown])
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [["$", value]];
  return entries.slice(0, cap > 0 ? cap : entries.length).map(([path, nested]) => ({
    path,
    type: Array.isArray(nested) ? "array" : nested === null ? "null" : typeof nested,
    summary: summarizeValue(nested),
    value: nested,
  }));
}
