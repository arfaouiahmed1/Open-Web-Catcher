import assert from "node:assert/strict";
import test from "node:test";

import {
  isAdjustedSuccessStatus,
  statusMetricBucket,
  summarizeStatusMetrics,
} from "./dataset-runs.js";

test("classifies dataset run statuses into adjusted metric buckets", () => {
  assert.equal(statusMetricBucket("success"), "productive_success");
  assert.equal(statusMetricBucket("partial"), "productive_success");
  assert.equal(statusMetricBucket("page_inaccessible"), "external_or_expected_blocker");
  assert.equal(statusMetricBucket("site_dead"), "external_or_expected_blocker");
  assert.equal(statusMetricBucket("no_streams"), "external_or_expected_blocker");
  assert.equal(statusMetricBucket("no_hosting_pages"), "external_or_expected_blocker");
  assert.equal(statusMetricBucket("failed"), "agent_failure");
  assert.equal(statusMetricBucket("timeout"), "agent_failure");
  assert.equal(statusMetricBucket("redirect"), "agent_failure");
  assert.equal(statusMetricBucket("cancelled"), "cancelled");
  assert.equal(isAdjustedSuccessStatus("no_streams"), true);
  assert.equal(isAdjustedSuccessStatus("timeout"), false);
});

test("summarizes visible rows with agent failures separated from site blockers", () => {
  const metrics = summarizeStatusMetrics([
    { final_status: "success" },
    { final_status: "page_inaccessible" },
    { final_status: "no_streams" },
    { final_status: "failed" },
    { final_status: "cancelled" },
    { status: "running" },
  ]);

  assert.equal(metrics.terminal_count, 5);
  assert.equal(metrics.terminal_non_cancelled_count, 4);
  assert.equal(metrics.productive_success_count, 1);
  assert.equal(metrics.external_blocked_count, 2);
  assert.equal(metrics.agent_failed_count, 1);
  assert.equal(metrics.strict_failed_count, 3);
  assert.equal(metrics.success_rate, 20);
  assert.equal(metrics.adjusted_success_rate, 75);
});
