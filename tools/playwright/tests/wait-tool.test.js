/**
 * wait-tool.test.js — Unit and mock tests for tools/playwright/tools/wait.js.
 * Run with: node --test tests/wait-tool.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wait } from '../tools/wait.js';

function createMockPage({
  innerText = 'Hello World',
  selectorMatches = false,
  mediaPlaying = false,
  inFlight = 0,
} = {}) {
  return {
    url: () => 'https://example.com/test',
    title: async () => 'Test Page',
    evaluate: async (fn, arg) => {
      if (typeof fn === 'function') {
        // Evaluate simulated page state
        return fn(arg);
      }
      return true;
    },
  };
}

describe('wait tool', () => {
  it('duration condition resolves after elapsed time', async () => {
    const mockPage = createMockPage();
    const session = {
      page: mockPage,
      pageStateTracker: {
        getPageState: async () => ({ id: 'ps-1', dom_epoch: 1, url: 'https://example.com', title: 'T', frame_path: 'root', captured_at: new Date().toISOString() }),
      },
      networkLedger: { inFlightCount: 0 },
    };

    const start = Date.now();
    const res = await wait({
      condition: 'duration',
      value: '200',
      timeout_ms: 500,
      browserSession: session,
    });
    const elapsed = Date.now() - start;

    assert.equal(res.ok, true);
    assert.equal(res.data.condition, 'duration');
    assert.equal(res.data.matched, true);
    assert.ok(elapsed >= 180, `Expected elapsed >= 180ms, got ${elapsed}ms`);
  });

  it('rejects invalid condition with ERR_INVALID_TOOL_INPUT', async () => {
    const res = await wait({ condition: 'invalid_condition' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ERR_INVALID_TOOL_INPUT');
  });

  it('selector_visible returns matched: false on timeout without error', async () => {
    const mockPage = {
      url: () => 'https://example.com',
      title: async () => 'T',
      evaluate: async () => false, // element not found
    };
    const session = {
      page: mockPage,
      pageStateTracker: {
        getPageState: async () => ({ id: 'ps-1', dom_epoch: 1, url: 'https://example.com', title: 'T', frame_path: 'root', captured_at: new Date().toISOString() }),
      },
      networkLedger: { inFlightCount: 0 },
    };

    const res = await wait({
      condition: 'selector_visible',
      value: '.nonexistent-element',
      timeout_ms: 200,
      poll_ms: 50,
      browserSession: session,
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.matched, false);
    assert.equal(res.error, null);
  });

  it('media_playing condition detects when video plays', async () => {
    const mockPage = {
      url: () => 'https://example.com',
      title: async () => 'T',
      evaluate: async () => true, // video readyState >= 3
    };
    const session = {
      page: mockPage,
      pageStateTracker: {
        getPageState: async () => ({ id: 'ps-1', dom_epoch: 1, url: 'https://example.com', title: 'T', frame_path: 'root', captured_at: new Date().toISOString() }),
      },
      networkLedger: { inFlightCount: 0 },
    };

    const res = await wait({
      condition: 'media_playing',
      timeout_ms: 200,
      poll_ms: 50,
      browserSession: session,
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.matched, true);
  });

  it('network_quiet resolves when inFlightCount is 0', async () => {
    const mockPage = {
      url: () => 'https://example.com',
      title: async () => 'T',
    };
    const session = {
      page: mockPage,
      pageStateTracker: {
        getPageState: async () => ({ id: 'ps-1', dom_epoch: 1, url: 'https://example.com', title: 'T', frame_path: 'root', captured_at: new Date().toISOString() }),
      },
      networkLedger: { inFlightCount: 0 },
    };

    const res = await wait({
      condition: 'network_quiet',
      timeout_ms: 1500,
      poll_ms: 200,
      browserSession: session,
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.matched, true);
  });
});
