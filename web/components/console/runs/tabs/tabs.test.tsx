import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SitesTab } from "./sites-tab";
import { BatchesTab } from "./batches-tab";
import { HistoryTab } from "./history-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Runs tabs (T43)", () => {
  it("SitesTab renders MetricCards and respects URL-state filters via props", () => {
    const markup = html(
      <SitesTab
        sites={[{ id: 1, url: "https://example.com", language: "english" }]}
        siteTotal={1}
        selectedSiteIds={[1]}
        onSelectSiteIds={() => {}}
        query="example"
        onQueryChange={() => {}}
        language="english"
        label="piracy"
        isLoading={false}
        actionError=""
        onOpenCreate={() => {}}
        onOpenDetail={() => {}}
        onRunBatch={() => {}}
        healthMap={{}}
      />
    );
    expect(markup).toContain("Websites");
    expect(markup).toContain("https://example.com");
    expect(markup).toContain("english");
    expect(markup).toContain("Selected");
  });

  it("BatchesTab shows batch list via StatusBadge", () => {
    const markup = html(
      <BatchesTab
        batches={[{ batch_id: "batch-1234567890", status: "running" }]}
        selectedBatchId="batch-1234567890"
        onSelect={() => {}}
        detail={{ batch_id: "batch-1234567890" }}
        isLoading={false}
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
