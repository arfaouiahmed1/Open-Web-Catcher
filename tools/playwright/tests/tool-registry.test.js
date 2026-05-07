import assert from 'node:assert/strict';

import { z } from 'zod';

import { PROFILES } from '../profiles.js';
import { getToolCatalog, getToolDefinitions } from '../tool-registry.js';

const endpoint = 'ws://127.0.0.1:9333/devtools/browser/session-123';
const catalog = getToolCatalog();
const calls = [];
const fakeTools = Object.fromEntries(
  Object.keys(catalog).map((toolName) => [
    toolName,
    async (args) => {
      calls.push([toolName, args]);
      return { ok: true, toolName };
    },
  ]),
);

const defs = getToolDefinitions(endpoint, fakeTools);

for (const [toolName, def] of Object.entries(defs)) {
  assert.ok(catalog[toolName].usage_guidance?.includes('Efficiency guidance'), `${toolName} should expose usage guidance`);
  assert.ok(catalog[toolName].description.includes('Efficiency guidance'), `${toolName} description should guide efficient use`);
  assert.ok(catalog[toolName].description.includes('Input JSON'), `${toolName} description should include input shape`);
  assert.ok(catalog[toolName].description.includes('Output JSON'), `${toolName} description should include output shape`);
  const parsedArgs = z.object(def.schema).parse(catalog[toolName].input_example ?? {});
  await def.handler(parsedArgs);
  assert.deepEqual(calls.at(-1), [toolName, { ...parsedArgs, browserWsEndpoint: endpoint, browserProfile: '' }]);
}

for (const [profileName, toolNames] of Object.entries(PROFILES)) {
  assert.ok(toolNames.length > 0, `${profileName} should expose at least one tool`);
  for (const toolName of toolNames) {
    assert.ok(catalog[toolName], `${profileName} references unknown tool ${toolName}`);
  }
}

console.log(`Validated ${Object.keys(catalog).length} tools across ${Object.keys(PROFILES).length} profiles.`);
