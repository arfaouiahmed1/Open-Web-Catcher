/**
 * tool-envelope.test.js
 *
 * Contract tests for tools/playwright/shared/tool-envelope.js.
 * Run with: node --test tests/tool-envelope.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_SCHEMA_VERSION,
  successEnvelope,
  errorEnvelope,
} from '../shared/tool-envelope.js';

// ---------------------------------------------------------------------------
// Schema version constant
// ---------------------------------------------------------------------------

describe('TOOL_SCHEMA_VERSION', () => {
  it('equals owc.browser-tool.v2', () => {
    assert.equal(TOOL_SCHEMA_VERSION, 'owc.browser-tool.v2');
  });
});

// ---------------------------------------------------------------------------
// successEnvelope
// ---------------------------------------------------------------------------

describe('successEnvelope', () => {
  const basePageState = {
    id: 'ps-abc',
    dom_epoch: 3,
    url: 'https://example.com/',
    title: 'Example',
    frame_path: 'root',
    captured_at: '2026-01-01T00:00:00.000Z',
  };

  it('sets ok=true and error=null', () => {
    const env = successEnvelope({
      tool: 'inspect',
      page_state: basePageState,
      telemetry: { duration_ms: 42 },
    });
    assert.equal(env.ok, true);
    assert.equal(env.error, null);
  });

  it('sets schema_version correctly', () => {
    const env = successEnvelope({ tool: 'navigate', page_state: basePageState, telemetry: {} });
    assert.equal(env.schema_version, 'owc.browser-tool.v2');
  });

  it('auto-generates request_id when omitted', () => {
    const env = successEnvelope({ tool: 'wait', page_state: basePageState, telemetry: {} });
    assert.match(env.request_id, /^[0-9a-f-]{36}$/i);
  });

  it('preserves caller-supplied request_id', () => {
    const env = successEnvelope({
      tool: 'screenshot',
      request_id: 'req-123',
      page_state: basePageState,
      telemetry: {},
    });
    assert.equal(env.request_id, 'req-123');
  });

  it('normalizes proof: all missing fields default to null', () => {
    const env = successEnvelope({
      tool: 'inspect',
      page_state: basePageState,
      telemetry: {},
    });
    assert.equal(env.proof.before_screenshot_ref, null);
    assert.equal(env.proof.after_screenshot_ref, null);
    assert.equal(env.proof.observed_change, null);
    assert.equal(env.proof.access_state, null);
    assert.equal(env.proof.media_state, null);
    assert.equal(env.proof.network_evidence, null);
  });

  it('preserves non-null proof fields', () => {
    const env = successEnvelope({
      tool: 'navigate',
      page_state: basePageState,
      proof: {
        before_screenshot_ref: 'blobref:abc123456789',
        after_screenshot_ref: 'blobref:def987654321',
        observed_change: 'navigation',
        access_state: 'open',
      },
      telemetry: {},
    });
    assert.equal(env.proof.before_screenshot_ref, 'blobref:abc123456789');
    assert.equal(env.proof.after_screenshot_ref, 'blobref:def987654321');
    assert.equal(env.proof.observed_change, 'navigation');
    assert.equal(env.proof.access_state, 'open');
  });

  it('normalizes page_state fields', () => {
    const env = successEnvelope({
      tool: 'harvest',
      page_state: basePageState,
      telemetry: {},
    });
    assert.equal(env.page_state.id, 'ps-abc');
    assert.equal(env.page_state.dom_epoch, 3);
    assert.equal(env.page_state.url, 'https://example.com/');
    assert.equal(env.page_state.frame_path, 'root');
  });

  it('fills missing page_state fields with safe defaults', () => {
    const env = successEnvelope({ tool: 'wait', page_state: {}, telemetry: {} });
    assert.equal(env.page_state.id, '');
    assert.equal(env.page_state.dom_epoch, 0);
    assert.equal(env.page_state.url, '');
    assert.equal(env.page_state.frame_path, 'root');
    assert.ok(typeof env.page_state.captured_at === 'string');
  });

  it('normalizes telemetry defaults', () => {
    const env = successEnvelope({ tool: 'inspect', page_state: basePageState, telemetry: {} });
    assert.equal(env.telemetry.duration_ms, 0);
    assert.equal(env.telemetry.cache_hit, false);
    assert.equal(env.telemetry.attempts, 1);
    assert.equal(env.telemetry.payload_bytes, 0);
    assert.equal(env.telemetry.truncated, false);
  });

  it('preserves telemetry fields when supplied', () => {
    const env = successEnvelope({
      tool: 'inspect',
      page_state: basePageState,
      telemetry: { duration_ms: 250, cache_hit: true, attempts: 2, payload_bytes: 4096, truncated: true },
    });
    assert.equal(env.telemetry.duration_ms, 250);
    assert.equal(env.telemetry.cache_hit, true);
    assert.equal(env.telemetry.attempts, 2);
    assert.equal(env.telemetry.payload_bytes, 4096);
    assert.equal(env.telemetry.truncated, true);
  });

  it('sets pagination to null when not provided', () => {
    const env = successEnvelope({ tool: 'inspect', page_state: basePageState, telemetry: {} });
    assert.equal(env.pagination, null);
  });

  it('normalizes pagination when provided', () => {
    const env = successEnvelope({
      tool: 'inspect',
      page_state: basePageState,
      telemetry: {},
      pagination: { cursor: 'tok-42', has_more: true, returned: 50, total: 200 },
    });
    assert.equal(env.pagination.cursor, 'tok-42');
    assert.equal(env.pagination.has_more, true);
    assert.equal(env.pagination.returned, 50);
    assert.equal(env.pagination.total, 200);
  });

  it('includes data field', () => {
    const data = { items: [1, 2, 3] };
    const env = successEnvelope({ tool: 'inspect', page_state: basePageState, telemetry: {}, data });
    assert.deepEqual(env.data, data);
  });
});

// ---------------------------------------------------------------------------
// errorEnvelope
// ---------------------------------------------------------------------------

describe('errorEnvelope', () => {
  it('sets ok=false', () => {
    const env = errorEnvelope({
      tool: 'interact',
      code: 'ERR_ELEMENT_NOT_FOUND',
      message: 'No element matched the locator chain',
    });
    assert.equal(env.ok, false);
  });

  it('sets schema_version', () => {
    const env = errorEnvelope({ tool: 'navigate', code: 'ERR_TOOL_TIMEOUT', message: 'Timed out' });
    assert.equal(env.schema_version, 'owc.browser-tool.v2');
  });

  it('populates error block', () => {
    const env = errorEnvelope({
      tool: 'interact',
      code: 'ERR_CHALLENGE_PRESENT',
      message: 'CAPTCHA detected',
      retryable: false,
      recommended_action: 'operator_handoff',
    });
    assert.equal(env.error.code, 'ERR_CHALLENGE_PRESENT');
    assert.equal(env.error.message, 'CAPTCHA detected');
    assert.equal(env.error.retryable, false);
    assert.equal(env.error.recommended_action, 'operator_handoff');
  });

  it('defaults retryable to false', () => {
    const env = errorEnvelope({ tool: 'wait', code: 'ERR_INVALID_TOOL_INPUT', message: 'Bad input' });
    assert.equal(env.error.retryable, false);
  });

  it('supports retryable=true for ERR_TOOL_TIMEOUT', () => {
    const env = errorEnvelope({
      tool: 'wait',
      code: 'ERR_TOOL_TIMEOUT',
      message: 'Timed out after 10000ms',
      retryable: true,
    });
    assert.equal(env.error.retryable, true);
  });

  it('sets data to null and pagination to null', () => {
    const env = errorEnvelope({ tool: 'harvest', code: 'ERR_TOOL_TIMEOUT', message: 'x' });
    assert.equal(env.data, null);
    assert.equal(env.pagination, null);
  });

  it('uses emptyPageState when page_state is null', () => {
    const env = errorEnvelope({ tool: 'navigate', code: 'ERR_TOOL_TIMEOUT', message: 'x' });
    assert.equal(env.page_state.id, '');
    assert.equal(env.page_state.dom_epoch, 0);
    assert.equal(env.page_state.frame_path, 'root');
  });

  it('preserves partial page_state when navigation failed mid-way', () => {
    const env = errorEnvelope({
      tool: 'navigate',
      code: 'ERR_TOOL_TIMEOUT',
      message: 'x',
      page_state: { id: 'ps-partial', url: 'https://blocked.example/' },
    });
    assert.equal(env.page_state.id, 'ps-partial');
    assert.equal(env.page_state.url, 'https://blocked.example/');
    assert.equal(env.page_state.dom_epoch, 0);
  });

  it('omits recommended_action key when not provided', () => {
    const env = errorEnvelope({
      tool: 'interact',
      code: 'ERR_ELEMENT_NOT_FOUND',
      message: 'Not found',
    });
    assert.equal('recommended_action' in env.error, false);
  });

  it('auto-generates request_id', () => {
    const env = errorEnvelope({ tool: 'screenshot', code: 'ERR_TOOL_TIMEOUT', message: 'x' });
    assert.match(env.request_id, /^[0-9a-f-]{36}$/i);
  });
});
