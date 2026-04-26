const TRANSIENT_ERROR_CODES = new Set([
  'CHROME_ERROR_PAGE',
  'ERR_ABORTED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_FAILED',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_HTTP_RESPONSE_CODE_FAILURE',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_NETWORK_ACCESS_DENIED',
  'ERR_NETWORK',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_QUIC_PROTOCOL_ERROR',
  'ERR_SOCKET_NOT_CONNECTED',
  'ERR_SSL_PROTOCOL_ERROR',
  'ERR_TIMED_OUT',
]);

const LIMITED_ERROR_CODES = new Set([
  'ERR_CACHE_MISS',
  'ERR_TOO_MANY_REDIRECTS',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_UNKNOWN_URL_SCHEME',
]);

const PERMANENT_ERROR_CODES = new Set([
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_RESPONSE',
  'ERR_INVALID_ARGUMENT',
  'ERR_INVALID_REDIRECT',
  'ERR_UNSAFE_PORT',
]);

const TRANSIENT_PREFIXES = [
  'ERR_CONNECTION_',
  'ERR_DNS_',
  'ERR_PROXY_',
  'ERR_SSL_',
];

const PERMANENT_PREFIXES = [
  'ERR_CERT_',
  'ERR_CERTIFICATE_',
  'ERR_INVALID_',
];

const IFRAME_CORS_PATTERNS = [
  /access-control-allow-origin/i,
  /blocked by cors policy/i,
  /\bcors\b/i,
  /cross-origin/i,
  /cross origin/i,
];

const IFRAME_SANDBOX_PATTERNS = [
  /\bsandbox\b/i,
  /allow-same-origin/i,
  /allow-scripts/i,
];

const IFRAME_CSP_PATTERNS = [
  /\bcsp\b/i,
  /content security policy/i,
  /frame-ancestors/i,
];

const IFRAME_XFO_PATTERNS = [
  /blocked_by_response/i,
  /x-frame-options/i,
];

export const NAVIGATION_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000];
export const LIMITED_RETRY_BACKOFF_MS = NAVIGATION_RETRY_BACKOFF_MS.slice(0, 2);
export const UNKNOWN_RETRY_BACKOFF_MS = NAVIGATION_RETRY_BACKOFF_MS.slice(0, 1);

export function extractChromeNetErrorCode(value) {
  const match = String(value || '').match(/(?:net::)?(ERR_[A-Z0-9_]+)/i);
  return match?.[1]?.toUpperCase() || '';
}

export function isChromeErrorPage(urlLike) {
  return String(urlLike || '').trim().toLowerCase().startsWith('chrome-error://');
}

function resolveErrorCategory(code) {
  if (!code) return 'unknown';
  if (TRANSIENT_ERROR_CODES.has(code) || TRANSIENT_PREFIXES.some((prefix) => code.startsWith(prefix))) return 'transient';
  if (LIMITED_ERROR_CODES.has(code)) return 'limited';
  if (PERMANENT_ERROR_CODES.has(code) || PERMANENT_PREFIXES.some((prefix) => code.startsWith(prefix))) return 'permanent';
  return 'unknown';
}

export function classifyChromeError(input) {
  const details = typeof input === 'string' ? { message: input } : (input || {});
  const message = String(details.message || details.error || '').trim();
  const url = String(details.url || details.final_url || '').trim();
  const detectedCode = extractChromeNetErrorCode(message || url);
  const isChromePage = isChromeErrorPage(url);
  const errorCode = detectedCode || (isChromePage ? 'CHROME_ERROR_PAGE' : '');
  const errorCategory = resolveErrorCategory(errorCode);

  if (errorCategory === 'transient') {
    return {
      error_code: errorCode || null,
      error_category: 'transient',
      max_retries: 4,
      retry_delays_ms: [...NAVIGATION_RETRY_BACKOFF_MS],
      retryable: true,
      is_chrome_error_page: isChromePage,
    };
  }
  if (errorCategory === 'limited') {
    return {
      error_code: errorCode || null,
      error_category: 'limited',
      max_retries: 2,
      retry_delays_ms: [...LIMITED_RETRY_BACKOFF_MS],
      retryable: true,
      is_chrome_error_page: isChromePage,
    };
  }
  if (errorCategory === 'permanent') {
    return {
      error_code: errorCode || null,
      error_category: 'permanent',
      max_retries: 0,
      retry_delays_ms: [],
      retryable: false,
      is_chrome_error_page: isChromePage,
    };
  }
  return {
    error_code: errorCode || null,
    error_category: 'unknown',
    max_retries: 1,
    retry_delays_ms: [...UNKNOWN_RETRY_BACKOFF_MS],
    retryable: true,
    is_chrome_error_page: isChromePage,
  };
}

export function summarizeRetryAttempts(attempts = []) {
  const summary = {
    total_attempts: attempts.length,
    transient_attempts: 0,
    limited_attempts: 0,
    permanent_failures: 0,
    unknown_attempts: 0,
    chrome_error_page_failures: 0,
  };

  for (const attempt of attempts) {
    const category = String(attempt?.error_category || '').toLowerCase();
    if (category === 'transient') summary.transient_attempts += 1;
    else if (category === 'limited') summary.limited_attempts += 1;
    else if (category === 'permanent') summary.permanent_failures += 1;
    else if (category === 'unknown') summary.unknown_attempts += 1;
    if (attempt?.chrome_error_page) summary.chrome_error_page_failures += 1;
  }

  return summary;
}

export function classifyIframeFailure({
  errorText = '',
  errorCode = '',
  resourceType = '',
  blockedByClient = false,
  aborted = false,
} = {}) {
  const normalizedType = String(resourceType || '').toLowerCase();
  const normalizedText = String(errorText || '').trim();
  const effectiveCode = String(errorCode || extractChromeNetErrorCode(normalizedText) || '').toUpperCase();
  const chromeError = classifyChromeError({ message: normalizedText, url: '' });

  if (blockedByClient) {
    return { detection_reason: 'adblock', recoverable: true, error_code: effectiveCode || 'ERR_BLOCKED_BY_CLIENT', error_category: 'permanent' };
  }
  if (!['sub_frame', 'media'].includes(normalizedType)) {
    return { detection_reason: '', recoverable: false, error_code: effectiveCode || null, error_category: chromeError.error_category };
  }
  if (effectiveCode === 'ERR_BLOCKED_BY_RESPONSE' || IFRAME_XFO_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
    const csp = IFRAME_CSP_PATTERNS.some((pattern) => pattern.test(normalizedText));
    return { detection_reason: csp ? 'csp' : 'x_frame_options', recoverable: false, error_code: effectiveCode || 'ERR_BLOCKED_BY_RESPONSE', error_category: 'permanent' };
  }
  if (IFRAME_SANDBOX_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
    return { detection_reason: 'sandbox', recoverable: true, error_code: effectiveCode || null, error_category: chromeError.error_category };
  }
  if (IFRAME_CORS_PATTERNS.some((pattern) => pattern.test(normalizedText))) {
    return { detection_reason: 'cors', recoverable: true, error_code: effectiveCode || null, error_category: chromeError.error_category };
  }
  if (chromeError.error_category === 'transient' || aborted) {
    return { detection_reason: 'network', recoverable: true, error_code: effectiveCode || null, error_category: chromeError.error_category || 'transient' };
  }
  return { detection_reason: '', recoverable: false, error_code: effectiveCode || null, error_category: chromeError.error_category };
}
