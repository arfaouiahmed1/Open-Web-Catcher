import { safeJson } from "@/lib/utils";

export function JsonViewer({ value, label = "JSON" }) {
  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-[0.28em] text-slate-400">{label}</div>
      <pre className="max-h-[420px] overflow-auto rounded-[24px] border border-white/10 bg-black/40 p-4 text-xs text-slate-200">
        {safeJson(value)}
      </pre>
    </div>
  );
}
