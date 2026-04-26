/**
 * mcp-server.js - Profile-based MCP server over HTTP/SSE (Playwright engine).
 *
 * Each SSE session gets its own browser context when MCP_BROWSER_MODE=isolated.
 * That context is reused across the tool calls made by that agent session
 * and is torn down as soon as the session closes.
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { PROFILES } from './profiles.js';
import { closeEphemeralBrowser, isSharedBrowserFallbackAllowed, launchEphemeralBrowser } from './shared/browser.js';
import { decodeUriEverywhere } from './shared/tool-runtime.js';
import { getToolCatalog, getToolDefinitions, getToolSpec } from './tool-registry.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || 'ws://127.0.0.1:9223';
const BROWSER_MODE = process.env.MCP_BROWSER_MODE || 'isolated';

function buildServer(profileName, browserSession) {
  const allowedTools = PROFILES[profileName];
  const server = new McpServer({
    name: `owc-pw-${profileName}`,
    version: '1.0.0',
  });
  const allTools = getToolDefinitions(browserSession, undefined, profileName);

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

  console.log(`[MCP-PW] Profile '${profileName}' registered tools: [${allowedTools.join(', ')}]`);
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
  console.log(`[MCP-PW] Session closed: ${sessionId} (${session.profile})`);
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    engine: 'playwright',
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

  console.log(`[MCP-PW] New session -> profile: ${profile}`);

  const transport = new SSEServerTransport('/mcp/message', res);
  let browserSession = null;

  if (BROWSER_MODE === 'isolated') {
    try {
      browserSession = await launchEphemeralBrowser(transport.sessionId, { browserProfile: profile });
      console.log(`[MCP-PW] Isolated browser started for ${transport.sessionId}`);
    } catch (error) {
      console.error(
        `[MCP-PW] Isolated browser launch failed for ${transport.sessionId}; attempting shared CDP fallback`,
        error,
      );
      browserSession = null;
    }
  }

  // Fallback: connect to shared browser via CDP
  if (!browserSession) {
    if (!isSharedBrowserFallbackAllowed()) {
      return res.status(503).json({
        error: 'Isolated browser launch failed and shared browser fallback is disabled by proxy settings.',
      });
    }
    try {
      const { connectBrowser } = await import('./shared/browser.js');
      browserSession = await connectBrowser(BROWSER_WS);
    } catch (err) {
      console.error(`[MCP-PW] Shared browser connect failed:`, err);
    }
  }

  const server = buildServer(profile, browserSession);

  sessions.set(transport.sessionId, { transport, profile, browserSession });
  res.on('close', () => {
    closeSession(transport.sessionId).catch((err) => {
      console.error(`[MCP-PW] Failed to close session ${transport.sessionId}:`, err);
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

  await session.transport.handlePostMessage(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`[MCP-PW] Playwright MCP server running on :${PORT}`);
  console.log(`[MCP-PW] Browser mode: ${BROWSER_MODE}`);
  console.log(`[MCP-PW] Shared browser fallback: ${BROWSER_WS}`);
  console.log('[MCP-PW] Profiles:');
  for (const [name, tools] of Object.entries(PROFILES)) {
    console.log(`      /mcp/${name}/sse  ->  [${tools.join(', ')}]`);
  }
});
