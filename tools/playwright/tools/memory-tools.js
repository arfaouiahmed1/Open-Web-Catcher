/**
 * tools/memory-tools.js - Shared profile memory read/write tools.
 *
 * Plan task 18, phase 2: the duplicated JSON-profile store that used to live
 * here is DECOMMISSIONED. These tools are now thin proxies to the Python
 * backend's pgvector site-hint endpoints:
 *
 *   memory_lookup  -> GET  {BACKEND}/memory?domain=...&page_type=...
 *   memory_update  -> POST {BACKEND}/memory/update
 *
 * The backend distills every update into a single summarized (domain,
 * page_type) hint row, so both the Python agents and these MCP tools read and
 * write the same store with no local duplication.
 */

const BACKEND_URL =
  process.env.MCP_MEMORY_BACKEND_URL ||
  process.env.OWC_API_URL ||
  'http://127.0.0.1:8000';

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
    return value.map((item) => normalizeItem(item)).filter((item) => item.length > 0);
  }
  return [normalizeItem(value)].filter((item) => item.length > 0);
}

async function backendFetch(path, options) {
  const response = await fetch(`${BACKEND_URL}${path}`, options);
  if (!response.ok) {
    throw new Error(`backend ${path} responded HTTP ${response.status}`);
  }
  return response.json();
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

  try {
    const payload = await backendFetch(
      `/memory?domain=${encodeURIComponent(domain)}&limit=${Math.max(Number(limit) || 3, 1)}`,
    );
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const exact = entries.find((entry) => entry.page_type === pageType) || null;
    const relatedProfiles = include_related
      ? entries.filter((entry) => entry.page_type !== pageType)
      : [];

    return {
      ok: true,
      domain,
      page_type: pageType,
      profile_found: Boolean(exact),
      profile: exact
        ? {
            domain: exact.domain,
            page_type: exact.page_type,
            summary_text: exact.summary_text || '',
            selectors: exact.selectors || [],
            playbook_steps: exact.navigation_steps || [],
            navigation_hints: exact.navigation_steps || [],
            success_rate: exact.success_rate,
            updated_at: exact.updated_at || '',
          }
        : null,
      related_profiles: relatedProfiles.map((entry) => ({
        domain: entry.domain,
        page_type: entry.page_type,
        summary_text: entry.summary_text || '',
        selectors: entry.selectors || [],
        playbook_steps: entry.navigation_steps || [],
      })),
      memory_first_recommendation: exact
        ? 'Use remembered selectors/url patterns first, then escalate to heavy tools only if hints fail.'
        : 'No exact hint found; gather lightweight evidence and store new selectors/patterns with memory_update.',
    };
  } catch (error) {
    return {
      ok: false,
      domain,
      page_type: pageType,
      error: `memory_lookup backend unavailable: ${error.message}`,
    };
  }
}

export async function memoryUpdate({
  url = '',
  page_type = '',
  selectors = [],
  navigation_hints = [],
  playbook_steps = [],
  refresh_reason = '',
  status = 'success',
  browserWsEndpoint: _browserWsEndpoint,
  ..._legacyFields
} = {}) {
  const domain = normalizeDomain(url);
  if (!domain) {
    throw new Error('memory_update requires a valid url or domain');
  }

  const pageType = normalizePageType(page_type);
  if (!pageType || pageType === 'unknown') {
    throw new Error('memory_update requires page_type');
  }

  try {
    const payload = await backendFetch('/memory/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: String(url).trim(),
        page_type: pageType,
        refresh_reason: String(refresh_reason || '').trim(),
        status: String(status || 'success').trim().toLowerCase(),
        selectors: asStringList(selectors),
        navigation_steps: asStringList(navigation_hints),
        playbook_steps: asStringList(playbook_steps),
      }),
    });
    return { ok: true, updated: true, domain, page_type: pageType, hint: payload };
  } catch (error) {
    return {
      ok: false,
      domain,
      page_type: pageType,
      error: `memory_update backend unavailable: ${error.message}`,
    };
  }
}
