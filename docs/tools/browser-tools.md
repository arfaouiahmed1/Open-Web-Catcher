# Browser Tools Reference

> **See also:** [MCP Server Architecture](../architecture/mcp-server.md) · [Python Tools](python-tools.md) · [← Docs Home](../README.md)

All browser tools run inside the Node.js MCP server (`tools_js/`). They connect to
Chrome via DevTools Protocol (CDP) WebSocket and return structured JSON.

## Agent-Specific Tool Sets

- [Classification Agent](classification/README.md)
- [Landing Agent](landing/README.md)
- [Hosting Agent](hosting/README.md)
- [Embedded Agent](embedded/README.md)

---

## Tool-to-Profile Mapping

| Tool | classification | landing | hosting | embedded |
|------|:--------------:|:-------:|:-------:|:--------:|
| `inspect` | ✓ | ✓ | ✓ | ✓ |
| `navigate` | ✓ | ✓ | ✓ | ✓ |
| `interact` | | ✓ | ✓ | ✓ |
| `screenshot` | | ✓ | ✓ | ✓ |
| `harvest` | | | ✓ | ✓ |

---

## `inspect`

**File:** [`tools_js/tools/inspect.js`](../../tools_js/tools/inspect.js)

Full DOM scan. The primary tool for understanding any page. Most agent turns start with `inspect`.

### Input Schema

```typescript
{
  url?: string  // optional — if omitted, scans the current page
}
```

### Output Schema

```typescript
{
  title: string
  url: string

  // Navigation and content links
  content_links: Array<{
    text: string
    href: string
    type: "internal" | "external" | "stream" | "social"
    context: string  // surrounding text
  }>
  nav_links: Array<{ text: string, href: string }>

  // Interactive elements with viewport coords
  buttons: Array<{
    text: string
    selector: string
    x: number       // viewport X (for coordinate-mode fallback)
    y: number       // viewport Y
    visible: boolean
  }>

  // iframes (key for hosted players)
  iframes: Array<{
    src: string
    id: string
    sandbox: string
    dimensions: { width: number, height: number }
  }>

  // Native video elements
  videos: Array<{
    src: string
    type: string
    poster: string
    is_playing: boolean
  }>

  // All interactive elements
  elements: Array<{
    tag: string
    text: string
    selector: string
    x: number
    y: number
    attributes: Record<string, string>
  }>

  // Player detection signals
  hosting_signals: {
    has_video_player: boolean
    has_server_tabs: boolean
    detected_player_type: "hls.js" | "video.js" | "jwplayer" | "native" | null
    iframe_count: number
    m3u8_in_source: boolean
    known_streaming_domains: string[]
  }

  // Detected popups/overlays (often need dismissal)
  popups: Array<{
    selector: string
    type: "ad" | "cookie" | "modal" | "overlay"
    dismiss_selector: string
  }>

  // Condensed page structure for LLM context
  dom_skeleton: string

  // Pagination info
  pagination: {
    has_pagination: boolean
    current_page: number | null
    total_pages: number | null
    next_selector: string | null
  }

  // Visual evidence
  screenshot_url: string  // Cloudinary URL

  stats: {
    total_links: number
    total_buttons: number
    total_iframes: number
    total_videos: number
  }
}
```

---

## `interact`

**File:** [`tools_js/tools/interact.js`](../../tools_js/tools/interact.js)

Performs user interactions. Includes anti-bot simulation (realistic delays, bezier mouse paths).

### Input Schema

```typescript
// Mode: click
{
  mode: "click"
  selector?: string    // CSS selector
  xpath?: string       // XPath expression
  text?: string        // element text content
  description: string  // human-readable description for logs
}

// Mode: play
{
  mode: "play"
  description: string
}

// Mode: type
{
  mode: "type"
  selector: string
  value: string
  description: string
}

// Mode: select
{
  mode: "select"
  selector: string
  value: string
  description: string
}

// Mode: coordinates (for cross-origin iframes)
{
  mode: "coordinates"
  x: number
  y: number
  description: string
}

// Mode: check
{
  mode: "check"
  selector: string
  description: string
}
```

### Output Schema

```typescript
{
  success: boolean
  mode: string
  element_found: boolean
  navigated: boolean      // TRUE = browser left the target page
  new_url: string | null  // URL after navigation (if navigated)
  screenshot_url: string
  error: string | null
}
```

> **Always check `navigated`.** If `true`, the click navigated away from the target
> page (e.g., a "server" link was actually a redirect). The agent should navigate back
> to the original hosting page.

### Element Resolution Priority

When using `mode: click`, the tool tries to find the element in this order:
1. CSS `selector`
2. XPath `xpath`
3. Text content match (`text`)
4. Falls back to coordinates if all fail (uses centre of viewport)

---

## `harvest`

**File:** [`tools_js/tools/harvest.js`](../../tools_js/tools/harvest.js)

Stream URL capture using 6 detection layers in parallel. The core extraction tool.

### When to Use

Call `harvest` **after** triggering the player (via `interact`). The tool waits
`waitMs` milliseconds for network requests to fire, then collects from all layers.

### Input Schema

```typescript
{
  waitMs?: number  // default 3000 — how long to wait for streams (ms)
}
```

### Detection Layers

```
Layer 1: CDP Network.requestWillBeSent
         → Intercepts every outgoing XHR/fetch as it's initiated
         → Catches .m3u8, .mpd, .mp4, video/* content-types

Layer 2: CDP Network.responseReceived
         → Checks response Content-Type headers
         → Catches streams served with video/* MIME types

Layer 3: DOM element scan
         → document.querySelectorAll('video, source, [data-src], [src]')
         → Finds hardcoded video URLs in HTML

Layer 4: iframe src list
         → Lists all iframe srcs
         → Identifies video CDN iframes (different from inspect's approach)

Layer 5: JS player API inspection
         → hls.js:     window.Hls instances → hls.url
         → video.js:   videojs.getPlayers() → player.currentSrc()
         → JW Player:  jwplayer() → player.getPlaylistItem()
         → Flowplayer: flowplayer instances

Layer 6: Performance entries
         → performance.getEntriesByType('resource')
         → Finds resources loaded since page start, filtered by extension
```

### Output Schema

```typescript
{
  m3u8_urls: string[]
  mpd_urls: string[]
  mp4_urls: string[]
  video_state: {
    is_playing: boolean
    current_time: number
    duration: number
    paused: boolean
    has_player: boolean
    player_type: string | null
  }
  screenshot_url: string
  layers_used: string[]  // which detection layers found results
  total_found: number
}
```

### Deduplication

URLs are deduplicated across all layers before being returned. The same URL found
by both CDP and JS player inspection is only returned once.

---

## `navigate`

**File:** [`tools_js/tools/navigate.js`](../../tools_js/tools/navigate.js)

Navigate to a URL and capture the redirect chain.

### Input Schema

```typescript
{
  url: string
  waitUntil?: "load" | "networkidle0" | "networkidle2"  // default "networkidle2"
  timeout?: number  // ms, default 30000
}
```

### Output Schema

```typescript
{
  final_url: string
  redirect_chain: string[]    // all URLs in the redirect chain
  domain_warning: boolean     // true if final domain ≠ original domain
  domain_changed_to: string | null
  title: string
  screenshot_url: string
  load_time_ms: number
}
```

### `domain_warning`

If the navigation lands on a different base domain (e.g., navigating from
`site.com/match/123` to `login.site.com` or `adserver.xyz`), `domain_warning` is `true`.
The agent should handle this — likely by navigating back to the original URL.

---

## `screenshot`

**File:** [`tools_js/tools/screenshot.js`](../../tools_js/tools/screenshot.js)

Quick screenshot without a full DOM scan. ~3× faster than `inspect`.

### When to Use

Use `screenshot` when you need visual evidence but already know the page structure.
Use `inspect` when you need both structure and a screenshot.

### Input Schema

```typescript
{
  mode?: "viewport" | "full" | "element"  // default "viewport"
  selector?: string  // CSS selector (only for mode "element")
}
```

### Output Schema

```typescript
{
  screenshot_url: string  // Cloudinary URL
  video_state: {
    is_playing: boolean
    has_player: boolean
    current_time: number | null
  }
  dimensions: { width: number, height: number }
}
```

---

## Shared Utilities

**Directory:** [`tools_js/shared/`](../../tools_js/shared/)

### `browser.js`

```javascript
export async function connectBrowser(wsEndpoint) {
  // puppeteer.connect() with retry (5 attempts, 1s delay)
  // Returns { browser, page }
}
```

### `upload.js`

```javascript
export async function uploadScreenshot(buffer, options = {}) {
  // Uploads PNG buffer to Cloudinary
  // Timeout: 10s
  // Returns: secure URL string or null on failure
}
```

### `screenshot.js`

```javascript
export async function screenshotViewport(page)   // viewport only
export async function screenshotFull(page)        // full page scroll
export async function screenshotElement(page, selector)  // specific element
// All functions: capture → upload → return URL
```

### `adblocker.js`

```javascript
export async function enableBlocking(page) {
  // Cosmetic-only filtering with uBO-style filterlists
  // Reads rules from tools_js/shared/filterlists/*.txt
  // Supports common rules like ##selector, example.com##selector, and #@# exceptions
  // Does not block network requests
}
```

---

*Next: [Python Tools](python-tools.md) | [MCP Server Architecture](../architecture/mcp-server.md)*
