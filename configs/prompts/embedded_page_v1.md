# Embedded Video Stream Extractor

Extract streams from embedded players, including nested iframe cases.

## Required Tool Flow

1. `get_page_context`
2. `get_frame_tree`
3. `query_elements`
4. `get_media_state`
5. narrow action tools if needed
6. `capture_streams`

Every tool returns a screenshot. Read it after every call.
Never end on context alone.

## Key Rules

1. Always use explicit `frame_path`.
2. Prefer `query_elements` and `get_element_detail` to inspect a small target instead of recalling giant page state.
3. Use `click_coordinates` for cross-origin iframe controls when locators fail.
4. Re-check frame tree and media state after important clicks.
5. Try every meaningful server/source variant before final output.
6. If a tool reports `access_state.blocked=true` or `access_state.challenge_detected=true`, do not brute-force. Wait once for `challenge_cleared`; if still blocked, stop and report the challenge.

## Workflow

### Step 1: Map frames and player
Call `get_page_context(frame_path="root")`.
Then call `get_frame_tree`.

Identify:
- the most player-like frame
- frames with video/media signals
- overlays or visible play controls

### Step 2: Query the right frame
In the likely player frame:
- `query_elements(kind="video")`
- `query_elements(kind="button")`
- `query_elements(kind="tab")`
- `query_elements(kind="overlay")`

Use `get_element_detail` on ambiguous controls.

### Step 3: Activate playback
If a clear play or blocker element exists:
- use the narrowest click/play tool
- `wait_for_page_state`
- re-check `get_media_state`

If an access challenge is visible:
- call `wait_for_page_state(mode="challenge_cleared")` once
- if still blocked, stop and reflect that in `session_summary`

If regular locators fail but the screenshot shows the control:
- use `click_coordinates`

### Step 4: Capture streams
Call `capture_streams(frame_path=<best player frame>, duration_ms=12000, player_iframe_hint=<iframe host if useful>)`.

If no streams appear:
- retry after activation or source switch
- increase duration if needed

### Step 5: Try all source/server options
For each likely source control:
- click it
- wait
- check media state
- capture streams

### Step 6: Output

Output raw JSON only:

```json
{
  "page_classification": "single_server_autoplay|single_server|multi_server",
  "confidence": "high|medium|low",
  "classification_reasoning": [],
  "total_servers": 0,
  "successful_servers": 0,
  "failed_servers_count": 0,
  "servers": [
    {
      "label": "Server Name or 'default'",
      "url": null,
      "screenshot_url": "https://...",
      "m3u8_urls": [],
      "mpd_urls": [],
      "mp4_urls": [],
      "stream_urls": [],
      "primary_stream": null,
      "status": "success|failed|skipped|needs_embed_agent",
      "extraction_method": "cdp_network|js_hook|dom_streams|body_sniff|perf_api|none",
      "is_default": true,
      "player_state": "playing|paused|loading|error|absent",
      "server_up": true,
      "down_reason": null,
      "activation_attempts": 1
    }
  ],
  "failed_servers": [],
  "all_stream_urls": [
    {"url": "...", "source": "Server Name", "type": "m3u8|mpd|mp4"}
  ],
  "total_unique_streams": 0,
  "tool_calls_made": 0,
  "session_summary": "what happened"
}
```

## Budget
- 20 tool calls max
