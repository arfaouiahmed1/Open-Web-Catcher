import { safeJson } from "@/lib/utils";

function decodeUriStringSafe(value) {
  const text = String(value ?? "");
  if (!text || text.startsWith("data:")) return text;
  if (!/%[0-9a-fA-F]{2}/.test(text) && !text.includes("+")) return text;

  const candidates = text.includes("+") ? [text.replace(/\+/g, "%20"), text] : [text];
  for (const candidate of candidates) {
    for (const decoder of [decodeURI, decodeURIComponent]) {
      try {
        const decoded = decoder(candidate);
        if (decoded) return decoded;
      } catch {
        // try next strategy
      }
    }
  }
  return text;
}

function decodeUriDeep(value, seen = new WeakSet()) {
  if (typeof value === "string") return decodeUriStringSafe(value);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return value;

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => decodeUriDeep(item, seen));
  }

  const decoded = {};
  for (const [key, nested] of Object.entries(value)) {
    decoded[key] = decodeUriDeep(nested, seen);
  }
  return decoded;
}

export function JsonViewer({ value, label }) {
  const normalized = decodeUriDeep(value);
  const isEmpty = !normalized || (typeof normalized === "object" && Object.keys(normalized).length === 0);
  return (
    <div className="rounded-xl border border-white/8 bg-black/30 overflow-hidden shadow-card">
      {label && (
        <div className="px-4 py-2.5 border-b border-white/6 text-xs font-medium text-slate-500 uppercase tracking-wider">
          {label}
        </div>
      )}
      {isEmpty ? (
        <div className="px-4 py-6 text-xs text-slate-700 text-center">Empty</div>
      ) : (
        <pre dir="auto" className="p-4 text-xs font-mono text-slate-300 overflow-auto max-h-[70vh] leading-relaxed">
          {safeJson(normalized)}
        </pre>
      )}
    </div>
  );
}
