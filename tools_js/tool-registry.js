/**
 * tool-registry.js - Central MCP tool definitions.
 *
 * Keep this file as the single source of truth for:
 * - MCP-facing tool descriptions
 * - example input/output JSON payloads
 * - a lightweight serializable input schema
 * - runtime Zod validation
 * - the actual tool handler wiring
 */

import { z } from 'zod';

import { inspect } from './tools/inspect.js';
import { interact } from './tools/interact.js';
import { harvest } from './tools/harvest.js';
import { navigate } from './tools/navigate.js';
import { screenshot } from './tools/screenshot.js';

function formatJsonBlock(label, value) {
  return `${label}:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildDescription(summary, inputExample, outputExample) {
  return [
    summary,
    formatJsonBlock('Input JSON', inputExample),
    formatJsonBlock('Output JSON', outputExample),
  ].join('\n\n');
}

const TOOL_SPECS = {
  inspect: {
    summary:
      'Full DOM scan of the current page. Use this first to understand links, buttons, iframes, videos, popups, and hosting signals.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    inputExample: {},
    outputExample: {
      url: 'https://example.com/watch',
      title: 'Example Stream',
      screenshot_url: 'https://res.cloudinary.com/.../inspect.png',
      hosting_signals: {
        has_video: true,
        has_player_iframe: true,
        player_iframe_src: 'https://embed.example.com/player',
        player_libraries: true,
        server_tabs: true,
      },
      stats: {
        content_links: 10,
        nav_links: 5,
        buttons: 8,
        iframes: 2,
        videos: 1,
        popups: 1,
      },
    },
    zodSchema: {},
    handlerFactory: (browserWsEndpoint) => () => inspect({ browserWsEndpoint }),
  },

  navigate: {
    summary:
      'Navigate the browser to a URL, wait for load completion, and report redirects, title, domain warnings, and screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to navigate to',
        },
        wait_until: {
          type: 'string',
          enum: ['networkidle0', 'networkidle2', 'domcontentloaded', 'load'],
          default: 'networkidle2',
          description: 'Navigation wait strategy',
        },
        timeout_ms: {
          type: 'number',
          default: 30000,
          description: 'Navigation timeout in milliseconds',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    inputExample: {
      url: 'https://example.com/watch/123',
      wait_until: 'networkidle2',
      timeout_ms: 30000,
    },
    outputExample: {
      success: true,
      finalUrl: 'https://example.com/watch/123',
      title: 'Example Stream',
      httpStatus: 200,
      redirectChain: [],
      domain_warning: null,
      screenshot_url: 'https://res.cloudinary.com/.../navigate.png',
      error: null,
    },
    zodSchema: {
      url: z.string().describe('Full URL to navigate to'),
      wait_until: z.enum(['networkidle0', 'networkidle2', 'domcontentloaded', 'load'])
        .optional()
        .default('networkidle2'),
      timeout_ms: z.number().optional().default(30_000),
    },
    handlerFactory: (browserWsEndpoint) => (args) => navigate({ ...args, browserWsEndpoint }),
  },

  interact: {
    summary:
      'Interact with the current page using selectors, text, xpath, or coordinates. Use for clicking, playing, typing, selecting, or checking controls.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['click', 'play', 'type', 'select', 'coordinates', 'check'],
          description: 'Interaction mode',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of target element',
        },
        xpath: {
          type: 'string',
          description: 'XPath of target element',
        },
        text: {
          type: 'string',
          description: 'Visible text to find the element',
        },
        value: {
          type: 'string',
          description: 'Text to type for type mode',
        },
        option_text: {
          type: 'string',
          description: 'Option text for select mode',
        },
        x: {
          type: 'number',
          description: 'Viewport X coordinate for coordinates mode',
        },
        y: {
          type: 'number',
          description: 'Viewport Y coordinate for coordinates mode',
        },
        wait_ms: {
          type: 'number',
          default: 3000,
          description: 'How long to wait after interaction',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    inputExample: {
      mode: 'click',
      selector: '.server-button',
      xpath: '',
      text: '',
      value: '',
      option_text: '',
      x: null,
      y: null,
      wait_ms: 3000,
    },
    outputExample: {
      success: true,
      mode: 'click',
      navigated: false,
      new_tab_urls: [],
      url: 'https://example.com/watch/123',
      error: null,
    },
    zodSchema: {
      mode: z.enum(['click', 'play', 'type', 'select', 'coordinates', 'check'])
        .describe('Interaction mode'),
      selector: z.string().optional().describe('CSS selector of target element'),
      xpath: z.string().optional().describe('XPath of target element'),
      text: z.string().optional().describe('Visible text to find the element'),
      value: z.string().optional().describe('Text to type for type mode'),
      option_text: z.string().optional().describe('Option text for select mode'),
      x: z.number().optional().describe('Viewport X coordinate for coordinates mode'),
      y: z.number().optional().describe('Viewport Y coordinate for coordinates mode'),
      wait_ms: z.number().optional().default(3000).describe('How long to wait after interaction'),
    },
    handlerFactory: (browserWsEndpoint) => (args) => interact({ ...args, browserWsEndpoint }),
  },

  harvest: {
    summary:
      'Capture streaming URLs from the active player using CDP requests, responses, DOM scans, iframe scans, JS player objects, and performance entries.',
    inputSchema: {
      type: 'object',
      properties: {
        duration_ms: {
          type: 'number',
          default: 12000,
          description: 'How long to monitor network activity in milliseconds',
        },
        player_iframe_url: {
          type: 'string',
          default: '',
          description: 'Iframe URL from inspect output when the player lives in an iframe',
        },
      },
      additionalProperties: false,
    },
    inputExample: {
      duration_ms: 12000,
      player_iframe_url: '',
    },
    outputExample: {
      streams: [
        {
          url: 'https://cdn.example.com/master.m3u8',
          protocol: 'hls',
          source_layer: 'cdp-request',
        },
      ],
      m3u8_urls: ['https://cdn.example.com/master.m3u8'],
      mpd_urls: [],
      mp4_urls: [],
      total: 1,
      video_state: 'playing',
      screenshot_url: 'https://res.cloudinary.com/.../harvest.png',
    },
    zodSchema: {
      duration_ms: z.number().optional().default(12_000)
        .describe('How long to monitor network activity in milliseconds'),
      player_iframe_url: z.string().optional().default('')
        .describe('Iframe URL from inspect output when the player lives in an iframe'),
    },
    handlerFactory: (browserWsEndpoint) => (args) => harvest({ ...args, browserWsEndpoint }),
  },

  screenshot: {
    summary:
      'Capture a quick screenshot of the current page or element and report basic video state without running a full inspect pass.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['viewport', 'full', 'element'],
          default: 'viewport',
          description: 'Screenshot mode',
        },
        selector: {
          type: 'string',
          default: 'video',
          description: 'CSS selector for element mode',
        },
      },
      additionalProperties: false,
    },
    inputExample: {
      mode: 'viewport',
      selector: 'video',
    },
    outputExample: {
      screenshot_url: 'https://res.cloudinary.com/.../shot.png',
      video_state: 'playing',
      url: 'https://example.com/watch/123',
    },
    zodSchema: {
      mode: z.enum(['viewport', 'full', 'element']).optional().default('viewport'),
      selector: z.string().optional().default('video')
        .describe('CSS selector for element mode'),
    },
    handlerFactory: (browserWsEndpoint) => (args) => screenshot({ ...args, browserWsEndpoint }),
  },
};

function toPublicToolSpec(name, spec) {
  return {
    name,
    summary: spec.summary,
    description: buildDescription(spec.summary, spec.inputExample, spec.outputExample),
    input_schema: spec.inputSchema,
    input_example: spec.inputExample,
    output_example: spec.outputExample,
  };
}

export function getToolCatalog() {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(([name, spec]) => [name, toPublicToolSpec(name, spec)]),
  );
}

export function getToolSpec(toolName) {
  const spec = TOOL_SPECS[toolName];
  return spec ? toPublicToolSpec(toolName, spec) : null;
}

export function getToolDefinitions(browserWsEndpoint) {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(([name, spec]) => [
      name,
      {
        ...toPublicToolSpec(name, spec),
        schema: spec.zodSchema,
        handler: spec.handlerFactory(browserWsEndpoint),
      },
    ]),
  );
}
