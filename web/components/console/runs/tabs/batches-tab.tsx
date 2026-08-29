"use client";

import { MetricCard } from "@/components/library/MetricCard";
import { StatusBadge } from "@/components/library/StatusBadge";

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

function BatchRow({ batch, active, onSelect }: { batch: Record<string, unknown>; active: boolean; onSelect: (id: string) => void }) {
  const id = String(batch.batch_id || "");
  const status = String(batch.status || "queued");
  return (
    <button
      onClick={() => onSelect(id)}
      className={`flex w-full items-center justify-between gap-2 border-b px-3 py-2.5 text-left last:border-0 hover:bg-muted/50 ${active ? "bg-muted" : ""}`}
      style={{ borderColor: "var(--line)" }}
    >
      <span className="min-w-0 truncate font-mono text-xs">{id.slice(0, 16)}…</span>
      <StatusBadge label={status} tone={statusToneForBadge(status)} />
    </button>
  );
}

export function BatchesTab({ batches, selectedBatchId, onSelect, detail, isLoading }: BatchesTabProps) {
  if (isLoading) return <MetricCard label="Batches" state="loading" />;
  if (!batches.length) return <MetricCard label="Batches" value="—" state="empty" emptyLabel="No batches yet — create one from Websites." />;
  const activeBatch = batches.find((b) => String(b.batch_id) === selectedBatchId) || batches[0];

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-lg border">
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
          <span className="text-sm font-semibold">Batches</span>
        </div>
        <div>
          {batches.map((b) => (
            <BatchRow key={String(b.batch_id)} batch={b} active={String(b.batch_id) === String(activeBatch?.batch_id)} onSelect={onSelect} />
          ))}
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
          <span className="text-sm font-semibold">Batch {String(activeBatch?.batch_id || "").slice(0, 16)}…</span>
        </div>
        <div className="space-y-3 p-3 text-sm">
          <div className="flex gap-2">
            <span className="rounded-full border px-2 py-0.5 text-xs">{String(activeBatch?.status || "—")}</span>
            <span className="text-muted-foreground text-xs">{String(activeBatch?.created_at || "")}</span>
          </div>
          {detail ? (
            <pre className="max-h-[480px] overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(detail, null, 2)}</pre>
          ) : (
            <p className="text-muted-foreground">Select a batch to view detail.</p>
          )}
          <button onClick={() => onSelect(String(activeBatch?.batch_id || ""))} disabled={!activeBatch} className="rounded border px-3 py-1 text-xs disabled:opacity-50">
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
