const BUILTIN_PROXY_SOURCES = {
  'openproxylist-https': {
    id: 'openproxylist-https',
    label: 'OpenProxyList HTTPS',
    url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS.txt',
    scheme: 'http',
  },
  'openproxylist-socks4': {
    id: 'openproxylist-socks4',
    label: 'OpenProxyList SOCKS4',
    url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4.txt',
    scheme: 'socks4',
  },
  'openproxylist-socks5': {
    id: 'openproxylist-socks5',
    label: 'OpenProxyList SOCKS5',
    url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5.txt',
    scheme: 'socks5',
  },
  'speedx-http': {
    id: 'speedx-http',
    label: 'TheSpeedX HTTP',
    url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
    scheme: 'http',
  },
  'speedx-socks4': {
    id: 'speedx-socks4',
    label: 'TheSpeedX SOCKS4',
    url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt',
    scheme: 'socks4',
  },
  'speedx-socks5': {
    id: 'speedx-socks5',
    label: 'TheSpeedX SOCKS5',
    url: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
    scheme: 'socks5',
  },
  'monosans-http': {
    id: 'monosans-http',
    label: 'monosans HTTP',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    scheme: 'http',
  },
  'monosans-socks4': {
    id: 'monosans-socks4',
    label: 'monosans SOCKS4',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
    scheme: 'socks4',
  },
  'monosans-socks5': {
    id: 'monosans-socks5',
    label: 'monosans SOCKS5',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    scheme: 'socks5',
  },
  'proxifly-http': {
    id: 'proxifly-http',
    label: 'Proxifly HTTP',
    url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt',
    scheme: 'http',
  },
  'proxifly-socks4': {
    id: 'proxifly-socks4',
    label: 'Proxifly SOCKS4',
    url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks4/data.txt',
    scheme: 'socks4',
  },
  'proxifly-socks5': {
    id: 'proxifly-socks5',
    label: 'Proxifly SOCKS5',
    url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt',
    scheme: 'socks5',
  },
};

export const DEFAULT_PROXY_SOURCE_ORDER = [
  'openproxylist-https',
  'proxifly-http',
  'monosans-http',
  'speedx-http',
  'openproxylist-socks5',
  'proxifly-socks5',
  'monosans-socks5',
  'speedx-socks5',
  'proxifly-socks4',
];

const remoteSourceCache = new Map();
const proxySelectionState = new Map();

function clampPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function normalizeChoice(value, allowed, fallback) {
  const candidate = String(value || '').trim().toLowerCase();
  return allowed.has(candidate) ? candidate : fallback;
}

function splitUniqueStrings(value, fallback = []) {
  let rows = [];
  if (Array.isArray(value)) {
    rows = value.map((item) => String(item || '').trim());
  } else if (typeof value === 'string') {
    rows = value.split(',').map((item) => item.trim());
  } else {
    rows = fallback;
  }

  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row) continue;
    const key = row.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function isValidIpv4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255;
  });
}

function normalizeProxyCandidate({
  raw = '',
  scheme = 'http',
  host = '',
  port = '',
  username = '',
  password = '',
  sourceId = 'custom',
  sourceLabel = '',
} = {}) {
  const normalizedHost = String(host || '').trim();
  const normalizedPort = Number.parseInt(String(port || ''), 10);
  const normalizedScheme = normalizeChoice(scheme, new Set(['http', 'https', 'socks4', 'socks5']), 'http');
  if (!isValidIpv4(normalizedHost) || !Number.isFinite(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    return null;
  }

  const key = [
    normalizedScheme,
    normalizedHost,
    normalizedPort,
    String(username || '').trim(),
    String(password || '').trim(),
  ].join('|');

  return {
    key,
    raw: String(raw || '').trim(),
    scheme: normalizedScheme,
    host: normalizedHost,
    port: normalizedPort,
    username: String(username || '').trim(),
    password: String(password || '').trim(),
    server: `${normalizedScheme}://${normalizedHost}:${normalizedPort}`,
    sourceId: String(sourceId || 'custom'),
    sourceLabel: String(sourceLabel || sourceId || 'custom'),
  };
}

function parseCustomProxy(rawValue, defaultScheme = 'http') {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;

  if (raw.includes('://')) {
    try {
      const parsed = new URL(raw);
      return normalizeProxyCandidate({
        raw,
        scheme: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port: parsed.port,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        sourceId: 'custom',
        sourceLabel: 'Custom list',
      });
    } catch {
      return null;
    }
  }

  const match = raw.match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})$/);
  if (!match) return null;
  return normalizeProxyCandidate({
    raw,
    scheme: defaultScheme,
    host: match[1],
    port: match[2],
    sourceId: 'custom',
    sourceLabel: 'Custom list',
  });
}

function extractProxyEntriesFromText(text, source) {
  const lines = String(text || '').split(/\r?\n/);
  const candidates = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(/\b((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/);
    if (!match) continue;
    const candidate = normalizeProxyCandidate({
      raw: match[0],
      scheme: source.scheme || 'http',
      host: match[1],
      port: match[2],
      sourceId: source.id,
      sourceLabel: source.label || source.id,
    });
    if (!candidate || seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    candidates.push(candidate);
  }

  return candidates;
}

async function fetchRemoteProxySource(source, timeoutMs, cacheTtlMs) {
  const cacheKey = `${source.id}::${source.url}`;
  const now = Date.now();
  const cached = remoteSourceCache.get(cacheKey);
  if (cached && (now - cached.loadedAt) < cacheTtlMs) {
    return cached.candidates;
  }

  const response = await fetch(source.url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Proxy source '${source.id}' returned HTTP ${response.status}`);
  }

  const text = await response.text();
  const candidates = extractProxyEntriesFromText(text, source);
  remoteSourceCache.set(cacheKey, {
    loadedAt: now,
    candidates,
  });
  return candidates;
}

function rotateOrderedCandidates(candidates, offset) {
  if (!Array.isArray(candidates) || candidates.length < 2) return candidates;
  const normalizedOffset = offset % candidates.length;
  if (!normalizedOffset) return candidates;
  return [
    ...candidates.slice(normalizedOffset),
    ...candidates.slice(0, normalizedOffset),
  ];
}

function shuffleCandidates(candidates) {
  const copy = [...candidates];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function getSelectionState(browserId) {
  const key = String(browserId || 'browser');
  const existing = proxySelectionState.get(key);
  if (existing) return existing;
  const created = {
    stickyKey: '',
    nextOffset: 0,
  };
  proxySelectionState.set(key, created);
  return created;
}

function resolveRemoteSources(sourceOrder) {
  return sourceOrder.map((entry) => {
    const known = BUILTIN_PROXY_SOURCES[entry];
    if (known) return known;
    if (/^https?:\/\//i.test(entry)) {
      return {
        id: entry,
        label: entry,
        url: entry,
        scheme: 'http',
      };
    }
    return null;
  }).filter(Boolean);
}

export function normalizeProxyRuntimeConfig(settings = {}) {
  const sourceMode = normalizeChoice(settings.proxy_source_mode, new Set(['remote', 'custom', 'hybrid']), 'hybrid');
  return {
    enabled: Boolean(settings.proxy_enabled),
    sourceMode,
    sourceOrder: splitUniqueStrings(settings.proxy_source_order, DEFAULT_PROXY_SOURCE_ORDER),
    customList: splitUniqueStrings(settings.proxy_custom_list),
    rotationMode: normalizeChoice(settings.proxy_rotation_mode, new Set(['never', 'session', 'sticky', 'failure']), 'session'),
    selectionStrategy: normalizeChoice(settings.proxy_selection_strategy, new Set(['ordered', 'random']), 'ordered'),
    fallbackStrategy: normalizeChoice(settings.proxy_fallback_strategy, new Set(['direct', 'fail']), 'direct'),
    fetchTimeoutMs: clampPositiveInteger(settings.proxy_fetch_timeout_ms, 8000),
    validationTimeoutMs: clampPositiveInteger(settings.proxy_validation_timeout_ms, 12000),
    cacheTtlMs: clampPositiveInteger(settings.proxy_cache_ttl_ms, 600000),
    maxCandidates: clampPositiveInteger(settings.proxy_max_candidates, 25),
    testUrl: String(settings.proxy_test_url || 'https://api.ipify.org?format=json').trim() || 'https://api.ipify.org?format=json',
  };
}

export function shouldAllowSharedBrowserFallback(proxyConfig) {
  const config = normalizeProxyRuntimeConfig(proxyConfig);
  return !config.enabled || config.fallbackStrategy === 'direct';
}

export async function getProxyCandidatePlan(browserId, proxyConfig) {
  const config = normalizeProxyRuntimeConfig(proxyConfig);
  if (!config.enabled) {
    return {
      enabled: false,
      allowDirectFallback: true,
      candidates: [],
      testUrl: config.testUrl,
      validationTimeoutMs: config.validationTimeoutMs,
    };
  }

  const collected = [];
  const seen = new Set();

  if (config.sourceMode === 'custom' || config.sourceMode === 'hybrid') {
    for (const rawEntry of config.customList) {
      const parsed = parseCustomProxy(rawEntry);
      if (!parsed || seen.has(parsed.key)) continue;
      seen.add(parsed.key);
      collected.push(parsed);
    }
  }

  if (config.sourceMode === 'remote' || config.sourceMode === 'hybrid') {
    const sources = resolveRemoteSources(config.sourceOrder);
    for (const source of sources) {
      try {
        const rows = await fetchRemoteProxySource(source, config.fetchTimeoutMs, config.cacheTtlMs);
        for (const candidate of rows) {
          if (!candidate || seen.has(candidate.key)) continue;
          seen.add(candidate.key);
          collected.push(candidate);
          if (collected.length >= config.maxCandidates) break;
        }
      } catch {
        // Remote source fetches are best effort; later sources can still succeed.
      }
      if (collected.length >= config.maxCandidates) break;
    }
  }

  let ordered = collected.slice(0, config.maxCandidates);
  const state = getSelectionState(browserId);

  if (config.selectionStrategy === 'random') {
    ordered = shuffleCandidates(ordered);
  }

  if (config.rotationMode === 'sticky' || config.rotationMode === 'failure') {
    const stickyIndex = ordered.findIndex((candidate) => candidate.key === state.stickyKey);
    if (stickyIndex > 0) {
      const [stickyCandidate] = ordered.splice(stickyIndex, 1);
      ordered.unshift(stickyCandidate);
    }
  }

  if (config.selectionStrategy === 'ordered' && config.rotationMode === 'session' && ordered.length > 1) {
    ordered = rotateOrderedCandidates(ordered, state.nextOffset);
    state.nextOffset = (state.nextOffset + 1) % ordered.length;
  }

  return {
    enabled: true,
    allowDirectFallback: config.fallbackStrategy === 'direct',
    candidates: ordered.slice(0, config.maxCandidates),
    testUrl: config.testUrl,
    validationTimeoutMs: config.validationTimeoutMs,
  };
}

export function markProxySuccess(browserId, candidate) {
  if (!candidate?.key) return;
  const state = getSelectionState(browserId);
  state.stickyKey = candidate.key;
}

export function markProxyFailure(browserId, candidate) {
  if (!candidate?.key) return;
  const state = getSelectionState(browserId);
  if (state.stickyKey === candidate.key) {
    state.stickyKey = '';
  }
}

export function describeProxyCandidate(candidate) {
  if (!candidate) return 'direct';
  return `${candidate.server} (${candidate.sourceId})`;
}
