"use client";

import { useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  FilterX,
} from "lucide-react";

import { apiFetch } from "@/lib/api";
import { filterDecisionEvents, filterDecisionItems } from "@/lib/run-detail-filters";
import { OrchestratorDecisionFeed } from "@/components/orchestrator-decision-feed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const DECISION_STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "approved", label: "Approved" },
  { value: "blocked", label: "Blocked" },
  { value: "rejected", label: "Rejected" },
];

function toneForDecisionStatus(status) {
  if (status === "approved") return "success";
  if (status === "blocked" || status === "rejected") return "danger";
  return "signal";
}

function fmtDate(value) {
  if (!value) return "just now";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function DecisionFormDialog({
  open,
  onOpenChange,
  item,
  onSave,
  isSaving,
}) {
  const [form, setForm] = useState({
    title: "",
    summary: "",
    actor: "",
    category: "",
    status: "open",
  });

  useEffect(() => {
    setForm({
      title: item?.title || "",
      summary: item?.summary || "",
      actor: item?.actor || "",
      category: item?.category || "",
      status: item?.status || "open",
    });
  }, [item, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{item ? "Edit decision" : "Log decision"}</DialogTitle>
          <DialogDescription>
            Capture routing, approval, or handoff decisions for this run.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            value={form.title}
            onChange={(event) =>
              setForm((current) => ({ ...current, title: event.target.value }))
            }
            placeholder="Decision title"
          />
          <Textarea
            value={form.summary}
            onChange={(event) =>
              setForm((current) => ({ ...current, summary: event.target.value }))
            }
            placeholder="Why this decision was made"
            rows={4}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={form.actor}
              onChange={(event) =>
                setForm((current) => ({ ...current, actor: event.target.value }))
              }
              placeholder="Actor"
            />
            <Input
              value={form.category}
              onChange={(event) =>
                setForm((current) => ({ ...current, category: event.target.value }))
              }
              placeholder="Category"
            />
          </div>
          <Select
            value={form.status}
            onChange={(value) =>
              setForm((current) => ({ ...current, status: value || "open" }))
            }
            options={DECISION_STATUS_OPTIONS}
            placeholder="Decision status"
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => onSave(form)}
            disabled={isSaving || !form.title.trim()}
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {item ? "Save changes" : "Create decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyManualState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function DecisionLogPanel({
  runId,
  initialItems = [],
  events = [],
  isStreaming = false,
  refreshToken = 0,
  sharedFilters = null,
  onSharedFiltersChange = null,
  actorOptions = [],
  stageOptions = [],
}) {
  const [items, setItems] = useState(initialItems);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  async function refresh() {
    if (!runId) return;
    setIsLoading(true);
    setError("");
    try {
      const payload = await apiFetch(`/ui/runs/${runId}/decisions`);
      setItems(Array.isArray(payload?.decisions) ? payload.decisions : []);
    } catch (nextError) {
      setError(nextError.message || "Failed to load decisions");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!runId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError("");
    apiFetch(`/ui/runs/${runId}/decisions`)
      .then((payload) => {
        if (!cancelled) {
          setItems(Array.isArray(payload?.decisions) ? payload.decisions : []);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError.message || "Failed to load decisions");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refreshToken]);

  const categories = useMemo(
    () => Array.from(new Set(items.map((item) => String(item?.category || "").trim()).filter(Boolean))).sort(),
    [items],
  );
  const statuses = useMemo(
    () => Array.from(new Set(items.map((item) => String(item?.status || "").trim()).filter(Boolean))).sort(),
    [items],
  );
  const filteredItems = useMemo(
    () => filterDecisionItems(items, sharedFilters || {}, {
      search: searchTerm,
      source: sourceFilter,
      category: categoryFilter,
      status: statusFilter,
    }),
    [categoryFilter, items, searchTerm, sharedFilters, sourceFilter, statusFilter],
  );
  const filteredEvents = useMemo(
    () => filterDecisionEvents(events, sharedFilters || {}, {
      search: searchTerm,
      source: sourceFilter,
    }),
    [events, searchTerm, sharedFilters, sourceFilter],
  );
  const autoCount = useMemo(
    () => items.filter((item) => item?.details?.source === "agent_auto").length,
    [items],
  );
  const hasFilters = Boolean(
    searchTerm ||
      sourceFilter ||
      categoryFilter ||
      statusFilter ||
      sharedFilters?.actor ||
      sharedFilters?.stage,
  );

  async function save(form) {
    if (!runId) return;
    setIsSaving(true);
    setError("");
    try {
      const path = editing
        ? `/ui/runs/${runId}/decisions/${editing.id}`
        : `/ui/runs/${runId}/decisions`;
      const method = editing ? "PATCH" : "POST";
      await apiFetch(path, {
        method,
        body: JSON.stringify({ ...form, details: editing?.details || {} }),
      });
      setOpen(false);
      setEditing(null);
      await refresh();
    } catch (nextError) {
      setError(nextError.message || "Failed to save decision");
    } finally {
      setIsSaving(false);
    }
  }

  async function remove(item) {
    if (!runId) return;
    setError("");
    try {
      await apiFetch(`/ui/runs/${runId}/decisions/${item.id}`, {
        method: "DELETE",
      });
      await refresh();
    } catch (nextError) {
      setError(nextError.message || "Failed to delete decision");
    }
  }

  function resetFilters() {
    setSearchTerm("");
    setSourceFilter("");
    setCategoryFilter("");
    setStatusFilter("");
    onSharedFiltersChange?.({ actor: "", stage: "" });
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden shadow-card">
        <CardHeader className="space-y-3 border-b px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">Decision log</CardTitle>
              <CardDescription>
                Manual operator notes and trace-observed orchestration decisions.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {autoCount > 0 ? <Badge tone="signal">{autoCount} auto</Badge> : null}
              <Badge tone="default">{filteredItems.length} manual</Badge>
              <Badge tone="default">{filteredEvents.length} observed</Badge>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                Add decision
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search title, summary, actor, category, or trace details"
              className="h-8 min-w-[220px] flex-1 text-xs"
            />
            <Select
              value={sharedFilters?.actor || ""}
              onChange={(value) => onSharedFiltersChange?.({ actor: value, stage: sharedFilters?.stage || "" })}
              options={[
                { value: "", label: "All actors" },
                ...actorOptions.map((actor) => ({ value: actor, label: actor })),
              ]}
              placeholder="Actor"
              className="min-w-[160px]"
            />
            <Select
              value={sharedFilters?.stage || ""}
              onChange={(value) => onSharedFiltersChange?.({ actor: sharedFilters?.actor || "", stage: value })}
              options={[
                { value: "", label: "All stages" },
                ...stageOptions,
              ]}
              placeholder="Stage"
              className="min-w-[160px]"
            />
            <Select
              value={sourceFilter}
              onChange={(value) => setSourceFilter(value)}
              options={[
                { value: "", label: "All sources" },
                { value: "manual", label: "Manual" },
                { value: "agent_auto", label: "Auto" },
              ]}
              placeholder="Source"
              className="min-w-[150px]"
            />
            {categories.length ? (
              <Select
                value={categoryFilter}
                onChange={(value) => setCategoryFilter(value)}
                options={[
                  { value: "", label: "All categories" },
                  ...categories.map((category) => ({ value: category, label: category })),
                ]}
                placeholder="Category"
                className="min-w-[160px]"
              />
            ) : null}
            {statuses.length ? (
              <Select
                value={statusFilter}
                onChange={(value) => setStatusFilter(value)}
                options={[
                  { value: "", label: "All statuses" },
                  ...statuses.map((status) => ({ value: status, label: status })),
                ]}
                placeholder="Status"
                className="min-w-[150px]"
              />
            ) : null}
            {hasFilters ? (
              <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={resetFilters}>
                <FilterX className="mr-1 h-3 w-3" />
                Reset
              </Button>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="space-y-3 p-4">
          {error ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-500">
              {error}
            </div>
          ) : null}
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading decisions
            </div>
          ) : filteredItems.length ? (
            filteredItems.map((item) => (
              <div
                key={item.id}
                className="rounded-xl border border-border bg-card/70 px-4 py-3"
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{item.title}</span>
                      <Badge tone={toneForDecisionStatus(item.status)}>{item.status}</Badge>
                      {item.category ? <Badge tone="default">{item.category}</Badge> : null}
                      {item.actor ? <Badge tone="warning">{item.actor}</Badge> : null}
                      {item?.details?.source === "agent_auto" ? <Badge tone="signal">auto</Badge> : <Badge tone="default">manual</Badge>}
                    </div>
                    {item.summary ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.summary}</p> : null}
                    <div className="mt-2 text-[10px] font-mono text-muted-foreground">
                      Updated {fmtDate(item.updated_at || item.created_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(item);
                        setOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(item)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <EmptyManualState
              icon={GitBranch}
              title={items.length ? "No manual decisions match the current filters" : "No logged decisions yet"}
              description="The observed trace feed below still shows runtime routing and handoff decisions."
              action={
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Log first decision
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>

      {sourceFilter !== "manual" ? (
        <Card className="overflow-hidden shadow-card">
          <CardHeader className="border-b px-4 py-4">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              <div>
                <CardTitle className="text-sm">Observed in trace</CardTitle>
                <CardDescription>
                  Live orchestrator intent and routing sequence from runtime events.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <OrchestratorDecisionFeed events={filteredEvents} isStreaming={isStreaming} />
          </CardContent>
        </Card>
      ) : null}

      <DecisionFormDialog
        open={open}
        onOpenChange={setOpen}
        item={editing}
        onSave={save}
        isSaving={isSaving}
      />
    </div>
  );
}
