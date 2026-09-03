/**
 * mcp-server.js - Profile-based MCP server over Streamable HTTP and HTTP/SSE.
 *
 * Implements the v2 MCP transport architecture (plan step 4):
 *  - Primary transport: StreamableHTTPServerTransport at POST|GET|DELETE /mcp/:profile
 *  - Isolated browser sessions keyed by (runId, profile, browserScopeId)
 *  - Profile tool definitions loaded directly from tools/shared/browser-tool-manifest.json
 *  - Shared CDP fallback disabled: isolated persistent contexts are the only mode
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { loadBrowserDriver } from "./shared/browser-driver.js";
import { defaultSessionManager, makeScopeKey } from "./runtime/session-manager.js";
import { decodeUriEverywhere } from "./shared/tool-envelope.js";
import {
  getToolCatalog,
  getToolDefinitions,
  getToolSpec,
} from "./tool-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "tools", "shared", "browser-tool-manifest.json");

// Load tool profiles from the authoritative manifest
function loadManifestProfiles() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
    const manifest = JSON.parse(raw);
    const profiles = {
      classification: [],
      landing: [],
      hosting: [],
      embedded: [],
    };
    for (const tool of manifest.tools || []) {
      if (tool.kind !== "mcp") continue;
      for (const p of tool.profiles || []) {
        if (profiles[p]) {
          profiles[p].push(tool.name);
        }
      }
    }
    return profiles;
  } catch (err) {
    console.error("[MCP-PW] Failed to load tool manifest:", err.message);
    return {
      classification: ["navigate", "inspect", "interact", "screenshot", "wait"],
      landing: ["navigate", "inspect", "interact", "screenshot", "wait"],
      hosting: ["navigate", "inspect", "interact", "screenshot", "harvest", "wait"],
      embedded: ["navigate", "inspect", "interact", "screenshot", "harvest", "wait"],
    };
  }
}

export const MANIFEST_PROFILES = loadManifestProfiles();

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "127.0.0.1";
const MCP_BEARER_TOKEN = String(process.env.MCP_BEARER_TOKEN || "").trim();
const BROWSER_MODE = "isolated";
const RUN_BROWSER_TTL_MS = Math.max(
  1000,
  parseInt(process.env.MCP_RUN_BROWSER_TTL_MS || "120000", 10),
);

// Map of sessionId -> { transport, server, profile, browserSession, runKey, lastSeenAt }
const sessions = new Map();
// Run key map for session reuse
const runBrowsers = new Map();
// In-flight launch deduplication
const launchesInFlight = new Map();

export const _lifecycleState = { sessions, runBrowsers, launchesInFlight };

export function buildServer(profileName, browserSession) {
  const allowedTools = MANIFEST_PROFILES[profileName] || [];
  const server = new McpServer({
    name: `owc-pw-${profileName}`,
    version: "2.0.0",
  });
  const allTools = getToolDefinitions(browserSession, undefined, profileName);

  for (const toolName of allowedTools) {
    const def = allTools[toolName];
    if (!def) {
      console.warn(`[MCP-PW] Tool '${toolName}' not found in tool definitions for profile '${profileName}'`);
      continue;
    }

    server.tool(toolName, def.description, def.schema, async (args) => {
      try {
        const result = await def.handler(args);
        const normalized = decodeUriEverywhere(result);
        return {
          content: [{ type: "text", text: JSON.stringify(normalized) }],
        };
      } catch (err) {
        const errorPayload = decodeUriEverywhere({ error: err.message });
        return {
          content: [{ type: "text", text: JSON.stringify(errorPayload) }],
          isError: true,
        };
      }
    });
  }

  console.log(`[MCP-PW] Profile '${profileName}' registered tools: [${allowedTools.join(", ")}]`);
  return server;
}

const app = express();
app.use(express.json());

// Bearer token gate
if (MCP_BEARER_TOKEN) {
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const authorization = req.headers.authorization || "";
    if (authorization !== `Bearer ${MCP_BEARER_TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized: missing or invalid bearer token" });
    }
    return next();
  });
}

/**
 * Extract context parameters from request headers and query.
 */
export function extractRequestContext(req) {
  const runId = String(req?.headers?.["x-owc-run-id"] || req?.query?.runId || "").trim();
  const browserScopeId = String(req?.headers?.["x-owc-browser-scope-id"] || req?.query?.browserScopeId || "").trim();
  const { targetHost, targetUrl } = resolveTargetContext(req);
  return { runId, browserScopeId, targetHost, targetUrl };
}
export function resolveTargetContext(req) {
  const rawTargetUrl = String(
    req?.query?.targetUrl || req?.headers?.["x-owc-target-url"] || ""
  ).trim();
  const rawTargetHost = String(req?.query?.targetHost || "")
    .trim()
    .toLowerCase();
  let targetHost = "";
  let targetUrl = "";
  if (rawTargetUrl) {
    try {
      const parsed = new URL(rawTargetUrl);
      if (parsed.hostname) {
        targetUrl = parsed.href;
        targetHost = parsed.hostname.toLowerCase();
      }
    } catch {}
  }
  if (!targetHost && /^[a-z0-9._-]+$/.test(rawTargetHost)) {
    targetHost = rawTargetHost;
  }
  return { targetHost, targetUrl };
}

export function runBrowserKey(req, profile = "") {
  const runId = String(req?.query?.runId || req?.headers?.["x-owc-run-id"] || "").trim();
  if (!runId) return "";
  const sanitizedRun = runId.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const { targetHost } = resolveTargetContext(req);
  if (!targetHost) return `run:${sanitizedRun}`;
  const sanitizedProfile = String(profile || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `run:${sanitizedRun}|${sanitizedProfile}|${targetHost}`;
}

export async function acquireIsolatedBrowser(
  { sessionId, profile, runKey, target, runId, browserScopeId },
  deps = {},
) {
  const launchFn = deps.launchEphemeralBrowser;
  const targetHost = String(target?.targetHost || "").trim();
  const targetUrl = String(target?.targetUrl || "").trim();

  // Test spy/stub support
  if (launchFn) {
    if (runKey) {
      const existing = runBrowsers.get(runKey);
      if (existing?.browserSession) {
        if (existing.closeTimer) {
          clearTimeout(existing.closeTimer);
          existing.closeTimer = null;
        }
        existing.refCount += 1;
        return existing.browserSession;
      }
      const inFlight = launchesInFlight.get(runKey);
      if (inFlight) {
        const joinedSession = await inFlight;
        const entry = runBrowsers.get(runKey);
        if (entry?.browserSession === joinedSession) {
          entry.refCount += 1;
        }
        return joinedSession;
      }
    }

    const launchPromise = Promise.resolve().then(() =>
      launchFn(runKey || sessionId, {
        browserProfile: profile,
        targetHost,
        targetUrl,
      }),
    );
    if (runKey) launchesInFlight.set(runKey, launchPromise);
    try {
      const browserSession = await launchPromise;
      if (runKey) {
        runBrowsers.set(runKey, {
          browserSession,
          refCount: 1,
          closeTimer: null,
        });
      }
      return browserSession;
    } finally {
      if (runKey && launchesInFlight.get(runKey) === launchPromise) {
        launchesInFlight.delete(runKey);
      }
    }
  }

  // Production path
  const sessionMgr = deps.sessionManager || defaultSessionManager;
  return await sessionMgr.acquireSession({
    runId: runId || sessionId,
    profile,
    browserScopeId: browserScopeId || targetHost || "default",
    targetHost,
    targetUrl,
  });
}

export async function releaseBrowserSession(session, deps = {}) {
  const closeFn = deps.closeEphemeralBrowser;
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : RUN_BROWSER_TTL_MS;

  if (closeFn) {
    if (!session?.browserSession) return;
    if (!session.runKey) {
      await closeFn(session.browserSession);
      return;
    }
    const entry = runBrowsers.get(session.runKey);
    if (!entry || entry.browserSession !== session.browserSession) {
      await closeFn(session.browserSession);
      return;
    }
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0 || entry.closeTimer) return;
    entry.closeTimer = setTimeout(() => {
      const current = runBrowsers.get(session.runKey);
      if (!current || current.refCount > 0) return;
      runBrowsers.delete(session.runKey);
      current.closeTimer = null;
      closeFn(current.browserSession).catch(() => {});
    }, Math.max(0, ttlMs));
    return;
  }

  if (!session?.browserSession) return;
  const sessionMgr = deps.sessionManager || defaultSessionManager;
  const key = session.browserSession.key || session.runKey;
  if (key) {
    await sessionMgr.releaseSession(key);
  }
}

export async function establishSseSession({ req, res, profile, transport, deps = {} }) {
  const runKey = runBrowserKey(req, profile);
  const target = resolveTargetContext(req);
  let browserSession = null;
  let setupComplete = false;

  res.on("close", () => {
    if (setupComplete) {
      closeSession(transport.sessionId, deps).catch(() => {});
      return;
    }
    const orphan = browserSession;
    browserSession = null;
    if (orphan) {
      releaseBrowserSession({ browserSession: orphan, runKey }, deps).catch(() => {});
    }
  });

  browserSession = await acquireIsolatedBrowser(
    {
      sessionId: transport.sessionId,
      profile,
      runKey,
      target,
    },
    deps,
  );

  // Check if client aborted while acquire was in flight ([TOOL-C2])
  if (res.destroyed) {
    if (browserSession) {
      await releaseBrowserSession({ browserSession, runKey }, deps).catch(() => {});
    }
    return undefined;
  }

  const server = buildServer(profile, browserSession);
  if (typeof transport.start === "function") {
    await server.connect(transport);
  }

  sessions.set(transport.sessionId, {
    sessionId: transport.sessionId,
    transport,
    server,
    profile,
    browserSession,
    runKey,
    lastSeenAt: Date.now(),
  });

  setupComplete = true;
  return browserSession;
}

export async function closeSession(sessionId, deps = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await releaseBrowserSession(session, deps);
  console.log(`[MCP-PW] Session closed: ${sessionId} (${session.profile})`);
}

// ---------------------------------------------------------------------------
// Streamable HTTP endpoints (POST, GET, DELETE /mcp/:profile)
// ---------------------------------------------------------------------------

app.all("/mcp/:profile", async (req, res) => {
  const { profile } = req.params;
  if (!MANIFEST_PROFILES[profile]) {
    return res.status(404).json({ error: `Unknown profile: ${profile}` });
  }

  // Handle DELETE: close session
  if (req.method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId && sessions.has(sessionId)) {
      await closeSession(sessionId);
      return res.status(200).json({ ok: true });
    }
    return res.status(404).json({ error: "Session not found" });
  }

  // Check for existing stateful session via Mcp-Session-Id header
  const existingSessionId = req.headers["mcp-session-id"];
  if (existingSessionId && sessions.has(existingSessionId)) {
    const session = sessions.get(existingSessionId);
    session.lastSeenAt = Date.now();
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[MCP-PW] Transport error on session ${existingSessionId}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
    return;
  }

  // Initial connection: create transport and isolated browser
  const ctx = extractRequestContext(req);
  const sessionId = randomUUID();
  const runKey = makeScopeKey(ctx.runId, profile, ctx.browserScopeId || ctx.targetHost);

  let browserSession = null;
  let setupComplete = false;

  // Pre-await disconnect registration: prevent leaking browser on abort
  res.on("close", () => {
    if (!setupComplete && browserSession) {
      console.warn(`[MCP-PW] Client disconnected during setup (${sessionId})`);
      releaseBrowserSession({ browserSession, runKey }).catch(() => {});
    }
  });

  try {
    browserSession = await acquireIsolatedBrowser({
      sessionId,
      profile,
      runKey,
      target: { targetHost: ctx.targetHost, targetUrl: ctx.targetUrl },
      runId: ctx.runId,
      browserScopeId: ctx.browserScopeId,
    });
  } catch (err) {
    console.error(`[MCP-PW] Failed to acquire isolated browser:`, err.message);
    return res.status(500).json({ error: `Failed to acquire browser: ${err.message}` });
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
  });

  const server = buildServer(profile, browserSession);

  transport.onclose = () => {
    closeSession(sessionId).catch(() => {});
  };

  await server.connect(transport);

  sessions.set(sessionId, {
    sessionId,
    transport,
    server,
    profile,
    browserSession,
    runKey,
    lastSeenAt: Date.now(),
  });

  setupComplete = true;
  console.log(`[MCP-PW] Streamable HTTP session ${sessionId} initialized for profile '${profile}'`);

  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[MCP-PW] Error handling initial request for ${sessionId}:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health and tools catalog
// ---------------------------------------------------------------------------

app.get("/health", async (_req, res) => {
  let driverInfo = { driverName: "playwright", version: "unknown" };
  try {
    driverInfo = await loadBrowserDriver();
  } catch {}

  const ubolEnabled = String(process.env.OWC_UBOL_ENABLED || "true").toLowerCase() !== "false";

  res.status(200).json({
    status: "ok",
    engine: "playwright",
    driver: driverInfo.driverName,
    driver_version: driverInfo.version,
    transport: "streamable_http",
    browser_mode: "isolated",
    shared_fallback: "disabled",
    ubol_enabled: ubolEnabled,
    active_sessions: sessions.size,
    profiles: Object.keys(MANIFEST_PROFILES),
  });
});

app.get("/tools", (_req, res) => {
  res.json(getToolCatalog());
});

app.get("/tools/:toolName", (req, res) => {
  const tool = getToolSpec(req.params.toolName);
  if (!tool) {
    return res.status(404).json({
      error: `Unknown tool: '${req.params.toolName}'`,
      available: Object.keys(getToolCatalog()),
    });
  }
  return res.json(tool);
});

// ---------------------------------------------------------------------------
// Idle session cleanup timer
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeenAt > RUN_BROWSER_TTL_MS) {
      console.log(`[MCP-PW] Cleaning up idle session ${sessionId} after TTL`);
      closeSession(sessionId).catch(() => {});
    }
  }
}, 30000).unref();

// Start server if main module
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  app.listen(PORT, HOST, () => {
    console.log(`[MCP-PW] MCP server listening on http://${HOST}:${PORT}`);
    console.log(`[MCP-PW] Streamable HTTP: POST|GET|DELETE http://${HOST}:${PORT}/mcp/:profile`);
    console.log(`[MCP-PW] Health endpoint: http://${HOST}:${PORT}/health`);
  });
}

export default app;
