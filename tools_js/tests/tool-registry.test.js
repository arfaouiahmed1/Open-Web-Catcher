import assert from 'node:assert/strict';

import { getToolDefinitions } from '../tool-registry.js';

const calls = [];
const fakeTools = {
  inspect: async (args) => { calls.push(['inspect', args]); return { ok: true }; },
  navigate: async (args) => { calls.push(['navigate', args]); return { ok: true }; },
  interact: async (args) => { calls.push(['interact', args]); return { ok: true }; },
  harvest: async (args) => { calls.push(['harvest', args]); return { ok: true }; },
  screenshot: async (args) => { calls.push(['screenshot', args]); return { ok: true }; },
};

const endpoint = 'ws://127.0.0.1:9333/devtools/browser/session-123';
const defs = getToolDefinitions(endpoint, fakeTools);

await defs.inspect.handler({});
await defs.navigate.handler({ url: 'https://example.com' });
await defs.interact.handler({ mode: 'click', selector: '.play' });
await defs.harvest.handler({ duration_ms: 5000 });
await defs.screenshot.handler({ mode: 'viewport' });

assert.deepEqual(calls, [
  ['inspect', { browserWsEndpoint: endpoint }],
  ['navigate', { url: 'https://example.com', browserWsEndpoint: endpoint }],
  ['interact', { mode: 'click', selector: '.play', browserWsEndpoint: endpoint }],
  ['harvest', { duration_ms: 5000, browserWsEndpoint: endpoint }],
  ['screenshot', { mode: 'viewport', browserWsEndpoint: endpoint }],
]);

console.log('tool-registry endpoint injection check passed');
