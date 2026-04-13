# Playwright vs Puppeteer — Architecture & Feature Differentiation

## Overview

The system supports two browser engines: **Puppeteer** (port 3000) and **Playwright** (port 3002 externally, 3001 internally). The active engine is selected via the Settings UI and stored as `browser_engine` in `data/settings.runtime.yaml`. Switching takes effect immediately in-memory and persists across container restarts.

---

## Key Architectural Differences

### 1. Session Isolation Model

| | Puppeteer | Playwright |
|---|---|---|
| Browser instances | One shared Chrome per container | One ephemeral browser **per SSE session** |
| Context isolation | Shared (state leaks between runs) | `BrowserContext` per session — cookies, storage, cache fully isolated |
| Teardown | Connection closed by tool | Full `browser.close()` on SSE disconnect |

**Playwright implementation:** `launchEphemeralBrowser()` in `shared/browser.js` — each MCP session gets its own browser process via `chromium.launch()`. The MCP server (`mcp-server.js`) creates the session on SSE connect and tears it down on SSE close via `closeEphemeralBrowser()`.

This eliminates cross-run state leakage that appears at scale with the Puppeteer shared-Chrome model (cookie bleed, cached auth states, old service workers).

---

### 2. Ad Blocking

| | Puppeteer | Playwright |
|---|---|---|
| Method | uBlock Origin Lite Chrome extension (loaded at browser launch) | `context.route()` network-level interception |
| Scope | Extension-level, extension must load before navigation | Applied at context creation, active from the first request |
| Per-session control | Not possible without relaunching | `pageBlockingDisabled` WeakSet — per-page disable without context teardown |
| Cross-origin iframes | Extension handles (unreliable on certain CSP pages) | Route handler fires on all requests in the context including cross-origin iframes |

**Playwright implementation:** `shared/adblocker.js` — attaches a `context.route()` handler using the same filter lists. The auto-recovery system in `shared/browser.js` can disable blocking per-page when a player request is blocked, then reload, without touching other pages in the context.

---

### 3. CDP Access

| | Puppeteer | Playwright |
|---|---|---|
| CDP scope | Browser-wide DevTools session | Page-scoped via `page.context().newCDPSession(page)` |
| Cross-frame coverage | One session covers main frame only | CDP session is page-scoped; Playwright's `context.on('response')` covers all frames |

**Playwright implementation:** `tools/harvest.js` uses:
- `page.context().newCDPSession(page)` for `Network.requestWillBeSent` (low-level, before-send interception)
- `context.on('response')` (not `page.on`) for cross-origin iframe response capture — this is the key difference vs Puppeteer where `page.on('response')` could miss cross-origin frame traffic

---

### 4. Network Wait Conditions

| | Puppeteer | Playwright |
|---|---|---|
| Idle condition | `networkidle0` (0 connections) / `networkidle2` (≤2 connections) | `networkidle` (0 connections for 500ms) |
| Additional states | N/A | `commit` (navigation committed, before load) |

**Playwright implementation:** `tools/navigate.js` and `tools/navigation-tools.js` normalize Puppeteer aliases:
- `networkidle0` → `networkidle`
- `networkidle2` → `networkidle`

The tool schemas now use `networkidle` as the default with the Puppeteer aliases accepted for backward compatibility.

---

### 5. Fingerprinting & Stealth

Both engines use the same stealth stack: `playwright-extra` + `puppeteer-extra-plugin-stealth` + `fingerprint-injector`. The implementation is equivalent.

**Playwright-specific advantage:** Fingerprints are injected at the **context level** via `context.addInitScript()` — this means fingerprinting applies to all pages and cross-origin iframes within the context automatically, not just the top-level page.

---

### 6. Frame Handling

| | Puppeteer | Playwright |
|---|---|---|
| Frame enumeration | `page.frames()` | `page.frames()` / `frame.childFrames()` |
| Frame wait | `page.waitForFrame()` | `page.frameLocator()` / `frame.waitForSelector()` |
| Cross-origin iframes | CDP required for cross-origin access | Native cross-origin support via `frame.evaluate()` with `bypassCSP: true` on context |

**Playwright implementation:** Context is created with `bypassCSP: true` — cross-origin iframe JS evaluation works without CDP bypasses.

---

## Tool-by-Tool Status

| Tool | Session handling | Playwright-native features used |
|---|---|---|
| `navigate` | `connectBrowser` + `finally disconnect()` | `page.waitForLoadState('networkidle')`, fallback wait chain |
| `inspect` | `connectBrowser` + `disconnect()` | `page.frames()`, `frame.childFrames()`, `frame.evaluate()` |
| `inspect_landing` | `withBrowserSession` | Context-scoped fingerprinting, `page.frames()` |
| `inspect_hosting` | `withBrowserSession` | Same |
| `inspect_embedded` | `withBrowserSession` | Same |
| `screenshot` | `connectBrowser` + `disconnect()` | `page.screenshot()` with Playwright buffer API |
| `harvest` | `connectBrowser` + `disconnect()` | `page.context().newCDPSession()`, **`context.on('response')`** (cross-origin) |
| `interact` | Inline session check + `disconnect()` if owned | `frame.waitForSelector()`, `frame.$$()`, `page.waitForLoadState()` |
| `open_url` | `withBrowserSession` | `page.waitForLoadState('networkidle')`, challenge detection via `frame.waitForFunction()` |
| `context-tools` | `withBrowserSession` | `page.accessibility`, `page.frames()` |
| `navigation-tools` | `withBrowserSession` | `page.waitForLoadState()`, `context.on('page')` for new tabs |
| `action-tools` | `withBrowserSession` | `page.mouse`, `page.keyboard`, Playwright locator API |
| `extraction-tools` | `withBrowserSession` | `context.route()` for stream interception |
| `memory-tools` | No browser (file store) | N/A |

---

## MCP Switch Logic

The active engine is stored in `data/settings.runtime.yaml` as `browser_engine`. On load (`Settings.from_yaml()`), `mcp_server_url` is derived:

```
browser_engine = "playwright"  →  mcp_server_url = MCP_SERVER_URL_PLAYWRIGHT  (http://owc-tools-playwright:3001)
browser_engine = "puppeteer"   →  mcp_server_url = MCP_SERVER_URL_PUPPETEER   (http://owc-tools:3000)
```

This ensures the correct MCP server is targeted both in-memory (immediate after settings save) and after container restarts.

---

## Container Layout

```
owc-tools           (Dockerfile.tools)          :3000  Puppeteer MCP + Chrome :9222
owc-tools-playwright (Dockerfile.tools.playwright) :3002→:3001  Playwright MCP + Chrome :9223
owc                  (Dockerfile)               :8000  Python API (connects to either)
```
