"use client";

import * as React from "react";
import { Layers, RefreshCw } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { StatusBadge } from "@/components/library/StatusBadge";
import { EmptyState } from "@/components/console/common/empty-state";
import { LoadingView } from "@/components/console/common/loading-view";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface BatchesTabProps {
  batches: Array<Record<string, unknown>>;
  selectedBatchId: string;
  onSelect: (id: string) => void;
  detail: Record<string, unknown> | null;
  isLoading: boolean;
}

function statusToneForBadge(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  const s = String(status || "").toLowerCase();
  if (["success", "completed", "done"].includes(s)) return "success";
  if (["failed", "failure", "error", "cancelled"].includes(s)) return "danger";
  if (["running", "queued", "retrying", "leased"].includes(s)) return "info";
  if (["partial"].includes(s)) return "warning";
  return "neutral";
}

const BatchRow = React.memo(function BatchRow({ batch, active, onSelect }: { batch: Record<string, unknown>; active: boolean; onSelect: (id: string) => void }) {
  const id = String(batch.batch_id || "");
  const status = String(batch.status || "queued");
  return (
    <button
      onClick={() => onSelect(id)}
      className={`flex w-full items-center justify-between gap-2 border-b px-3 py-2.5 text-left last:border-0 transition-colors hover:bg-muted/40 ${active ? "bg-muted/60 ring-inset ring-1 ring-border" : ""}`}
      style={{ borderColor: "var(--line)" }}
    >
      <span className="min-w-0 truncate font-mono text-xs">{id.slice(0, 16)}…</span>
      <StatusBadge label={status} tone={statusToneForBadge(status)} />
    </button>
  );
});

export function BatchesTab({ batches, selectedBatchId, onSelect, detail, isLoading }: BatchesTabProps) {
  if (isLoading) return <LoadingView label="Loading batches…" variant="skeleton" rows={4} />;
  if (!batches.length) return <EmptyState tone="default" title="No batches yet" description="Create one from Websites — select sites and run a batch pipeline. Batches are SSE-observed, not polled." action={<Button variant="outline" size="sm" onClick={() => onSelect("")}>Refresh</Button>} />;
  const activeBatch = batches.find((b) => String(b.batch_id) === selectedBatchId) || batches[0];

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)] animate-fade-up">
      <SectionPanel title="Batches" description={`${batches.length} batch${batches.length === 1 ? "" : "es"} · selected ${String(activeBatch?.batch_id || "").slice(0, 8)}…`} icon={<Layers className="h-3.5 w-3.5" />}>
        <div className="overflow-hidden rounded-lg border">
          {batches.map((b) => (
            <BatchRow key={String(b.batch_id)} batch={b} active={String(b.batch_id) === String(activeBatch?.batch_id)} onSelect={onSelect} />
          ))}
        </div>
      </SectionPanel>

      <SectionPanel
        title={`Batch ${String(activeBatch?.batch_id || "").slice(0, 16)}…`}
        description="JSON detail is capped (payload_cap_bytes) and streamed via run stream — no polling."
        actions={<Badge tone="muted" className="font-mono text-[10px]">{String(activeBatch?.status || "—")}</Badge>}
      >
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={String(activeBatch?.status || "—")} tone={statusToneForBadge(String(activeBatch?.status || ""))} />
            <span className="font-mono text-xs text-muted-foreground">{String(activeBatch?.created_at || "")}</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw className="h-3 w-3" /> SSE live</span>
          </div>
          {detail ? (
            <pre className="max-h-[480px] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(detail, null, 2)}</pre>
          ) : (
            <EmptyState tone="default" title="Select a batch" description="Choose a batch on the left to view its JSON detail (capped & live)." />
          )}
          <Button variant="outline" size="sm" onClick={() => onSelect(String(activeBatch?.batch_id || ""))} disabled={!activeBatch}>
            Refresh
          </Button>
        </div>
      </SectionPanel>
    </div>
  );
}
