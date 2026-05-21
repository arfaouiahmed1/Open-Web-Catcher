export function decodeUriStringSafe(value) {
  const text = String(value ?? "");
  if (!text || text.startsWith("data:")) return text;
  if (!/%[0-9a-fA-F]{2}/.test(text) && !text.includes("+")) return text;

  const candidates = text.includes("+") ? [text.replace(/\+/g, "%20"), text] : [text];
  for (const candidate of candidates) {
    for (const decoder of [decodeURIComponent, decodeURI]) {
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

export function normalizeStructuredValueForDisplay(value, seen = new WeakSet()) {
  let parsed = value;
  if (typeof value === "string") {
    const decoded = decodeUriStringSafe(value);
    const trimmed = decoded.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = decoded;
      }
    } else {
      parsed = decoded;
    }
  }
  if (parsed == null || typeof parsed !== "object") return parsed;
  if (seen.has(parsed)) return parsed;
  seen.add(parsed);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizeStructuredValueForDisplay(entry, seen));
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, nested]) => [
      key,
      normalizeStructuredValueForDisplay(nested, seen),
    ]),
  );
}

function primitiveLabel(value) {
  if (value == null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value || '""';
  return String(value);
}

function summarizeValue(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  return primitiveLabel(value);
}

function isFilteredEmpty(value) {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function filterStructuredValueForDisplay(value, term) {
  const query = String(term || "").trim().toLowerCase();
  if (!query) return value;
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return primitiveLabel(value).toLowerCase().includes(query) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => {
        const direct = [`[${index}]`, summarizeValue(entry)].join(" ").toLowerCase().includes(query);
        if (direct) return entry;
        const filtered = filterStructuredValueForDisplay(entry, query);
        return isFilteredEmpty(filtered) ? undefined : entry;
      })
      .filter((entry) => entry !== undefined);
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, nested]) => {
        const direct = [key, summarizeValue(nested)].join(" ").toLowerCase().includes(query);
        if (direct) return [key, nested];
        const filtered = filterStructuredValueForDisplay(nested, query);
        return filtered === undefined ? null : [key, filtered];
      })
      .filter(Boolean),
  );
}

export function buildStructuredTableRows(value, limit = 0) {
  const cap = Number(limit || 0);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [`[${index}]`, entry])
    : value && typeof value === "object"
      ? Object.entries(value)
      : [["$", value]];
  return entries.slice(0, cap > 0 ? cap : entries.length).map(([path, nested]) => ({
    path,
    type: Array.isArray(nested) ? "array" : nested === null ? "null" : typeof nested,
    summary: summarizeValue(nested),
    value: nested,
  }));
}
