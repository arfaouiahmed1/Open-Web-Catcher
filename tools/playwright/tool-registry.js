/**
 * tool-registry.js - Central MCP tool definitions.
 *
 * Exposes the six canonical MCP tools for Open Web Catcher (plan step 5 & 12):
 *   1. navigate
 *   2. inspect
 *   3. interact
 *   4. screenshot
 *   5. harvest
 *   6. wait
 *
 * Annotations and outputSchema are forwarded directly from browser-tool-manifest.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { navigate as navigateTool } from './tools/navigate.js';
import { inspect as inspectTool } from './tools/inspect.js';
import { interact as interactTool } from './tools/interact.js';
import { screenshot as screenshotTool } from './tools/screenshot.js';
import { harvest as harvestTool } from './tools/harvest.js';
import { wait as waitTool } from './tools/wait.js';

const DEFAULT_TOOL_IMPLS = {
  navigate: navigateTool,
  inspect: inspectTool,
  interact: interactTool,
  screenshot: screenshotTool,
  harvest: harvestTool,
  wait: waitTool,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, '..', 'shared', 'browser-tool-manifest.json');
const manifestToolsMap = {};
try {
  const rawManifest = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsedManifest = JSON.parse(rawManifest);
  for (const t of parsedManifest.tools || []) {
    manifestToolsMap[t.name] = t;
  }
} catch (err) {
  console.warn('[tool-registry] Could not load manifest:', err.message);
}

function formatJsonBlock(label, value) {
  return `${label}:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildDescription(toolName, summary, inputExample, outputExample) {
  return [
    summary,
    formatJsonBlock('Input JSON', inputExample),
    formatJsonBlock('Output JSON', outputExample),
  ].join('\n\n');
}

const framePathSchema = z.string().optional().default('root').describe('Frame path like root, root.0, root.0.2');

function spec(summary, inputExample, outputExample, zodSchema, handlerFactory) {
  return {
    summary,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    inputExample,
    outputExample,
    zodSchema,
    handlerFactory,
  };
}

const TOOL_SPECS = {
  navigate: spec(
    'Navigate to a URL, go back, or reload. Returns access state and captures proof screenshots.',
    { action: 'goto', url: 'https://example.com/watch', wait_until: 'domcontentloaded', timeout_ms: 30000 },
    { schema_version: 'owc.browser-tool.v2', ok: true, data: { action: 'goto', url: 'https://example.com/watch', final_url: 'https://example.com/watch', http_status: 200 } },
    {
      action: z.enum(['goto', 'back', 'reload']).optional().default('goto').describe('Navigation action'),
      url: z.string().optional().describe('Full URL to navigate to (required when action=goto)'),
      wait_until: z.enum(['domcontentloaded', 'load', 'networkidle', 'commit', 'networkidle0', 'networkidle2']).optional().default('domcontentloaded')
        .describe('Playwright wait condition: domcontentloaded (recommended), load, networkidle, commit'),
      timeout_ms: z.number().optional().default(30000).describe('Timeout in milliseconds'),
      challenge_policy: z.enum(['detect', 'wait_once']).optional().default('detect').describe('Handling policy for bot challenges'),
      intent: z.string().optional().default('').describe('Short model-authored reason for this navigation'),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.navigate({ ...args, browserWsEndpoint }),
  ),

  inspect: spec(
    'Read page state, elements, frames, or media from the current page using role reducers.',
    { view: 'summary' },
    { schema_version: 'owc.browser-tool.v2', ok: true, data: { view: 'summary', title: 'Watch' } },
    {
      view: z.enum(['summary', 'elements', 'element', 'frames', 'media']).optional().default('summary')
        .describe('Inspection view reducer: summary, elements, element, frames, or media'),
      frame_path: framePathSchema,
      scope_ref: z.string().optional().describe('Candidate/element ref to scope inspection'),
      role: z.string().optional().describe('ARIA role filter for elements view'),
      text: z.string().optional().describe('Partial text filter for elements view'),
      attribute: z.string().optional().describe('Attribute name filter for elements view'),
      limit: z.number().optional().default(50).describe('Max items to return (1-200)'),
      cursor: z.string().optional().describe('Pagination cursor from previous response'),
      include_screenshot: z.boolean().optional().default(false).describe('Include proof screenshot ref'),
      intent: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.inspect({ ...args, browserWsEndpoint }),
  ),

  interact: spec(
    'Perform user interactions (click, fill, select, check, press, hover, scroll, drag, play) with locator resolution and state change verification.',
    { action: 'click', candidate_id: 'c_1@ps-123', expected_change: 'auto' },
    { schema_version: 'owc.browser-tool.v2', ok: true, data: { action: 'click', observed_change: 'navigation', verified: true } },
    {
      action: z.enum(['click', 'fill', 'select', 'check', 'press', 'hover', 'scroll', 'drag', 'play']).optional().default('click'),
      candidate_id: z.string().optional().describe('Candidate ref from inspect response'),
      frame_path: framePathSchema,
      role: z.string().optional(),
      name: z.string().optional(),
      css: z.string().optional(),
      xpath: z.string().optional(),
      text: z.string().optional(),
      value: z.string().optional().describe('Text value for fill action'),
      option: z.string().optional().describe('Option value or label for select action'),
      key: z.string().optional().describe('Key for press action (e.g. Enter, Tab)'),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      scroll_amount: z.number().optional(),
      drag_to: z.string().optional(),
      allow_coordinate_fallback: z.boolean().optional().default(false),
      expected_change: z.enum(['auto', 'navigation', 'dom', 'media', 'network']).optional().default('auto'),
      intent: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.interact({ ...args, browserWsEndpoint }),
  ),

  screenshot: spec(
    'Capture a viewport, full-page, or element screenshot returning content-addressed blobref.',
    { scope: 'viewport' },
    { schema_version: 'owc.browser-tool.v2', ok: true, data: { blobref: 'blobref:abc1234567890123', width: 1365, height: 768 } },
    {
      scope: z.enum(['viewport', 'full', 'element']).optional().default('viewport'),
      candidate_id: z.string().optional().describe('Target candidate ID for element screenshot'),
      frame_path: framePathSchema,
      lossless: z.boolean().optional().default(false).describe('Use PNG instead of WebP (only for OCR)'),
      intent: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.screenshot({ ...args, browserWsEndpoint }),
  ),

  harvest: spec(
    'Capture streaming URLs (m3u8/mpd/mp4/webm) using network ledger and DOM inspection, probing manifests.',
    { frame_path: 'root', probe_manifests: true },
    { schema_version: 'owc.browser-tool.v2', ok: true, data: { total_discovered: 1, streams: [] } },
    {
      frame_path: framePathSchema,
      include_expired: z.boolean().optional().default(false),
      probe_manifests: z.boolean().optional().default(true),
      intent: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.harvest({ ...args, browserWsEndpoint }),
  ),

  wait: spec(
    'Wait for a specific condition before proceeding: duration, text_visible, text_gone, selector_visible, media_playing, network_quiet.',
    { condition: 'duration', timeout_ms: 5000 },
    { schema_version: 'owc.browser-tool.v2', ok: true, data: { condition: 'duration', matched: true, elapsed_ms: 5000 } },
    {
      condition: z.enum(['duration', 'text_visible', 'text_gone', 'selector_visible', 'media_playing', 'network_quiet']).describe('Condition to wait for'),
      value: z.string().optional().default('').describe('Target text string or CSS selector for text/selector conditions'),
      frame_path: framePathSchema,
      timeout_ms: z.number().optional().default(10000).describe('Max wait in milliseconds (<=60000)'),
      poll_ms: z.number().optional().default(500).describe('Polling interval in milliseconds'),
      intent: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.wait({ ...args, browserWsEndpoint }),
  ),
};

for (const [name, specValue] of Object.entries(TOOL_SPECS)) {
  specValue.inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  for (const [key, schema] of Object.entries(specValue.zodSchema)) {
    const property = {};
    if (schema.description) {
      property.description = schema.description;
    }
    specValue.inputSchema.properties[key] = property;
  }
}

function toPublicToolSpec(name, specValue) {
  const manifestEntry = manifestToolsMap[name] || {};
  return {
    name,
    summary: specValue.summary,
    description: buildDescription(name, specValue.summary, specValue.inputExample, specValue.outputExample),
    input_schema: specValue.inputSchema,
    input_example: specValue.inputExample,
    output_example: specValue.outputExample,
    annotations: manifestEntry.annotations || null,
    output_schema: manifestEntry.outputSchema || null,
    outputSchema: manifestEntry.outputSchema || null,
  };
}

export function getToolCatalog() {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(([name, specValue]) => [name, toPublicToolSpec(name, specValue)]),
  );
}

export function getToolSpec(toolName) {
  const specValue = TOOL_SPECS[toolName];
  return specValue ? toPublicToolSpec(toolName, specValue) : null;
}

export function getToolDefinitions(browserWsEndpoint, toolImpls = DEFAULT_TOOL_IMPLS, browserProfile = '') {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(([name, specValue]) => [
      name,
      {
        ...toPublicToolSpec(name, specValue),
        schema: specValue.zodSchema,
        handler: (args) => specValue.handlerFactory(browserWsEndpoint, toolImpls)({ ...args, browserProfile }),
      },
    ]),
  );
}
