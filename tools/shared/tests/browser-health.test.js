import assert from 'node:assert/strict';
import http from 'node:http';

import { cdpHttpUrlFromWsEndpoint, probeBrowserEndpoint } from '../browser-health.js';

assert.equal(cdpHttpUrlFromWsEndpoint('ws://127.0.0.1:9222'), 'http://127.0.0.1:9222');
assert.equal(cdpHttpUrlFromWsEndpoint('wss://browser.example.com:9443/devtools/browser/abc'), 'https://browser.example.com:9443');
assert.equal(cdpHttpUrlFromWsEndpoint('not-a-url'), 'http://localhost:9222');

const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/browser/test',
        Browser: 'Chrome/123.0.0.0',
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const status = await probeBrowserEndpoint(`ws://127.0.0.1:${port}`);

  assert.equal(status.healthy, true);
  assert.equal(status.configured_ws_endpoint, `ws://127.0.0.1:${port}`);
  assert.equal(status.probe_url, `http://127.0.0.1:${port}/json/version`);
  assert.equal(status.reported_ws_endpoint, 'ws://127.0.0.1:12345/devtools/browser/test');
  assert.equal(status.browser, 'Chrome/123.0.0.0');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('Validated shared browser health probing helpers.');
