/**
 * tools/memory-tools.js - Shared profile memory read/write tools.
 *
 * This store is intentionally lightweight JSON so both Python agents and
 * MCP tools can read/write the same per-domain, per-agent memory profiles.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

const MEMORY_FILE = process.env.MCP_MEMORY_FILE || 'data/site_memory_profiles.json';
const PROFILE_VERSION = 1;
const ARRAY_LIMITS = {
  selectors: 64,
  pagination_url_patterns: 32,
  url_patterns: 60,
  navigation_hints: 60,
  critical_links: 600,
  server_labels: 220,
  stream_hosts: 160,
  ui_signals: 40,
  hosting_candidate_urls: 900,
  server_records: 420,
  server_screenshots: 360,
  server_stream_urls: 900,
  activated_servers: 260,
};

function dedupe(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function asStringList(value) {
  const normalizeItem = (item) => {
    if (typeof item === 'string') {
      return item;
    }
    if (item && typeof item === 'object') {
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    }
    return String(item);
  };

  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return dedupe(value.map((item) => normalizeItem(item)));
  }
  if (value instanceof Set) {
    return dedupe(Array.from(value).map((item) => normalizeItem(item)));
  }
  return dedupe([normalizeItem(value)]);
}

function normalizeDomain(urlOrDomain) {
  const raw = String(urlOrDomain || '').trim();
  if (!raw) {
    return '';
  }

  const parse = (candidate) => {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
  };

  let host = parse(raw);
  if (!host) {
    host = parse(`https://${raw}`);
  }
  if (!host) {
    return '';
  }
  return host.startsWith('www.') ? host.slice(4) : host;
}

function normalizePageType(pageType) {
  return String(pageType || '').trim() || 'unknown';
}

function profileKey(domain, pageType) {
  return `${domain}::${pageType}`;
}

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultProfile(domain, pageType) {
  return {
    domain,
    page_type: pageType,
    revision: 0,
    updated_at: '',
    updated_by: '',
    last_refresh_reason: '',
    ui_change_detected: false,
    ui_change_notes: [],
    selectors: [],
    pagination_url_patterns: [],
    url_patterns: [],
    navigation_hints: [],
    critical_links: [],
    server_labels: [],
    stream_hosts: [],
    ui_signals: [],
    hosting_candidate_urls: [],
    server_records: [],
    server_screenshots: [],
    server_stream_urls: [],
    activated_servers: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function looksLikePagination(url) {
  const candidate = String(url || '').toLowerCase();
  if (!candidate) {
    return false;
  }
  return Boolean(candidate.match(/([?&](page|p|offset|start|cursor)=)|\/page\/\d+|\/p\/\d+|-page-\d+/));
}

function looksLikeStream(url) {
  const candidate = String(url || '').toLowerCase();
  return Boolean(
    candidate
      && (
        candidate.includes('.m3u8')
        || candidate.includes('.mpd')
        || candidate.includes('.mp4')
        || candidate.includes('manifest')
        || candidate.includes('playlist')
      )
  );
}

function generalizeUrlPattern(url) {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(/\d+/g, '{n}').replace(/[0-9a-fA-F]{8,}/g, '{id}');
  }

  const hostname = normalizeDomain(raw);
  const pathName = parsed.pathname
    .replace(/\/\d+(?=\/|$)/g, '/{n}')
    .replace(/\/[0-9a-fA-F]{8,}(?=\/|$)/g, '/{id}')
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/{token}');

  const params = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    let normalized = value;
    if (/^\d+$/.test(normalized)) {
      normalized = '{n}';
    } else if (/^[0-9a-fA-F]{8,}$/.test(normalized)) {
      normalized = '{id}';
    } else if (normalized.length >= 24 && /^[A-Za-z0-9_-]+$/.test(normalized)) {
      normalized = '{token}';
    }
    params.push([key, normalized]);
  }
  params.sort((left, right) => String(left[0]).localeCompare(String(right[0])));

  const query = new URLSearchParams(params)
    .toString()
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}');
  return `${parsed.protocol}//${hostname}${pathName}${query ? `?${query}` : ''}`;
}

async function readStore() {
  const resolved = path.resolve(MEMORY_FILE);
  try {
    const raw = await fs.readFile(resolved, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object') {
      return { version: PROFILE_VERSION, profiles: {} };
    }
    const profiles = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
    return {
      version: safeInt(parsed.version, PROFILE_VERSION),
      profiles,
      _path: resolved,
    };
  } catch {
    return {
      version: PROFILE_VERSION,
      profiles: {},
      _path: resolved,
    };
  }
}

async function writeStore(store) {
  const resolved = store._path || path.resolve(MEMORY_FILE);
  const payload = {
    version: PROFILE_VERSION,
    profiles: store.profiles || {},
  };
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await fs.rename(tmp, resolved);
}

function mergeField(existingProfile, patch, field, replace, maxItems) {
  const existing = asStringList(existingProfile[field] || []);
  const incoming = asStringList((patch || {})[field] || []);

  if (replace && Object.prototype.hasOwnProperty.call(patch || {}, field)) {
    return incoming.slice(0, maxItems);
  }
  if (!incoming.length) {
    return existing.slice(0, maxItems);
  }
  return dedupe([...existing, ...incoming]).slice(0, maxItems);
}

function toUpdatedList(profile) {
  return [
    ...asStringList(profile.selectors || []),
    ...asStringList(profile.url_patterns || []),
  ];
}

function toPatchSignature(patch) {
  return [
    ...asStringList((patch || {}).selectors || []),
    ...asStringList((patch || {}).url_patterns || []),
  ];
}

function buildDerivedPatch(rawPatch) {
  const patch = {
    selectors: asStringList(rawPatch.selectors || []),
    pagination_url_patterns: asStringList(rawPatch.pagination_url_patterns || []),
    url_patterns: asStringList(rawPatch.url_patterns || []),
    navigation_hints: asStringList(rawPatch.navigation_hints || []),
    critical_links: asStringList(rawPatch.critical_links || []),
    server_labels: asStringList(rawPatch.server_labels || []),
    stream_hosts: asStringList(rawPatch.stream_hosts || []),
    ui_signals: asStringList(rawPatch.ui_signals || []),
    hosting_candidate_urls: asStringList(rawPatch.hosting_candidate_urls || []),
    server_records: asStringList(rawPatch.server_records || []),
    server_screenshots: asStringList(rawPatch.server_screenshots || []),
    server_stream_urls: asStringList(rawPatch.server_stream_urls || []),
    activated_servers: asStringList(rawPatch.activated_servers || []),
    ui_change_notes: asStringList(rawPatch.ui_change_notes || []),
    ui_change_detected: Boolean(rawPatch.ui_change_detected),
  };

  for (const link of patch.critical_links) {
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      continue;
    }
    patch.url_patterns.push(generalizeUrlPattern(link));
    if (looksLikePagination(link)) {
      patch.pagination_url_patterns.push(generalizeUrlPattern(link));
    }
    if (looksLikeStream(link)) {
      const host = normalizeDomain(link);
      if (host) {
        patch.stream_hosts.push(host);
      }
    }
  }

  for (const link of patch.hosting_candidate_urls) {
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      continue;
    }
    patch.critical_links.push(link);
    patch.url_patterns.push(generalizeUrlPattern(link));
    if (looksLikePagination(link)) {
      patch.pagination_url_patterns.push(generalizeUrlPattern(link));
    }
  }

  for (const link of patch.server_stream_urls) {
    if (!link.startsWith('http://') && !link.startsWith('https://')) {
      continue;
    }
    patch.critical_links.push(link);
    if (looksLikeStream(link)) {
      const host = normalizeDomain(link);
      if (host) {
        patch.stream_hosts.push(host);
      }
    }
  }

  for (const key of Object.keys(ARRAY_LIMITS)) {
    patch[key] = dedupe(patch[key] || []).slice(0, ARRAY_LIMITS[key]);
  }
  patch.ui_change_notes = dedupe(patch.ui_change_notes || []).slice(0, 6);
  return patch;
}

export async function memoryLookup({
  url = '',
  page_type = '',
  include_related = true,
  limit = 3,
  browserWsEndpoint: _browserWsEndpoint,
} = {}) {
  const domain = normalizeDomain(url);
  if (!domain) {
    throw new Error('memory_lookup requires a valid url or domain');
  }
  const pageType = normalizePageType(page_type || 'unknown');
  const store = await readStore();
  const key = profileKey(domain, pageType);
  const exact = store.profiles[key] ? clone(store.profiles[key]) : null;

  let relatedProfiles = [];
  if (include_related) {
    relatedProfiles = Object.values(store.profiles || {})
      .filter((profile) => profile && profile.domain === domain && profile.page_type !== pageType)
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
      .slice(0, Math.max(Number(limit) || 1, 1))
      .map((profile) => clone(profile));
  }

  return {
    ok: true,
    domain,
    page_type: pageType,
    profile_found: Boolean(exact),
    profile: exact,
    related_profiles: relatedProfiles,
    memory_first_recommendation: exact
      ? 'Use remembered selectors/url patterns first, then escalate to heavy tools only if hints fail.'
      : 'No exact profile found; gather lightweight evidence and store new selectors/patterns with memory_update.',
  };
}

export async function memoryUpdate({
  url = '',
  page_type = '',
  selectors = [],
  pagination_url_patterns = [],
  url_patterns = [],
  navigation_hints = [],
  critical_links = [],
  server_labels = [],
  stream_hosts = [],
  ui_signals = [],
  hosting_candidate_urls = [],
  server_records = [],
  server_screenshots = [],
  server_stream_urls = [],
  activated_servers = [],
  ui_change_notes = [],
  ui_change_detected = false,
  refresh_reason = '',
  replace = false,
  browserWsEndpoint: _browserWsEndpoint,
} = {}) {
  const domain = normalizeDomain(url);
  if (!domain) {
    throw new Error('memory_update requires a valid url or domain');
  }

  const pageType = normalizePageType(page_type);
  if (!pageType || pageType === 'unknown') {
    throw new Error('memory_update requires page_type');
  }

  const reason = String(refresh_reason || '').trim();
  const patch = buildDerivedPatch({
    selectors,
    pagination_url_patterns,
    url_patterns,
    navigation_hints,
    critical_links,
    server_labels,
    stream_hosts,
    ui_signals,
    hosting_candidate_urls,
    server_records,
    server_screenshots,
    server_stream_urls,
    activated_servers,
    ui_change_notes,
    ui_change_detected,
  });

  const store = await readStore();
  const key = profileKey(domain, pageType);
  const existing = store.profiles[key] ? clone(store.profiles[key]) : defaultProfile(domain, pageType);
  const merged = clone(existing);

  let changed = false;
  for (const [field, maxItems] of Object.entries(ARRAY_LIMITS)) {
    const nextValues = mergeField(existing, patch, field, Boolean(replace), maxItems);
    merged[field] = nextValues;
    if (JSON.stringify(nextValues) !== JSON.stringify(asStringList(existing[field] || []))) {
      changed = true;
    }
  }

  if (patch.ui_change_detected) {
    merged.ui_change_detected = true;
    changed = true;
  }

  const oldSignature = new Set(toUpdatedList(existing));
  const incomingSignature = new Set(toPatchSignature(patch));
  if (oldSignature.size > 0 && incomingSignature.size > 0) {
    let overlapCount = 0;
    for (const entry of incomingSignature) {
      if (oldSignature.has(entry)) {
        overlapCount += 1;
      }
    }
    const overlap = overlapCount / Math.max(incomingSignature.size, 1);
    if (overlap < 0.35) {
      merged.ui_change_detected = true;
      merged.ui_change_notes = dedupe([
        ...asStringList(existing.ui_change_notes || []),
        ...asStringList(patch.ui_change_notes || []),
        `structural drift detected (signature overlap=${overlap.toFixed(2)})`,
      ]).slice(0, 6);
      changed = true;
    }
  }

  if (patch.ui_change_notes.length) {
    const notes = dedupe([
      ...asStringList(existing.ui_change_notes || []),
      ...patch.ui_change_notes,
    ]).slice(0, 6);
    if (JSON.stringify(notes) !== JSON.stringify(asStringList(existing.ui_change_notes || []))) {
      merged.ui_change_notes = notes;
      changed = true;
    }
  }

  if (reason && reason !== String(existing.last_refresh_reason || '')) {
    merged.last_refresh_reason = reason;
    changed = true;
  }

  if (changed) {
    merged.revision = safeInt(existing.revision, 0) + 1;
    merged.updated_at = new Date().toISOString();
    merged.updated_by = 'mcp_tool';
  } else {
    merged.revision = safeInt(existing.revision, 0);
    merged.updated_at = String(existing.updated_at || '');
    merged.updated_by = String(existing.updated_by || '');
  }

  store.profiles[key] = merged;
  await writeStore(store);

  return {
    ok: true,
    updated: changed,
    domain,
    page_type: pageType,
    profile: clone(merged),
  };
}
