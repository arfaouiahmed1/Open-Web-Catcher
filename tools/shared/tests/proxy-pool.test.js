import assert from 'node:assert/strict';

import { DEFAULT_PROXY_SOURCE_ORDER, normalizeProxyRuntimeConfig } from '../proxy-pool.js';

const config = normalizeProxyRuntimeConfig({ proxy_enabled: true });

assert.deepEqual(config.sourceOrder, DEFAULT_PROXY_SOURCE_ORDER);
assert.ok(config.sourceOrder.includes('proxifly-http'));
assert.ok(config.sourceOrder.includes('proxifly-socks5'));
assert.ok(config.sourceOrder.includes('monosans-http'));
assert.ok(config.sourceOrder.includes('monosans-socks5'));
assert.equal(config.enabled, true);
assert.equal(config.fallbackStrategy, 'direct');

const customOrder = normalizeProxyRuntimeConfig({
  proxy_enabled: true,
  proxy_source_order: 'monosans-http,monosans-http,https://example.com/proxies.txt',
});

assert.deepEqual(customOrder.sourceOrder, [
  'monosans-http',
  'https://example.com/proxies.txt',
]);

console.log('Validated proxy source defaults and normalization.');
