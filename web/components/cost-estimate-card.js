"use client";

import { useEffect, useMemo, useState } from "react";

import { formatCurrency, formatNumber } from "@/lib/utils";
import { estimateRunCost, loadPricing } from "@/lib/pricing";

function Bar({ label, value, total, color }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span style={{ color: "var(--mute-2)" }}>{label}</span>
        <span className="font-mono" style={{ color: "var(--ink-dim)" }}>
          {formatCurrency(value)}{" "}
          <span style={{ color: "var(--mute-3)" }}>· {pct.toFixed(0)}%</span>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: "var(--line)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

export function CostEstimateCard({ llmCalls = [], compact = false }) {
  const [pricingMap, setPricingMap] = useState(null);

  useEffect(() => {
    let alive = true;
    loadPricing().then((map) => {
      if (alive) setPricingMap(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  const totals = useMemo(
    () => estimateRunCost(llmCalls, pricingMap),
    [llmCalls, pricingMap],
  );

  const coverage =
    totals.calls > 0 ? Math.round((totals.computed / totals.calls) * 100) : 0;

  if (compact) {
    return (
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-[16px] font-semibold"
          style={{ color: "var(--mint)" }}
        >
          {formatCurrency(totals.total)}
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "var(--mute-2)" }}
        >
          est. cost
        </span>
        {totals.calls > 0 ? (
          <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
            {coverage}% priced
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="rounded-[12px] border p-4"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "var(--mute-2)" }}
          >
            Estimated Cost
          </span>
          <div
            className="mt-0.5 font-mono text-2xl font-semibold"
            style={{ color: "var(--mint)" }}
          >
            {formatCurrency(totals.total)}
          </div>
        </div>
        <div className="text-right text-[10px]" style={{ color: "var(--mute-3)" }}>
          <div>
            {formatNumber(totals.calls)} call{totals.calls === 1 ? "" : "s"}
          </div>
          <div>{coverage}% priced</div>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <Bar
          label="Input (new)"
          value={totals.input}
          total={totals.total}
          color="var(--signal)"
        />
        <Bar
          label="Cached read"
          value={totals.cached}
          total={totals.total}
          color="var(--violet)"
        />
        {totals.cacheWrite > 0 ? (
          <Bar
            label="Cache write"
            value={totals.cacheWrite}
            total={totals.total}
            color="var(--sky)"
          />
        ) : null}
        <Bar
          label="Output"
          value={totals.output}
          total={totals.total}
          color="var(--mint)"
        />
      </div>

      {pricingMap && pricingMap.size === 0 ? (
        <div
          className="mt-3 rounded-lg px-2.5 py-1.5 text-[10.5px]"
          style={{
            background: "color-mix(in oklch, var(--rose) 10%, transparent)",
            color: "var(--rose)",
          }}
        >
          No pricing data loaded. Sync pricing in settings.
        </div>
      ) : null}
    </div>
  );
}
