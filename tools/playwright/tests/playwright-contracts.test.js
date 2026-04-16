import assert from 'node:assert/strict';
import { z } from 'zod';

import { getToolCatalog, getToolDefinitions } from '../tool-registry.js';

const catalog = getToolCatalog();
const defs = getToolDefinitions('ws://127.0.0.1:9333/devtools/browser/playwright-contracts');

for (const toolName of ['open_url', 'navigate']) {
  const zodSchema = z.object(defs[toolName].schema);
  const parsed = zodSchema.parse({ url: 'https://example.com' });
  assert.equal(
    parsed.wait_until,
    'networkidle',
    `${toolName} should default to Playwright networkidle`,
  );

  assert.ok(catalog[toolName].input_schema?.properties?.wait_until, `${toolName} should expose wait_until`);
  assert.equal(
    zodSchema.safeParse({ url: 'https://example.com', wait_until: 'networkidle0' }).success,
    true,
    `${toolName} should accept networkidle0 alias`,
  );
  assert.equal(
    zodSchema.safeParse({ url: 'https://example.com', wait_until: 'networkidle2' }).success,
    true,
    `${toolName} should accept networkidle2 alias`,
  );
}

console.log('Validated Playwright wait contract aliases and defaults.');
