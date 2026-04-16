# Playwright vs Puppeteer — Parity, Contracts, and Upgrades

## Overview

The project ships two MCP browser engines:
- **Puppeteer:** `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/puppeteer`
- **Playwright:** `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/playwright`

Runtime selection is controlled by `browser_engine` in `data/settings.runtime.yaml`.

---

## Parity Matrix (Tool Name, Intent, Contract)

| Group | Tool | Puppeteer | Playwright | Contract parity |
|---|---|---:|---:|---|
| Context | `get_page_context` | ✅ | ✅ | Same intent and envelope keys |
| Context | `query_elements` | ✅ | ✅ | Same filters, regex support, element refs |
| Context | `get_element_detail` | ✅ | ✅ | Same locator inputs and detail payload |
| Context | `get_media_state` | ✅ | ✅ | Same media snapshot shape |
| Context | `get_frame_tree` | ✅ | ✅ | Same frame path model |
| Navigation | `open_url` | ✅ | ✅ | Same fields; Playwright defaults to `networkidle` with alias support |
| Navigation | `go_back` | ✅ | ✅ | Same result envelope |
| Navigation | `scroll_page` | ✅ | ✅ | Same input/output contract |
| Navigation | `scroll_to_element` | ✅ | ✅ | Same locator inputs |
| Navigation | `wait_for_page_state` | ✅ | ✅ | Same mode contract |
| Actions | `click_element` | ✅ | ✅ | Same observed-change envelope |
| Actions | `click_css` | ✅ | ✅ | Same contract |
| Actions | `click_text` | ✅ | ✅ | Same contract |
| Actions | `click_xpath` | ✅ | ✅ | Same contract |
| Actions | `click_checkbox` | ✅ | ✅ | Same contract |
| Actions | `click_radio` | ✅ | ✅ | Same contract |
| Actions | `type_into` | ✅ | ✅ | Same contract |
| Actions | `select_option` | ✅ | ✅ | Same contract; Playwright uses locator/selectOption flow |
| Actions | `play_media` | ✅ | ✅ | Same contract |
| Actions | `swipe_region` | ✅ | ✅ | Same contract |
| Actions | `click_coordinates` | ✅ | ✅ | Same contract |
| Extraction | `capture_streams` | ✅ | ✅ | Same output categories |
| Legacy high-level | `navigate` | ✅ | ✅ | Same intent; Playwright wait aliases normalized |
| Legacy high-level | `inspect` | ✅ | ✅ | Same top-level payload intent |
| Legacy high-level | `inspect_landing` | ✅ | ✅ | Same profile-specific payload intent |
| Legacy high-level | `inspect_hosting` | ✅ | ✅ | Same profile-specific payload intent |
| Legacy high-level | `inspect_embedded` | ✅ | ✅ | Same profile-specific payload intent |
| Legacy high-level | `interact` | ✅ | ✅ | Same high-level interaction contract |
| Legacy high-level | `screenshot` | ✅ | ✅ | Same screenshot/result intent |
| Legacy high-level | `harvest` | ✅ | ✅ | Same stream-harvest intent |
| Memory | `memory_lookup` | ✅ | ✅ | Same store/read envelope |
| Memory | `memory_update` | ✅ | ✅ | Same store/update envelope |

Profile exposure is also parity-matched in:
- `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/puppeteer/profiles.js`
- `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/playwright/profiles.js`

---

## General Tool Contract by Capability Group

### 1) Context tools
- Must return deterministic frame-aware context.
- Must provide stable `element_ref` handles for follow-up actions.
- Must keep filter semantics (contains/regex/attrs/visibility/limit) identical across engines.

### 2) Navigation tools
- Must return a standard navigation envelope (`ok`, `error`, observed change, diagnostics fields).
- Must support backward-compatible wait semantics.
- Playwright accepts `networkidle0/networkidle2` as aliases and normalizes to `networkidle`.

### 3) Action tools
- Must resolve targets through the same locator contract (`element_ref`, `selector`, `xpath`, `text`).
- Must include observed-change metadata and post-action screenshot evidence.
- Must remain frame-safe and avoid cross-frame ambiguity.

### 4) Extraction tools
- Must emit stream candidates grouped by type and include state/diagnostic metadata.
- Must preserve deduplication and envelope consistency across engines.

### 5) Memory tools
- Must preserve read/write schemas and not depend on browser session state.

---

## Playwright-Native Reliability Upgrades

1. **Session isolation by default in MCP mode**
   - Ephemeral browser per SSE session, clean teardown on disconnect.

2. **Deterministic wait compatibility**
   - Alias normalization (`networkidle0/networkidle2` → `networkidle`) while keeping old caller compatibility.

3. **Frame-safe and locator-first action behavior**
   - Uses frame-aware targeting and Playwright locator operations for consistency.

4. **Context-level network handling**
   - Playwright context-based interception/listening improves cross-frame capture reliability.

5. **Improved diagnostics surfaces**
   - Error/status fields and observed-change metadata stay explicit for agent decisioning.

---

## Source of Truth

- Tool schemas and examples:
  - `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/puppeteer/tool-registry.js`
  - `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/playwright/tool-registry.js`
- Profile exposure:
  - `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/puppeteer/profiles.js`
  - `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/playwright/profiles.js`
- Playwright MCP runtime:
  - `/home/runner/work/Open-Web-Catcher/Open-Web-Catcher/tools/playwright/mcp-server.js`
