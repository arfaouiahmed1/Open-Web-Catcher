/**
 * mcp-server.js — Profile-based MCP server over HTTP/SSE.
 *
 * Each agent profile gets its own SSE endpoint that exposes only
 * the tools allowed for that profile:
 *
 *   GET  /mcp/:profile/sse      → establish MCP SSE session
 *   POST /mcp/message           → send MCP messages to active session
 *   GET  /health                → liveness check
 *
 * Examples:
 *   /mcp/classification/sse  → only exposes: inspect, navigate
 *   /mcp/landing/sse         → exposes: inspect, navigate, interact, screenshot
 *   /mcp/hosting/sse         → exposes: inspect, interact, harvest, screenshot, navigate
 *   /mcp/embedded/sse        → exposes: inspect, interact, harvest, screenshot, navigate
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

import { PROFILES } from './profiles.js';
import { inspect }    from './tools/inspect.js';
import { interact }   from './tools/interact.js';
import { harvest }    from './tools/harvest.js';
import { navigate }   from './tools/navigate.js';
import { screenshot } from './tools/screenshot.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || 'ws://chrome:3000';

// ── Tool definitions ─────────────────────────────────────────────────────────
// Each entry: { name, description, schema (zod), handler }

const ALL_TOOLS = {
  inspect: {
    description:
      'Full DOM scan of the current page. Returns: content_links, nav_links, buttons, '
      + 'iframes, videos, elements (with x/y coords), hosting_signals, popups, '
      + 'dom_skeleton, pagination, screenshot_url. Call this first on every new page.',
    schema: {},   // no parameters
    handler: () => inspect({ browserWsEndpoint: BROWSER_WS }),
  },

  navigate: {
    description:
      'Navigate the browser to a URL. Handles redirects and waits for the page to load. '
      + 'Returns: finalUrl, title, httpStatus, redirectChain, domain_warning, screenshot_url.',
    schema: {
      url:        z.string().describe('Full URL to navigate to'),
      wait_until: z.enum(['networkidle0', 'networkidle2', 'domcontentloaded', 'load'])
                   .optional().default('networkidle2'),
      timeout_ms: z.number().optional().default(30_000),
    },
    handler: (args) => navigate({ ...args, browserWsEndpoint: BROWSER_WS }),
  },

  interact: {
    description:
      'Interact with an element on the current page. '
      + 'Modes: click | play | type | select | coordinates | check. '
      + 'Always pass selector AND xpath when available (from inspect elements[]). '
      + 'Use coordinates mode (x, y) when selectors fail or for transparent overlays. '
      + 'Returns: success, navigated (check this!), new_tab_urls, error.',
    schema: {
      mode:        z.enum(['click', 'play', 'type', 'select', 'coordinates', 'check'])
                    .describe('Interaction mode'),
      selector:    z.string().optional().describe('CSS selector of target element'),
      xpath:       z.string().optional().describe('XPath of target element'),
      text:        z.string().optional().describe('Visible text to find the element'),
      value:       z.string().optional().describe('Text to type (for type mode)'),
      option_text: z.string().optional().describe('Option text to select (for select mode)'),
      x:           z.number().optional().describe('Viewport X coordinate (for coordinates mode)'),
      y:           z.number().optional().describe('Viewport Y coordinate (for coordinates mode)'),
      wait_ms:     z.number().optional().default(3000).describe('ms to wait after interaction'),
    },
    handler: (args) => interact({ ...args, browserWsEndpoint: BROWSER_WS }),
  },

  harvest: {
    description:
      'Monitor network traffic to capture streaming URLs (m3u8/mpd/mp4). '
      + '6 detection layers: CDP requests, response intercept, DOM elements, '
      + 'iframe srcs, JS player objects (hls.js/videojs/jwplayer), performance API. '
      + 'The player MUST be actively playing before calling harvest. '
      + 'Returns: m3u8_urls, mpd_urls, mp4_urls, total, video_state, screenshot_url.',
    schema: {
      duration_ms:       z.number().optional().default(12_000)
                          .describe('How long to monitor network traffic (ms). Use 20000 for retry.'),
      player_iframe_url: z.string().optional().default('')
                          .describe('iframe_analysis.player_iframe.src from inspect — enables iframe-level CDP monitoring'),
    },
    handler: (args) => harvest({ ...args, browserWsEndpoint: BROWSER_WS }),
  },

  screenshot: {
    description:
      'Take a quick screenshot of the current page and upload to Cloudinary. '
      + 'Lighter than inspect — no DOM scan. Returns: screenshot_url, video_state. '
      + 'Use for visual checks between tool calls.',
    schema: {
      mode:     z.enum(['viewport', 'full', 'element']).optional().default('viewport'),
      selector: z.string().optional().default('video')
                 .describe('CSS selector for element screenshot (element mode only)'),
    },
    handler: (args) => screenshot({ ...args, browserWsEndpoint: BROWSER_WS }),
  },
};

// ── MCP server factory ────────────────────────────────────────────────────────

function buildServer(profileName) {
  const allowedTools = PROFILES[profileName];
  const server = new McpServer({
    name:    `owc-${profileName}`,
    version: '1.0.0',
  });

  for (const toolName of allowedTools) {
    const def = ALL_TOOLS[toolName];
    if (!def) { console.warn(`Unknown tool in profile ${profileName}: ${toolName}`); continue; }

    server.tool(toolName, def.description, def.schema, async (args) => {
      try {
        const result = await def.handler(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    });
  }

  console.log(`[MCP] Profile '${profileName}' registered tools: [${allowedTools.join(', ')}]`);
  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Active SSE sessions: sessionId → SSEServerTransport
const sessions = new Map();

// Liveness check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    profiles: Object.keys(PROFILES),
    browser: BROWSER_WS,
  });
});

// SSE connection — one per agent session
app.get('/mcp/:profile/sse', async (req, res) => {
  const { profile } = req.params;

  if (!PROFILES[profile]) {
    return res.status(404).json({
      error:    `Unknown profile: '${profile}'`,
      available: Object.keys(PROFILES),
    });
  }

  console.log(`[MCP] New session → profile: ${profile}`);

  const server    = buildServer(profile);
  const transport = new SSEServerTransport('/mcp/message', res);

  sessions.set(transport.sessionId, transport);
  res.on('close', () => {
    sessions.delete(transport.sessionId);
    console.log(`[MCP] Session closed: ${transport.sessionId} (${profile})`);
  });

  await server.connect(transport);
});

// Message endpoint — routes to the right session
app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sessions.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`[MCP] Server running on :${PORT}`);
  console.log(`[MCP] Browser: ${BROWSER_WS}`);
  console.log(`[MCP] Profiles:`);
  for (const [name, tools] of Object.entries(PROFILES)) {
    console.log(`      /mcp/${name}/sse  →  [${tools.join(', ')}]`);
  }
});
