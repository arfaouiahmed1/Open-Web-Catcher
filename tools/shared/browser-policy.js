const STREAMING_PATH_PATTERNS = [
  /(?:^|[/?#._-])(embed|player|stream|live|watch)(?:$|[/?#._-])/i,
  /\.m3u8(?:$|[?#])/i,
  /\.mpd(?:$|[?#])/i,
  /videojs/i,
  /jwplayer/i,
  /\bHls\b/i,
];

const STREAMING_PROFILE_IDS = new Set(['hosting', 'embedded']);

function collectUrls(value, collector) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, collector));
    return;
  }
  const text = String(value).trim();
  if (!text) return;
  collector.push(text);
}

export function detectStreamingSignals({
  browserProfile = '',
  targetUrl = '',
  currentUrl = '',
  iframeUrls = [],
  playerHints = [],
} = {}) {
  const urls = [];
  collectUrls(targetUrl, urls);
  collectUrls(currentUrl, urls);
  collectUrls(iframeUrls, urls);
  collectUrls(playerHints, urls);

  const urlMatches = [];
  for (const url of urls) {
    for (const pattern of STREAMING_PATH_PATTERNS) {
      if (pattern.test(url)) {
        urlMatches.push({ url, pattern: pattern.source });
        break;
      }
    }
  }

  const profilePriority = STREAMING_PROFILE_IDS.has(String(browserProfile || '').trim().toLowerCase());

  return {
    profile_priority: profilePriority,
    streaming_detected: profilePriority || urlMatches.length > 0,
    url_matches: urlMatches.slice(0, 12),
  };
}

export function computeBrowserPolicy({
  browserId = '',
  browserProfile = '',
  runtimeSettings = {},
  targetUrl = '',
  currentUrl = '',
  iframeUrls = [],
  playerHints = [],
  sharedConnection = false,
} = {}) {
  const streamingSafeMode = String(runtimeSettings?.streaming_safe_mode || 'adaptive').trim().toLowerCase();
  const mediaProxyStrategy = String(runtimeSettings?.media_proxy_strategy || 'direct_first').trim().toLowerCase();
  const assetDiagnosticsEnabled = runtimeSettings?.asset_diagnostics_enabled !== false;
  const streamingSignals = detectStreamingSignals({
    browserProfile,
    targetUrl,
    currentUrl,
    iframeUrls,
    playerHints,
  });

  const wantsStreamingSafe = streamingSafeMode === 'always'
    || (streamingSafeMode !== 'never' && streamingSignals.streaming_detected);

  const proxyEnabled = runtimeSettings?.proxy_enabled === true;
  const directFirst = mediaProxyStrategy === 'direct_first';
  const directOnly = mediaProxyStrategy === 'direct_only';
  const proxyFirst = mediaProxyStrategy === 'proxy_first';
  const useProxyOnFirstAttempt = proxyEnabled && (!wantsStreamingSafe || proxyFirst);

  return {
    browser_id: browserId,
    browser_profile: String(browserProfile || '').trim().toLowerCase(),
    mode: wantsStreamingSafe ? 'streaming_safe' : 'standard',
    streaming_safe: wantsStreamingSafe,
    streaming_safe_mode: streamingSafeMode,
    media_proxy_strategy: mediaProxyStrategy,
    asset_diagnostics_enabled: assetDiagnosticsEnabled,
    proxy_enabled: proxyEnabled,
    use_proxy_on_first_attempt: useProxyOnFirstAttempt,
    direct_only: directOnly,
    page_blocking_disabled: wantsStreamingSafe,
    ghostery_enabled: !wantsStreamingSafe && runtimeSettings?.adblock_enabled === true,
    ubol_enabled: browserId === 'puppeteer' && !wantsStreamingSafe && runtimeSettings?.ubol_enabled === true,
    shared_connection: Boolean(sharedConnection),
    shared_connection_warning: sharedConnection && wantsStreamingSafe
      ? 'Shared-browser fallback may still inherit blocker or proxy state from an existing session.'
      : '',
    detection: streamingSignals,
    reason: wantsStreamingSafe
      ? (streamingSignals.profile_priority ? `profile:${browserProfile}` : 'streaming_hints')
      : 'standard_runtime',
  };
}

export function shouldRetryWithProxy({
  policy = {},
  manifestFailure = null,
  criticalResourceFailures = [],
} = {}) {
  if (!policy?.proxy_enabled || policy?.direct_only) {
    return false;
  }

  const candidates = [];
  if (manifestFailure) candidates.push(manifestFailure);
  if (Array.isArray(criticalResourceFailures)) candidates.push(...criticalResourceFailures);

  return candidates.some((failure) => {
    const httpStatus = Number(failure?.http_status || 0);
    const text = `${failure?.error || ''} ${failure?.url || ''} ${failure?.status_text || ''}`.toLowerCase();
    return httpStatus === 403
      || httpStatus === 451
      || /geo|region|forbidden|access denied|manifest access denied|country/.test(text);
  });
}

export function shouldRetryWithoutBlocking({
  criticalResourceFailures = [],
  renderGapSignals = null,
} = {}) {
  const blockedFailures = Array.isArray(criticalResourceFailures)
    ? criticalResourceFailures.filter((failure) => failure?.blocked_by_client)
    : [];
  if (blockedFailures.length > 0) {
    return true;
  }
  return Boolean(
    renderGapSignals
    && (
      Number(renderGapSignals.blocked_by_client_total || 0) > 0
      || Number(renderGapSignals.failed_script_count || 0) > 0
      || Number(renderGapSignals.failed_stylesheet_count || 0) > 0
      || Number(renderGapSignals.failed_font_count || 0) > 0
    )
  );
}
