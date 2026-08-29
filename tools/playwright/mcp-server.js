/**
 * mcp-server.js - Profile-based MCP server over HTTP/SSE (Playwright engine).
 *
 * Each SSE session gets its own browser context when MCP_BROWSER_MODE=isolated.
 * That context is reused across the tool calls made by that agent session
 * and is torn down as soon as the session closes.
 *
 * Session-lifecycle hardening (plan T20 / [TOOL-C1][TOOL-C2][TOOL-C3]):
 *  - [TOOL-C2] The `res.on('close')` listener is registered BEFORE any
 *    `await acquireIsolatedBrowser(...)`. Previously it was registered after
 *    the launch await, so a client disconnect during the launch window
 *    (launch timeout + proxy validation can take tens of seconds) never fired
 *    the listener and the acquired browser leaked until container restart.
 *  - [TOOL-C3] `acquireIsolatedBrowser` keeps a per-runKey in-flight promise
 *    map so two simultaneous SSE connects for one runId join ONE launch
 *    instead of double-launching Chrome and corrupting refCount accounting.
 *  - [TOOL-C1] The HTTP server binds to HOST (default 127.0.0.1, was 0.0.0.0)
 *    and, when MCP_BEARER_TOKEN is set, every non-/health route requires an
 *    `Authorization: Bearer <token>` header.
 *
 * The lifecycle functions are exported so tests exercise the REAL server
 * module via import (with injected browser stubs) instead of copied logic.
 */

import path from "node:path";
import express from "express";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { PROFILES } from "./profiles.js";
import {
  closeEphemeralBrowser,
  isSharedBrowserFallbackAllowed,
  launchEphemeralBrowser,
} from "./shared/browser.js";
import { probeBrowserEndpoint } from "../shared/browser-health.js";
import { decodeUriEverywhere } from "./shared/tool-runtime.js";
import {
  getToolCatalog,
  getToolDefinitions,
  getToolSpec,
} from "./tool-registry.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
// [TOOL-C1] localhost-by-default; containers that need external reach set HOST explicitly.
const HOST = process.env.HOST || "127.0.0.1";
const MCP_BEARER_TOKEN = String(process.env.MCP_BEARER_TOKEN || "").trim();
const BROWSER_WS = process.env.BROWSER_WS_ENDPOINT || "ws://127.0.0.1:9223";
const BROWSER_MODE = process.env.MCP_BROWSER_MODE || "isolated";
const RUN_BROWSER_REUSE_ENABLED =
  String(process.env.MCP_REUSE_BROWSER_BY_RUN ?? "true").toLowerCase() !==
  "false";
const RUN_BROWSER_TTL_MS = Math.max(
  1000,
  parseInt(process.env.MCP_RUN_BROWSER_TTL_MS || "120000", 10),
);

function buildServer(profileName, browserSession) {
  const allowedTools = PROFILES[profileName];
  const server = new McpServer({
    name: `owc-pw-${profileName}`,
    version: "1.0.0",
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

  console.log(
    `[MCP-PW] Profile '${profileName}' registered tools: [${allowedTools.join(", ")}]`,
  );
  return server;
}

const app = express();
app.use(express.json());

// [TOOL-C1] Optional bearer-token gate. /health stays open so orchestrators
// and container healthchecks keep working without credentials.
if (MCP_BEARER_TOKEN) {
  app.use((req, res, next) => {
    if (req.path === "/health") {
      return next();
    }
    const authorization = req.headers.authorization || "";
    if (authorization !== `Bearer ${MCP_BEARER_TOKEN}`) {
      return res.status(401).json({
        error: "Unauthorized: missing or invalid bearer token",
      });
    }
    return next();
  });
}

// Active SSE sessions: sessionId -> { transport, profile, browserSession }
const sessions = new Map();
// runKey -> { browserSession, refCount, closeTimer }
const runBrowsers = new Map();
// [TOOL-C3] runKey -> Promise<browserSession>; lets concurrent SSE connects
// for the same run join ONE in-flight launch instead of double-launching.
const launchesInFlight = new Map();

/** Exposed read-only for tests/diagnostics. */
export const _lifecycleState = { sessions, runBrowsers, launchesInFlight };

/**
 * Resolve the additive target context from the SSE connect query
 * (`targetUrl` / `targetHost`, sent by the Python MCP client).
 *
 * The host is derived from targetUrl when it parses (authoritative); the raw
 * `targetHost` query value is only trusted after strict character validation.
 * Anything missing/malformed resolves to empty strings — sessions without a
 * known target keep the legacy profile-only jar behavior.
 */
export function resolveTargetContext(req) {
  const rawTargetUrl = String(req?.query?.targetUrl || "").trim();
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
    } catch {
      // Malformed URL: fall through to the validated host-only path.
    }
  }
  if (!targetHost && /^[a-z0-9._-]+$/.test(rawTargetHost)) {
    targetHost = rawTargetHost;
  }
  return { targetHost, targetUrl };
}

/**
 * Stable per-run browser reuse key.
 *
 * Includes profile and target host so two jars keyed by different
 * (profile,target-host) pairs can never share one reused browser: the jar
 * identity is decided inside launchEphemeralBrowser, so the reuse key must be
 * at least as specific as the jar key. Runs without a known target keep the
 * legacy `run:<runId>` shape.
 */
export function runBrowserKey(req, profile = "") {
  const runId = String(req.query?.runId || "").trim();
  if (!RUN_BROWSER_REUSE_ENABLED || BROWSER_MODE !== "isolated" || !runId)
    return "";
  const sanitizedRun = runId.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const { targetHost } = resolveTargetContext(req);
  if (!targetHost) return `run:${sanitizedRun}`;
  const sanitizedProfile = String(profile || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_-]/g, "_");
  return `run:${sanitizedRun}|${sanitizedProfile}|${targetHost}`;
}

/**
 * Acquire an isolated browser for a session.
 *
 * deps.launchEphemeralBrowser / deps.closeEphemeralBrowser are injectable so
 * tests can drive this REAL function with stubs (launch-count assertions).
 */
export async function acquireIsolatedBrowser(
  { sessionId, profile, runKey, target },
  deps = {},
) {
  const launchFn = deps.launchEphemeralBrowser || launchEphemeralBrowser;
  const closeFn = deps.closeEphemeralBrowser || closeEphemeralBrowser;
  const targetHost = String(target?.targetHost || "").trim();
  const targetUrl = String(target?.targetUrl || "").trim();

  if (runKey) {
    const existing = runBrowsers.get(runKey);
    if (existing?.browserSession) {
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = null;
      }
      existing.refCount += 1;
      console.log(
        `[MCP-PW] Reusing isolated run browser ${runKey} for ${sessionId} (${profile})`,
      );
      return existing.browserSession;
    }

    // [TOOL-C3] Join an already in-flight launch for this runKey. Both
    // callers end up with the SAME browserSession and each holds one ref.
    const inFlight = launchesInFlight.get(runKey);
    if (inFlight) {
      console.log(
        `[MCP-PW] Joining in-flight launch for ${runKey} (${sessionId})`,
      );
      const joinedSession = await inFlight;
      const entry = runBrowsers.get(runKey);
      if (entry?.browserSession === joinedSession) {
        entry.refCount += 1;
      }
      // If the map entry vanished/mismatched, releaseBrowserSession's
      // mismatch branch closes this session directly on release.
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
  if (runKey) {
    launchesInFlight.set(runKey, launchPromise);
  }

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

export async function releaseBrowserSession(session, deps = {}) {
  const closeFn = deps.closeEphemeralBrowser || closeEphemeralBrowser;
  const ttlMs = Number.isFinite(deps.ttlMs) ? deps.ttlMs : RUN_BROWSER_TTL_MS;

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
    closeFn(current.browserSession).catch((error) => {
      console.error(
        `[MCP-PW] Failed to close run browser ${session.runKey}:`,
        error,
      );
    });
  }, Math.max(0, ttlMs));
}

export async function closeSession(sessionId, deps = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;

  sessions.delete(sessionId);
  await releaseBrowserSession(session, deps);
  console.log(`[MCP-PW] Session closed: ${sessionId} (${session.profile})`);
}

app.get("/health", async (_req, res) => {
  const browser = await probeBrowserEndpoint(BROWSER_WS);
  const healthy = browser.healthy;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    engine: "playwright",
    profiles: Object.keys(PROFILES),
    browser_mode: BROWSER_MODE,
    run_browser_reuse: RUN_BROWSER_REUSE_ENABLED,
    active_run_browsers: runBrowsers.size,
    shared_browser_fallback: BROWSER_WS,
    browser,
  });
});

app.get("/tools", (_req, res) => {
  res.json(getToolCatalog());
});

app.get("/tools/:toolName", (req, res) => {
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

/**
 * Establish one SSE MCP session: acquire a browser, register the session,
 * connect the transport. Exported for lifecycle tests.
 *
 * [TOOL-C2]: the `close` listener is attached BEFORE the first await, so a
 * client abort at ANY point of the setup window releases the browser:
 *   - abort mid-launch  -> post-acquire `res.destroyed` check releases;
 *   - abort post-launch -> close handler releases directly;
 *   - close after setup -> normal closeSession path releases.
 */
export async function establishSseSession({ req, res, profile, transport, deps = {} }) {
  const runKey = runBrowserKey(req, profile);
  const target = resolveTargetContext(req);
  let browserSession = null;
  let setupComplete = false;

  res.on("close", () => {
    if (setupComplete) {
      closeSession(transport.sessionId, deps).catch((err) => {
        console.error(
          `[MCP-PW] Failed to close session ${transport.sessionId}:`,
          err,
        );
      });
      return;
    }
    // Client went away before the session was registered: make sure nothing
    // we already acquired leaks ([TOOL-C2] permanent-leak fix).
    console.warn(
      `[MCP-PW] Client disconnected before session setup completed (${transport.sessionId})`,
    );
    const orphan = browserSession;
    browserSession = null;
    if (orphan) {
      releaseBrowserSession({ browserSession: orphan, runKey }, deps).catch(
        (err) => {
          console.error(
            `[MCP-PW] Failed to release aborted-session browser:`,
            err,
          );
        },
      );
    }
  });

  if (BROWSER_MODE === "isolated") {
    try {
      browserSession = await acquireIsolatedBrowser(
        {
          sessionId: transport.sessionId,
          profile,
          runKey,
          target,
        },
        deps,
      );
      console.log(
        `[MCP-PW] Isolated browser started for ${transport.sessionId}`,
      );
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
        error:
          "Isolated browser launch failed and shared browser fallback is disabled by proxy settings.",
      });
    }
    try {
      const { connectBrowser } = await import("./shared/browser.js");
      browserSession = await connectBrowser(BROWSER_WS);
    } catch (err) {
      console.error(`[MCP-PW] Shared browser connect failed:`, err);
      return res.status(503).json({
        error:
          "Unable to create or attach a browser session for this Playwright MCP session.",
      });
    }
  }

  // [TOOL-C2] The client may have aborted while we awaited the launch above
  // (the 'close' event fired while browserSession was still null). Release
  // whatever we acquired instead of serving a dead socket with a live Chrome.
  if (res.destroyed || res.writableEnded) {
    const orphan = browserSession;
    browserSession = null;
    if (orphan) {
      await releaseBrowserSession({ browserSession: orphan, runKey }, deps);
    }
    return undefined;
  }

  const server = buildServer(profile, browserSession);

  sessions.set(transport.sessionId, { transport, profile, browserSession, runKey });
  setupComplete = true;

  await server.connect(transport);
  return server;
}

app.get("/mcp/:profile/sse", (req, res) => {
  const { profile } = req.params;

  if (!PROFILES[profile]) {
    return res.status(404).json({
      error: `Unknown profile: '${profile}'`,
      available: Object.keys(PROFILES),
    });
  }

  console.log(`[MCP-PW] New session -> profile: ${profile}`);

  const transport = new SSEServerTransport("/mcp/message", res);
  establishSseSession({ req, res, profile, transport }).catch((error) => {
    console.error(`[MCP-PW] SSE session setup failed:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: "SSE session setup failed" });
    }
  });
});

app.post("/mcp/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  await session.transport.handlePostMessage(req, res, req.body);
});

// [TOOL-C1] Bind to HOST (default 127.0.0.1) instead of every interface.
function startListening() {
  app.listen(PORT, HOST, () => {
    console.log(`[MCP-PW] Playwright MCP server running on ${HOST}:${PORT}`);
    console.log(`[MCP-PW] Auth: ${MCP_BEARER_TOKEN ? "bearer token required" : "none"}`);
    console.log(`[MCP-PW] Browser mode: ${BROWSER_MODE}`);
    console.log(`[MCP-PW] Shared browser fallback: ${BROWSER_WS}`);
    console.log("[MCP-PW] Profiles:");
    for (const [name, tools] of Object.entries(PROFILES)) {
      console.log(`      /mcp/${name}/sse  ->  [${tools.join(", ")}]`);
    }
  });
}

// Only auto-start when executed directly (`node mcp-server.js`); importing the
// module (tests, tooling) must not bind ports or spawn browsers.
const isMainModule =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  startListening();
}
