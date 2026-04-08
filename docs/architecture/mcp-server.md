# MCP Server & Browser Tools

> **See also:** [Overview](overview.md) · [Agents](agents.md) · [Browser Tools Reference](../tools/browser-tools.md) · [← Docs Home](../README.md)

---

## What Is the MCP Server?

The MCP (Model Context Protocol) server is a **Node.js Express application** that exposes
Puppeteer-based browser tools to Python agents via Server-Sent Events (SSE).

**File:** [`tools_js/mcp-server.js`](../../tools_js/mcp-server.js)

Each agent connects to a **profile-specific SSE endpoint**. The server creates a new
`McpServer` instance for that connection and registers **only the tools allowed by that
profile**. The LLM agent physically cannot call tools outside its profile.

In the isolated-browser setup, each SSE session also gets its own temporary
browser instance. That makes agent sessions parallelizable without sharing page
state, cookies, tabs, or overlays across agents.

---

## Architecture

```
Python Agent (async context manager)
        │
        │  GET /mcp/{profile}/sse          POST /mcp/message?sessionId=xxx
        │──────────────────────────────▶  ──────────────────────────────▶
        │                                                                 │
        │              MCP Server (Express)                              │
        │  ┌──────────────────────────────────────────────────────────┐  │
        │  │  app.get('/mcp/:profile/sse', (req, res) => {           │  │
        │  │    const server = buildServer(profile);  // filtered     │  │
        │  │    const transport = new SSEServerTransport(res);        │  │
        │  │    sessions.set(transport.sessionId, transport);         │  │
        │  │    await server.connect(transport);                      │  │
        │  │  });                                                     │  │
        │  │                                                          │  │
        │  │  app.post('/mcp/message', async (req, res) => {         │  │
        │  │    const transport = sessions.get(req.query.sessionId); │  │
        │  │    await transport.handlePostMessage(req, res, req.body);│  │
        │  │  });                                                     │  │
        │  └──────────────────────────────────────────────────────────┘  │
        │                                                                 │
        │              Tool Handler (e.g. harvest.js)                    │
        │  ┌──────────────────────────────────────────────────────────┐  │
        │  │  puppeteer.connect(sessionBrowserWsEndpoint)            │  │
        │  │  CDP intercept / page.evaluate / ...                    │  │
        │  │  upload screenshot to Cloudinary                        │  │
        │  │  return structured JSON                                  │  │
        │  └──────────────────────────────────────────────────────────┘  │
```

---

## Profile-Based Tool Isolation

**File:** [`tools_js/profiles.js`](../../tools_js/profiles.js)

```javascript
export const PROFILES = {
  classification: ['inspect', 'navigate'],
  landing:        ['inspect', 'navigate', 'interact', 'screenshot'],
  hosting:        ['inspect', 'interact', 'harvest', 'screenshot', 'navigate'],
  embedded:       ['inspect', 'interact', 'harvest', 'screenshot', 'navigate'],
};
```

When an agent connects with profile `classification`, only `inspect` and `navigate`
are registered on its `McpServer` instance. Calling `harvest` from a classification
agent returns "unknown tool" — not a permission error, the tool simply doesn't exist.

---

## Python MCP Client

**File:** [`src/tools/mcp_client.py`](../../src/tools/mcp_client.py)

```python
@asynccontextmanager
async def agent_tools(profile: str, settings: Settings, observer: RunObserver | None = None):
  url = f"{settings.mcp_server_url}/mcp/{profile}/sse"
  client = MultiServerMCPClient({profile: {"url": url, "transport": "sse"}})
  tools = await asyncio.wait_for(client.get_tools(), timeout=settings.tool_timeout_seconds)
  yield tools  # list[BaseTool]
```

Usage in an agent:

```python
async with agent_tools("hosting", self.settings) as tools:
    result = await run_agent_loop(llm=self.llm, tools=tools, ...)
```

`langchain-mcp-adapters` (`MultiServerMCPClient`) handles the SSE handshake, converts
MCP tool schemas to LangChain `BaseTool` objects, and routes tool calls back
to the MCP server via HTTP POST. The runtime adds timeout guards and session lifecycle
events so failures surface explicitly in operator traces.

---

## The 5 Browser Tools

### `inspect`

**File:** [`tools_js/tools/inspect.js`](../../tools_js/tools/inspect.js)

Full DOM scan of the current page. Returns everything the LLM needs to understand
the page structure and decide its next action.

**Input:**
```json
{ "url": "https://..." }
```

**Output:**
```json
{
  "title": "...",
  "url": "...",
  "content_links": [{"text": "...", "href": "...", "type": "..."}],
  "nav_links": [...],
  "buttons": [{"text": "...", "selector": "...", "x": 0, "y": 0}],
  "iframes": [{"src": "...", "id": "...", "sandbox": "..."}],
  "videos": [{"src": "...", "type": "...", "poster": "..."}],
  "elements": [...],
  "hosting_signals": {
    "has_video_player": true,
    "has_server_tabs": true,
    "detected_player_type": "hls.js",
    "iframe_count": 2
  },
  "popups": [...],
  "dom_skeleton": "...",
  "pagination": {...},
  "screenshot_url": "https://res.cloudinary.com/...",
  "stats": {"total_links": 42, "total_buttons": 8}
}
```

---

### `interact`

**File:** [`tools_js/tools/interact.js`](../../tools_js/tools/interact.js)

6 interaction modes for triggering player loading and server switching.

**Modes:**

| Mode | Use case |
|------|---------|
| `click` | Click by CSS selector, XPath, or text content |
| `play` | Find and click a play/watch button |
| `type` | Fill a text input |
| `select` | Choose from a `<select>` dropdown |
| `coordinates` | Click at `(x, y)` viewport position (for cross-origin iframes) |
| `check` | Check a checkbox |

**Input:**
```json
{
  "mode": "click",
  "selector": ".server-btn:nth-child(2)",
  "description": "Server 2 button"
}
```
or for coordinates:
```json
{
  "mode": "coordinates",
  "x": 640,
  "y": 360,
  "description": "center of embedded player"
}
```

**Output:**
```json
{
  "success": true,
  "navigated": false,
  "new_url": null,
  "screenshot_url": "https://res.cloudinary.com/..."
}
```

> **`navigated` flag is critical.** If `true`, the browser has left the target page.
> The agent must check this and potentially navigate back.

---

### `harvest`

**File:** [`tools_js/tools/harvest.js`](../../tools_js/tools/harvest.js)

6-layer stream URL capture. The most important tool for stream extraction.

**Detection Layers:**

| Layer | Method | Detects |
|-------|--------|---------|
| 1 | CDP `Network.requestWillBeSent` | All XHR/fetch requests as they fire |
| 2 | CDP `Network.responseReceived` | Response content-type filtering |
| 3 | DOM scan | `<video src>`, `<source src>`, `data-src` attributes |
| 4 | iframe src list | iframe elements pointing to video CDNs |
| 5 | JS player objects | `hls.js` (`Hls.url`), `video.js` (`player.src()`), JW Player API |
| 6 | Performance entries | `performance.getEntriesByType('resource')` for .m3u8/.mpd/.mp4 |

**Input:**
```json
{ "waitMs": 3000 }
```

**Output:**
```json
{
  "m3u8_urls": ["https://cdn.example.com/hls/stream.m3u8"],
  "mpd_urls": [],
  "mp4_urls": [],
  "video_state": {
    "is_playing": true,
    "current_time": 4.2,
    "duration": 5400
  },
  "screenshot_url": "https://res.cloudinary.com/..."
}
```

---

### `navigate`

**File:** [`tools_js/tools/navigate.js`](../../tools_js/tools/navigate.js)

Navigate to a URL, capture the redirect chain, detect domain changes.

**Input:**
```json
{ "url": "https://...", "waitUntil": "networkidle2" }
```

**Output:**
```json
{
  "final_url": "https://...",
  "redirect_chain": ["https://original.com", "https://cdn.com/..."],
  "domain_warning": false,
  "title": "...",
  "screenshot_url": "https://res.cloudinary.com/..."
}
```

`domain_warning: true` means the navigation landed on a different domain than expected
(e.g., redirected to a login page or ad page). The agent should handle this case.

---

### `screenshot`

**File:** [`tools_js/tools/screenshot.js`](../../tools_js/tools/screenshot.js)

Lightweight screenshot capture without a full DOM scan. Faster than `inspect`.

**Input:**
```json
{
  "mode": "viewport",
  "selector": null
}
```
Modes: `viewport` (default), `full` (full page), `element` (specific CSS selector).

**Output:**
```json
{
  "screenshot_url": "https://res.cloudinary.com/...",
  "video_state": {
    "is_playing": false,
    "has_player": true
  }
}
```

---

## Shared Modules

**Directory:** [`tools_js/shared/`](../../tools_js/shared/)

| Module | Exports | Purpose |
|--------|---------|---------|
| `browser.js` | `connectBrowser(wsEndpoint)`, isolated browser helpers | Connect to or launch per-session browser instances |
| `upload.js` | `uploadScreenshot(buffer)` | Cloudinary upload with timeout + error handling |
| `screenshot.js` | `screenshotViewport`, `screenshotFull`, `screenshotElement` | Screenshot helpers used by all tools |
| `adblocker.js` | `enableBlocking(page)` | Ghostery-backed blocking with cached filterlists and explicit network/cosmetic mode flags |

---

## Adding a New Tool

1. Create `tools_js/tools/mytool.js` — export a Zod schema + async handler function
2. Import and register in `tools_js/mcp-server.js` in the `TOOL_MAP`
3. Add to relevant profiles in `tools_js/profiles.js`
4. The Python side needs no changes — `agent_tools()` auto-discovers tools via MCP

---

*Next: [Data Flow](data-flow.md) | [Browser Tools Reference](../tools/browser-tools.md)*
