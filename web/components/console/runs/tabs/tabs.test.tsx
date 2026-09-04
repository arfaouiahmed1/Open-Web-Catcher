import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SitesTab } from "./sites-tab";
import { BatchesTab } from "./batches-tab";
import { HistoryTab } from "./history-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const sitesProps = {
  sites: [{ id: 1, url: "https://example.com", language: "english", label: "piracy" }],
  siteTotal: 1,
  selectedSiteIds: [1],
  onSelectSiteIds: () => {},
  query: "example",
  onQueryChange: () => {},
  language: "english",
  onLanguageChange: () => {},
  label: "piracy",
  onLabelChange: () => {},
  languages: ["english", "arabic"],
  labels: ["piracy", "sports"],
  onResetFilters: () => {},
  isLoading: false,
  actionError: "",
  busyAction: "",
  healthMap: {},
  healthCheckedAt: "",
  healthCheckScope: "all",
  onHealthCheckScopeChange: () => {},
  onCheckHealth: () => {},
  isHealthChecking: false,
  onHealthSelection: () => {},
  onOpenCreate: () => {},
  onOpenDetail: () => {},
  onOpenEdit: () => {},
  onRunBatch: () => {},
  onRunSelected: () => {},
  onRunFiltered: () => {},
  onDeleteSelected: () => {},
  onDeleteDown: () => {},
  onDeleteSite: () => {},
  onUpdateSite: () => {},
  onBulkUpdate: async () => {},
  onToggleAllVisible: () => {},
  pricingMap: null,
};

describe("Runs tabs (T43)", () => {
  it("SitesTab renders the unified dataset manager via props", () => {
    const markup = html(<SitesTab {...sitesProps} />);
    expect(markup).toContain("Total Websites");
    expect(markup).toContain("Working / Live");
    expect(markup).toContain("Down / Dead");
    expect(markup).toContain("Last Health Check");
    expect(markup).toContain("https://example.com");
    expect(markup).toContain("Website dataset");
    expect(markup).toContain("Check health");
    expect(markup).toContain("Run selected (1)");
    expect(markup).toContain("Bulk edit (1)");
    expect(markup).toContain("Run all filtered");
  });

  it("SitesTab surfaces health pills and counts from the health map", () => {
    const markup = html(
      <SitesTab
        {...sitesProps}
        healthMap={{
          1: { working: true, status: "working", http_status: 200, latency_ms: 320 },
        }}
        healthCheckedAt={new Date(Date.now() - 14 * 60 * 1000).toISOString()}
      />
    );
    expect(markup).toContain("working");
    expect(markup).toContain("1 working");
  });

  it("BatchesTab shows batch list via StatusBadge", () => {
    const markup = html(
      <BatchesTab
        batches={[{ batch_id: "batch-1234567890", status: "running" }]}
        selectedBatchId="batch-1234567890"
        onSelect={() => {}}
        detail={{ batch_id: "batch-1234567890" }}
        isLoading={false}
        onRefresh={() => {}}
      />
    );
    expect(markup).toContain("Batches");
    expect(markup).toContain("running");
  });

  it("HistoryTab renders virtualized slice with MetricCards", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ run_id: `run-${i}`, final_status: "success", stream_count: i }));
    const markup = html(
      <HistoryTab
        rows={rows}
        total={30}
        status="success"
        onStatusChange={() => {}}
        query=""
        onQueryChange={() => {}}
        page={0}
        onPageChange={() => {}}
        pageSize={25}
        isLoading={false}
        onRefresh={() => {}}
      />
    );
    expect(markup).toContain("History total");
    expect(markup).toContain("30");
    expect(markup).toContain("Run history");
    // virtualized — only pageSize rows rendered + next/prev controls
    expect(markup).toContain("Prev");
    expect(markup).toContain("Next");
  });
});
