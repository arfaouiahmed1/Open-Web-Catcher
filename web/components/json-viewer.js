import { safeJson } from "@/lib/utils";

export function JsonViewer({ value, label }) {
  const isEmpty = !value || (typeof value === "object" && Object.keys(value).length === 0);
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
        <pre className="p-4 text-xs font-mono text-slate-300 overflow-auto max-h-96 leading-relaxed">
          {safeJson(value)}
        </pre>
      )}
    </div>
  );
}
