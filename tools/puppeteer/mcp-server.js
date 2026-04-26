/**
 * mcp-server.js - Profile-based MCP server over HTTP/SSE.
 *
 * Each SSE session gets its own browser when MCP_BROWSER_MODE=isolated.
 * That browser is reused across the tool calls made by that agent session
 * and is torn down as soon as the session closes.
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { PROFILES } from './profiles.js';
import { closeEphemeralBrowser, isSharedBrowserFallbackAllowed, launchEphemeralBrowser } from './shared/browser.js';
import { decodeUriEverywhere } from './shared/tool-runtime.js';
import { getToolCatalog, getToolDefinitions, getToolSpec } from './tool-registry.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || 'ws://127.0.0.1:9222';
const BROWSER_MODE = process.env.MCP_BROWSER_MODE || 'isolated';

function buildServer(profileName, browserWsEndpoint) {
  const allowedTools = PROFILES[profileName];
  const server = new McpServer({
    name: `owc-${profileName}`,
    version: '1.0.0',
  });
  const allTools = getToolDefinitions(browserWsEndpoint);

  for (const toolName of allowedTools) {
    const def = allTools[toolName];
    if (!def) {
      console.warn(`Unknown tool in profile ${profileName}: ${toolName}`);
      continue;
    }

    server.tool(toolName, def.description, def.schema, async (args) => {
      try {
        const result = await def.handler(args);
        const normalized = decodeUriEverywhere(result);
        return {
          content: [{ type: 'text', text: JSON.stringify(normalized) }],
        };
      } catch (err) {
        const errorPayload = decodeUriEverywhere({ error: err.message });
        return {
          content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
          isError: true,
        };
      }
    });
  }

  console.log(`[MCP] Profile '${profileName}' registered tools: [${allowedTools.join(', ')}]`);
  return server;
}

const app = express();
app.use(express.json());

// Active SSE sessions: sessionId -> { transport, profile, browserSession }
const sessions = new Map();

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  sessions.delete(sessionId);
  await closeEphemeralBrowser(session.browserSession);
  console.log(`[MCP] Session closed: ${sessionId} (${session.profile})`);
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    profiles: Object.keys(PROFILES),
    browser_mode: BROWSER_MODE,
    shared_browser_fallback: BROWSER_WS,
  });
});

app.get('/tools', (_req, res) => {
  res.json(getToolCatalog());
});

app.get('/tools/:toolName', (req, res) => {
  const catalog = getToolCatalog();
  const tool = getToolSpec(req.params.toolName);

  if (!tool) {
    return res.status(404).json({
      error: `Unknown tool: '${req.params.toolName}'`,
      available: Object.keys(catalog),
    });
  }

  return res.json(tool);
});

app.get('/mcp/:profile/sse', async (req, res) => {
  const { profile } = req.params;

  if (!PROFILES[profile]) {
    return res.status(404).json({
      error: `Unknown profile: '${profile}'`,
      available: Object.keys(PROFILES),
    });
  }

  console.log(`[MCP] New session -> profile: ${profile}`);

  const transport = new SSEServerTransport('/mcp/message', res);
  let browserSession = null;
  let browserWsEndpoint = BROWSER_WS;

  if (BROWSER_MODE === 'isolated') {
    try {
      browserSession = await launchEphemeralBrowser(transport.sessionId);
      browserWsEndpoint = browserSession.wsEndpoint;
      console.log(`[MCP] Isolated browser started for ${transport.sessionId}: ${browserWsEndpoint}`);
    } catch (error) {
      console.error(
        `[MCP] Isolated browser launch failed for ${transport.sessionId}; using shared fallback ${BROWSER_WS}`,
        error,
      );
      browserSession = null;
      browserWsEndpoint = BROWSER_WS;
    }
  }

  if (!browserSession && !isSharedBrowserFallbackAllowed()) {
    return res.status(503).json({
      error: 'Isolated browser launch failed and shared browser fallback is disabled by proxy settings.',
    });
  }

  const server = buildServer(profile, browserWsEndpoint);

  sessions.set(transport.sessionId, { transport, profile, browserSession });
  res.on('close', () => {
    closeSession(transport.sessionId).catch((err) => {
      console.error(`[MCP] Failed to close session ${transport.sessionId}:`, err);
    });
  });

  await server.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  // SDK >= 1.10 expects parsedBody as the 3rd arg when middleware already
  // consumed the request stream (e.g., express.json()).
  await session.transport.handlePostMessage(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`[MCP] Server running on :${PORT}`);
  console.log(`[MCP] Browser mode: ${BROWSER_MODE}`);
  console.log(`[MCP] Shared browser fallback: ${BROWSER_WS}`);
  console.log('[MCP] Profiles:');
  for (const [name, tools] of Object.entries(PROFILES)) {
    console.log(`      /mcp/${name}/sse  ->  [${tools.join(', ')}]`);
  }
});
