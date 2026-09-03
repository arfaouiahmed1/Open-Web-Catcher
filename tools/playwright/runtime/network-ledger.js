/**
 * NetworkLedger — Always-on network ledger with bounded 1,000-entry ring buffer.
 *
 * Attaches at page creation/navigation. Preserves:
 *  - URL, method, resourceType, frameUrl, status, contentType, redirectedFrom
 *  - initiator, blockedByClient, failed, streamPattern classification
 *
 * NEVER stores authorization/cookie headers or response bodies.
 */

const MAX_ENTRIES = 1000;

const STREAM_PATTERNS = [
  { protocol: 'hls', regex: /\.(?:m3u8)(?:[?#]|$)/i, mimeRegex: /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i },
  { protocol: 'dash', regex: /\.(?:mpd)(?:[?#]|$)/i, mimeRegex: /application\/dash\+xml/i },
  { protocol: 'mp4', regex: /\.(?:mp4|m4s|m4v)(?:[?#]|$)/i, mimeRegex: /video\/(?:mp4|iso\.segment)/i },
  { protocol: 'webm', regex: /\.(?:webm)(?:[?#]|$)/i, mimeRegex: /video\/webm/i },
  { protocol: 'flv', regex: /\.(?:flv)(?:[?#]|$)/i, mimeRegex: /video\/x-flv/i },
];

export function classifyStreamPattern(url = '', contentType = '') {
  const normalizedUrl = String(url || '');
  const normalizedType = String(contentType || '').toLowerCase();

  for (const p of STREAM_PATTERNS) {
    if (p.regex.test(normalizedUrl) || (normalizedType && p.mimeRegex.test(normalizedType))) {
      return p.protocol;
    }
  }
  return null;
}

export class NetworkLedger {
  constructor(page) {
    this.page = page;
    this.entries = []; // Ring buffer: newest at end
    this.inFlightRequests = new Set();
    this._listeners = null;
    this._attached = false;
  }

  /**
   * Start listening to network traffic on the page.
   */
  start() {
    if (this._attached || !this.page) return;
    this._attached = true;

    const onRequest = (request) => {
      try {
        this.inFlightRequests.add(request);
        const url = request.url();
        const resourceType = request.resourceType();
        let frameUrl = '';
        try {
          frameUrl = request.frame()?.url() || '';
        } catch {}

        const entry = {
          id: Math.random().toString(36).slice(2, 10),
          url,
          method: request.method(),
          resourceType,
          frameUrl,
          status: null,
          contentType: null,
          redirectedFrom: request.redirectedFrom()?.url() || null,
          initiator: request.headerValue('referer') || null,
          blockedByClient: false,
          failed: false,
          failureText: null,
          streamPattern: classifyStreamPattern(url, ''),
          timestamp: Date.now(),
        };

        this._addEntry(entry);
      } catch (err) {
        // Safe ignore
      }
    };

    const onResponse = (response) => {
      try {
        const request = response.request();
        this.inFlightRequests.delete(request);

        const url = response.url();
        const status = response.status();
        const contentType = response.headerValue('content-type') || '';
        const streamPattern = classifyStreamPattern(url, contentType);

        // Find and update matching entry or append
        const existing = this._findLastMatchingEntry(url, request.method());
        if (existing) {
          existing.status = status;
          existing.contentType = contentType;
          if (streamPattern) existing.streamPattern = streamPattern;
        } else {
          this._addEntry({
            id: Math.random().toString(36).slice(2, 10),
            url,
            method: request.method(),
            resourceType: request.resourceType(),
            frameUrl: response.frame()?.url() || '',
            status,
            contentType,
            redirectedFrom: null,
            initiator: null,
            blockedByClient: false,
            failed: false,
            failureText: null,
            streamPattern,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        // Safe ignore
      }
    };

    const onRequestFailed = (request) => {
      try {
        this.inFlightRequests.delete(request);
        const failure = request.failure();
        const errorText = failure?.errorText || '';
        const blockedByClient = errorText.toLowerCase().includes('blocked_by_client') || errorText.toLowerCase().includes('blocked');

        const existing = this._findLastMatchingEntry(request.url(), request.method());
        if (existing) {
          existing.failed = true;
          existing.failureText = errorText;
          existing.blockedByClient = blockedByClient;
        }
      } catch (err) {
        // Safe ignore
      }
    };

    const onRequestFinished = (request) => {
      this.inFlightRequests.delete(request);
    };

    this.page.on('request', onRequest);
    this.page.on('response', onResponse);
    this.page.on('requestfailed', onRequestFailed);
    this.page.on('requestfinished', onRequestFinished);

    this._listeners = { onRequest, onResponse, onRequestFailed, onRequestFinished };
  }

  /**
   * Stop listening.
   */
  stop() {
    if (!this._attached || !this._listeners || !this.page) return;
    try {
      this.page.off('request', this._listeners.onRequest);
      this.page.off('response', this._listeners.onResponse);
      this.page.off('requestfailed', this._listeners.onRequestFailed);
      this.page.off('requestfinished', this._listeners.onRequestFinished);
    } catch {}
    this._attached = false;
    this._listeners = null;
    this.inFlightRequests.clear();
  }

  /**
   * Add an entry, maintaining the bounded ring buffer.
   */
  _addEntry(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  _findLastMatchingEntry(url, method) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].url === url && this.entries[i].method === method) {
        return this.entries[i];
      }
    }
    return null;
  }

  /**
   * Filtered snapshot of entries.
   *
   * @param {object} [opts]
   * @param {number} [opts.since] - Milliseconds timestamp
   * @param {string} [opts.resourceType]
   * @param {string} [opts.frameUrl]
   * @param {boolean} [opts.streamOnly]
   * @returns {Array<object>}
   */
  getEntries({ since = 0, resourceType, frameUrl, streamOnly = false } = {}) {
    return this.entries.filter((e) => {
      if (since && e.timestamp < since) return false;
      if (resourceType && e.resourceType !== resourceType) return false;
      if (frameUrl && !e.frameUrl.includes(frameUrl)) return false;
      if (streamOnly && !e.streamPattern) return false;
      return true;
    });
  }

  /**
   * Number of currently in-flight requests.
   */
  get inFlightCount() {
    return this.inFlightRequests.size;
  }

  /**
   * Clear the ring buffer.
   */
  clear() {
    this.entries = [];
    this.inFlightRequests.clear();
  }
}
