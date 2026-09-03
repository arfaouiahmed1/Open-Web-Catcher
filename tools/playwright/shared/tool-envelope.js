/**
 * tool-envelope.js - V2 tool response envelope for all OWC browser MCP tools.
 *
 * Every tool response (success or failure) is wrapped in this envelope so
 * callers can validate the contract without inspecting tool-specific shapes.
 *
 * Schema version: owc.browser-tool.v2
 */

import { randomUUID } from 'node:crypto';

export const TOOL_SCHEMA_VERSION = 'owc.browser-tool.v2';

/**
 * Build a success envelope.
 *
 * @param {object} opts
 * @param {string}  opts.tool          - Tool name (e.g. "navigate")
 * @param {string} [opts.request_id]   - Caller-supplied or auto-generated UUID
 * @param {object}  opts.page_state    - { id, dom_epoch, url, title, frame_path, captured_at }
 * @param {object} [opts.proof]        - Evidence refs; all fields default null
 * @param {*}      [opts.data]         - Tool-specific result payload
 * @param {object} [opts.pagination]   - { cursor, has_more, returned, total }
 * @param {object}  opts.telemetry     - { duration_ms, cache_hit, attempts, payload_bytes, truncated }
 * @returns {object} A complete v2 envelope with ok=true and error=null
 */
export function successEnvelope({
  tool,
  request_id,
  page_state,
  proof = {},
  data = null,
  pagination = null,
  telemetry = {},
}) {
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    ok: true,
    tool,
    request_id: request_id ?? randomUUID(),
    page_state: normalizePageState(page_state),
    proof: normalizeProof(proof),
    data,
    pagination: normalizePagination(pagination),
    telemetry: normalizeTelemetry(telemetry),
    error: null,
  };
}

/**
 * Build an error envelope.
 *
 * @param {object} opts
 * @param {string}  opts.tool
 * @param {string} [opts.request_id]
 * @param {object} [opts.page_state]     - May be partial/null when navigation failed
 * @param {object} [opts.proof]
 * @param {string}  opts.code            - One of the ERR_* constants
 * @param {string}  opts.message         - Human-readable error detail
 * @param {boolean} [opts.retryable]     - Whether caller should retry; default false
 * @param {string} [opts.recommended_action]
 * @param {object} [opts.telemetry]
 * @returns {object} A complete v2 envelope with ok=false and populated error
 */
export function errorEnvelope({
  tool,
  request_id,
  page_state = null,
  proof = {},
  code,
  message,
  retryable = false,
  recommended_action,
  telemetry = {},
}) {
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    ok: false,
    tool,
    request_id: request_id ?? randomUUID(),
    page_state: page_state ? normalizePageState(page_state) : emptyPageState(),
    proof: normalizeProof(proof),
    data: null,
    pagination: null,
    telemetry: normalizeTelemetry(telemetry),
    error: {
      code,
      message,
      retryable,
      ...(recommended_action != null ? { recommended_action } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizePageState(ps) {
  if (!ps) return emptyPageState();
  return {
    id: ps.id ?? '',
    dom_epoch: ps.dom_epoch ?? 0,
    url: ps.url ?? '',
    title: ps.title ?? '',
    frame_path: ps.frame_path ?? 'root',
    captured_at: ps.captured_at ?? new Date().toISOString(),
  };
}

function emptyPageState() {
  return {
    id: '',
    dom_epoch: 0,
    url: '',
    title: '',
    frame_path: 'root',
    captured_at: new Date().toISOString(),
  };
}

function normalizeProof(proof) {
  return {
    before_screenshot_ref: proof.before_screenshot_ref ?? null,
    after_screenshot_ref: proof.after_screenshot_ref ?? null,
    observed_change: proof.observed_change ?? null,
    access_state: proof.access_state ?? null,
    media_state: proof.media_state ?? null,
    network_evidence: proof.network_evidence ?? null,
  };
}

function normalizePagination(pg) {
  if (!pg) return null;
  return {
    cursor: pg.cursor ?? null,
    has_more: pg.has_more ?? false,
    returned: pg.returned ?? 0,
    total: pg.total ?? null,
  };
}

function normalizeTelemetry(t) {
  return {
    duration_ms: t.duration_ms ?? 0,
    cache_hit: t.cache_hit ?? false,
    attempts: t.attempts ?? 1,
    payload_bytes: t.payload_bytes ?? 0,
    truncated: t.truncated ?? false,
  };
}

function decodeUriStringSafe(value) {
  const text = String(value || '');
  if (!text.includes('%')) return text;
  const candidates = [text, text.replace(/%(?![0-9a-fA-F]{2})/g, '%25')];
  for (const candidate of candidates) {
    for (const decoder of [decodeURI, decodeURIComponent]) {
      try {
        const decoded = decoder(candidate);
        if (decoded) return decoded;
      } catch {}
    }
  }
  return text;
}

export function decodeUriEverywhere(value, seen = new WeakSet()) {
  if (typeof value === 'string') return decodeUriStringSafe(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => decodeUriEverywhere(item, seen));
  }
  const decoded = {};
  for (const [key, nested] of Object.entries(value)) {
    decoded[key] = decodeUriEverywhere(nested, seen);
  }
  return decoded;
}
