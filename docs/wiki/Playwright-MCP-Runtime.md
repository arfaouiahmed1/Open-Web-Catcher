# Playwright MCP Runtime

The browser execution environment runs in a dedicated container (`owc-tools-playwright`) using **Playwright 1.62.1** and Chromium. It exposes an official Model Context Protocol (MCP) server over Streamable HTTP/SSE.

---

## The Six MCP Tools

1. **`navigate`**: Loads URLs with configurable wait conditions (`domcontentloaded`, `networkidle`, `load`) and timeout policies.
2. **`inspect`**: Extracts accessible DOM representations, semantic accessibility trees, frame hierarchies, or raw HTML snippets.
3. **`interact`**: Simulates human interactions (clicks, keyboard input, select options, scroll gestures, coordinate clicks) with anti-detect timing.
4. **`harvest`**: Collects network-captured media requests, HLS `.m3u8` playlists, DASH `.mpd` manifests, and audio/video segments.
5. **`screenshot`**: Captures viewport or full-page screenshots encoded as base64 or stored as content-addressed local blobrefs.
6. **`wait`**: Implements bounded waiting for selectors, network idle states, DOM mutations, or media playback start.

---

## Adblocking & Sandbox Defense

- **uBlock Origin Lite (MV3)**: Baked into the container runtime and initialized with the *Optimal* rule set to strip malicious tracking scripts, popup traps, and crypto miners before page execution.
- **Iframe Recovery**: Detects `X-Frame-Options` and CSP `frame-ancestors` denials, automatically falling back to direct context navigation.
- **Storage State Persistence**: Maintains clean session jars keyed by `(runId, profile, browserScopeId)` without cross-run contamination.
