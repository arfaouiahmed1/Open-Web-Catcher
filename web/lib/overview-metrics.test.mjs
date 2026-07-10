import assert from "node:assert/strict";
import test from "node:test";

import {
  isOverviewRateDroppingStatus,
  overviewFailureOnlySuccessRate,
} from "./overview-metrics.js";

test("overview success rate only drops for explicit failures", () => {
  const summary = {
    terminal_runs: 9,
    success_rate: 1 / 9,
    status_breakdown: {
      success: 1,
      partial: 1,
      no_streams: 1,
      no_hosting_pages: 1,
      page_inaccessible: 1,
      timeout: 1,
      site_dead: 1,
      cancelled: 1,
      failed: 1,
    },
  };

  assert.equal(overviewFailureOnlySuccessRate(summary), 8 / 9);
});

test("overview blockers and cancellations do not lower the rate", () => {
  const summary = {
    terminal_runs: 7,
    success_rate: 0,
    status_breakdown: {
      partial: 1,
      no_streams: 1,
      no_hosting_pages: 1,
      page_inaccessible: 1,
      timeout: 1,
      site_dead: 1,
      cancelled: 1,
    },
  };

  assert.equal(overviewFailureOnlySuccessRate(summary), 1);
});

test("overview excludes llm provider blockers from failed runs", () => {
  const summary = {
    terminal_runs: 10,
    status_breakdown: {
      success: 3,
      partial: 2,
      failed: 5,
    },
    llm_provider_blocked_runs: 3,
  };

  assert.equal(overviewFailureOnlySuccessRate(summary), 5 / 7);
});

test("overview treats all provider-blocked failures as non-dropping", () => {
  const summary = {
    terminal_runs: 2,
    status_breakdown: {
      failed: 2,
    },
    llm_provider_blocked_runs: 2,
  };

  assert.equal(overviewFailureOnlySuccessRate(summary), 1);
});

test("overview failure status matching is explicit", () => {
  assert.equal(isOverviewRateDroppingStatus("Failed"), true);
  assert.equal(isOverviewRateDroppingStatus("failure"), true);
  assert.equal(isOverviewRateDroppingStatus("timeout"), false);
  assert.equal(isOverviewRateDroppingStatus("site dead"), false);
  assert.equal(isOverviewRateDroppingStatus("no-streams"), false);
});

test("overview metric falls back safely without a status breakdown", () => {
  assert.equal(overviewFailureOnlySuccessRate({ success_rate: 0.352 }), 0.352);
  assert.equal(
    overviewFailureOnlySuccessRate({
      status_breakdown: { running: 2, queued: 1 },
    }),
    0,
  );
});
