# Agents

> **See also:** [Overview](overview.md) · [MCP Server](mcp-server.md) · [Data Flow](data-flow.md) · [← Docs Home](../README.md)

---

## Agent Inventory

| Agent | Model | MCP Profile | Max Tool Calls | Output |
|-------|-------|------------|----------------|--------|
| [ClassificationAgent](#classificationagent) | flash | `classification` | 5 | `ClassificationResult` |
| [LandingPageAgent](#landingpageagent) | flash | `landing` | 50 | `ExtractionResult` + `hosting_pages[]` |
| [HostingPageAgent](#hostingpageagent) | flash | `hosting` | 20 | `ExtractionResult` + streams |
| [EmbeddedPageAgent](#embeddedpageagent) | flash | `embedded` | 20 | `ExtractionResult` + streams |
| [OrchestratorAgent](#orchestratoragent) | flash-lite | none (sub-agents as tools) | 60 | `PipelineResult` |

Models:
- `flash` = `gemini-2.5-flash-preview-05-20`
- `flash-lite` = `gemini-2.5-flash-lite-preview-05-20`

---

## Shared Infrastructure: `run_agent_loop()`

All sub-agents (Classification, Landing, Hosting, Embedded) use the same async loop
defined in [`src/agents/base.py`](../../src/agents/base.py):

```
messages = [SystemMessage(prompt), HumanMessage(task)]

while tool_calls_made < max_tool_calls:
    response = await llm_with_tools.ainvoke(messages)
    if no tool_calls in response:
        return  ← model is done
    for each tool_call:
        result = await tool.arun(args)
        messages.append(ToolMessage(result))
        tool_calls_made++

# Budget exhausted → force final answer without tools
final = await llm.ainvoke(messages + [HumanMessage("Output now.")])
return final
```

Key properties:
- **Async throughout** — MCP connections are async-native; `ainvoke` is non-blocking
- **Hard budget** — never exceeds `max_tool_calls`; budget exhaustion triggers a forced final answer
- **Full history** — entire message chain is preserved and passed to the LLM each turn (Gemini handles this efficiently with long context)
- **No text format** — Gemini returns structured `tool_calls`, not `Thought/Action/Observation` text

---

## ClassificationAgent

**File:** [`src/agents/classification.py`](../../src/agents/classification.py)  
**Prompt:** [`configs/prompts/classification_v1.md`](../../configs/prompts/classification_v1.md)

### Purpose

Determine which type of page a URL is:
- `landing_page` — catalog/schedule page with links to hosting pages
- `host_page` — a page with an embedded video player (main focus)
- `embed_video_page` — a third-party iframe player URL
- `other` / `unknown` — irrelevant or unclassifiable

### Flow

```
URL → inspect (always) → [navigate once if ambiguous] → CLASSIFICATION output
```

The agent calls `inspect` first to get DOM signals (iframes, video elements, nav links,
hosting signals). If the result is ambiguous, it may navigate once. It then outputs:

```
CLASSIFICATION: host_page
CONFIDENCE: high
EVIDENCE:
- Found <video> element with HLS source
- iframe pointing to streamcdn.net
REASONING:
The page has a direct video player with no catalog structure.
METADATA:
page_type: host_page
confidence: high
tools_used: [inspect]
```

### Output Parsing

The agent's text output is parsed by `_parse_output()` which looks for the `METADATA:` block
first (structured), then falls back to loose `CLASSIFICATION:` / `CONFIDENCE:` regex patterns.
Returns a `ClassificationResult` Pydantic model.

### Why 5 tool calls max?

Classification is a signal-gathering exercise, not an extraction. One `inspect` call gives
enough DOM structure for a confident classification in 95%+ of cases. The 5-call budget
allows one navigation + one re-inspect for edge cases.

---

## LandingPageAgent

**File:** [`src/agents/landing_page.py`](../../src/agents/landing_page.py)  
**Prompt:** [`configs/prompts/landing_page_v1.md`](../../configs/prompts/landing_page_v1.md)

### Purpose

Explore catalog/schedule pages and discover all hosting page URLs. A landing page is
typically a sports streaming site homepage, schedule page, or category listing with
links to individual match/event pages.

### Tools Available

| Tool | Use |
|------|-----|
| `inspect` | Scan DOM for links, navigation, content structure |
| `navigate` | Follow pagination or category links |
| `interact` | Click buttons, open dropdowns, load more content |
| `screenshot` | Visual confirmation of page state |

> No `harvest` — the landing agent does not extract streams. That's HostingPageAgent's job.

### Typical Flow

```
1. inspect(mainUrl)          ← get all links, nav structure
2. identify "hosting pages"  ← links that look like match/event pages
3. interact(click=loadMore)  ← if paginated
4. inspect(newContent)       ← check newly loaded links
5. Output JSON
```

### Output JSON Schema

```json
{
  "hosting_pages": [
    {
      "url": "https://site.com/match/123",
      "title": "Team A vs Team B",
      "participants": ["Team A", "Team B"],
      "channel": "Sports HD",
      "start_time": "2024-01-15 20:00",
      "route": "homepage → schedule → match"
    }
  ],
  "pagination_found": true,
  "total_pages_explored": 3
}
```

### Why 50 tool calls?

Landing pages can be complex — multiple pagination layers, JS-loaded content, lazy tabs.
50 calls allows thorough exploration while preventing runaway cost.

---

## HostingPageAgent

**File:** [`src/agents/hosting_page.py`](../../src/agents/hosting_page.py)  
**Prompt:** [`configs/prompts/hosting_page_v1.md`](../../configs/prompts/hosting_page_v1.md)

### Purpose

Extract every m3u8/mpd/mp4 stream URL from a hosting page, cycling through all available
servers/tabs. A hosting page is a page with an embedded video player — typically a match
page on an illegal streaming site.

### Tools Available (all 5)

| Tool | Use |
|------|-----|
| `inspect` | Scan DOM for player elements, server list, iframe sources |
| `interact` | Click server buttons, play button, server tabs |
| `harvest` | 6-layer CDP stream capture |
| `navigate` | Follow server links if they navigate |
| `screenshot` | Visual evidence per server |

### Typical Flow

```
1. inspect(url)              ← find player, server list, iframe sources
2. interact(play button)     ← trigger stream loading
3. harvest()                 ← capture m3u8/mpd/mp4 from network
4. screenshot()              ← visual evidence
5. For each additional server:
   5a. interact(server tab)  ← switch server
   5b. harvest()             ← capture new stream
   5c. screenshot()
6. Output JSON
```

### Server Cycling Strategy

The prompt instructs the agent to:
1. After inspect, make a list of all servers
2. Process them one by one: interact → harvest → screenshot
3. If a server has an `embedded_url` (cross-origin iframe), record it for the orchestrator
4. Never navigate away from the page unless explicitly following a server link

### Output JSON Schema

```json
{
  "decision": "success",
  "servers": [
    {
      "label": "Server 1",
      "m3u8_urls": ["https://cdn.example.com/hls/stream.m3u8"],
      "mpd_urls": [],
      "mp4_urls": [],
      "screenshot_url": "https://res.cloudinary.com/...",
      "embedded_url": null
    },
    {
      "label": "Server 2",
      "m3u8_urls": [],
      "embedded_url": "https://embed.streamcdn.net/v/abc123"
    }
  ],
  "streaming_urls": [
    {"url": "https://cdn.example.com/hls/stream.m3u8", "type": "hls", "source": "harvest_cdp"}
  ]
}
```

`decision` values:
- `success` — at least one stream found
- `needs_embed_agent` — all servers are cross-origin iframes, EmbeddedPageAgent needed
- `partial_success_needs_embed` — some streams found, but some servers need EmbeddedPageAgent
- `failed` — no streams found

---

## EmbeddedPageAgent

**File:** [`src/agents/embedded_page.py`](../../src/agents/embedded_page.py)  
**Prompt:** [`configs/prompts/embedded_page_v1.md`](../../configs/prompts/embedded_page_v1.md)

### Purpose

Extract streams from a **third-party embedded video player** — typically an iframe src URL
from a CDN like `streamcdn.net`, `embedcdn.co`, etc. These are usually cross-origin and
can't be fully inspected from the parent page.

### Specialisations

1. **Iframe traversal** — `inspect` scans all frames automatically, including nested iframes
2. **Coordinate-mode clicking** — when the player can't be found by CSS selector (cross-origin iframe), `interact(mode=coordinates)` uses a bezier mouse path to click at specific viewport coordinates
3. **Multi-server cycling** — same server cycling logic as HostingPageAgent

### Coordinate Mode

When a cross-origin iframe blocks standard DOM interaction:
```json
{
  "mode": "coordinates",
  "x": 640,
  "y": 360,
  "description": "center of player area"
}
```
The tool uses CDP input events with a natural bezier mouse path to simulate a real click,
which triggers the player without JavaScript access to the iframe DOM.

### Output JSON Schema

Same structure as HostingPageAgent but using `all_stream_urls[]` for flat results:

```json
{
  "all_stream_urls": [
    {"url": "https://...", "type": "hls", "source": "harvest_layer1"}
  ],
  "servers": [...],
  "successful_servers": 2
}
```

---

## OrchestratorAgent

**File:** [`src/agents/orchestrator.py`](../../src/agents/orchestrator.py)  
**Prompt:** [`configs/prompts/orchestrator_v1.md`](../../configs/prompts/orchestrator_v1.md)

### Purpose

Coordinate the full extraction pipeline. The orchestrator is an LLM agent that calls
sub-agents and analysis tools in the correct order based on the classification result.

### Model Choice: `gemini-2.5-flash-lite`

The orchestrator only makes routing decisions — it never touches the browser.
Flash-Lite is significantly cheaper and fast enough for coordination.
Sub-agents (which do the actual work) use the full `flash` model.

### Tool Set

| Tool | Wraps | When to call |
|------|-------|-------------|
| `classify_page` | `ClassificationAgent` | Always first |
| `run_landing_agent` | `LandingPageAgent` | When classification = `landing_page` |
| `run_hosting_agent` | `HostingPageAgent` | For each hosting URL (called N times) |
| `run_embedded_agent` | `EmbeddedPageAgent` | When hosting fails or classification = `embed_video_page` |
| `analyze_providers` | `IPInfoTool` | After all extractions, pass all stream URLs |
| `generate_takedown_emails` | `EmailTool` | After `analyze_providers` |

### Routing Paths

**Path A — Landing page:**
```
classify → landing → hosting(×N) → [embedded(×M)] → ipinfo → email
```

**Path B — Direct hosting page:**
```
classify → hosting → [embedded] → ipinfo → email
```

**Path C — Direct embed page:**
```
classify → embedded → ipinfo → email
```

### Agent-as-Tool Pattern

Each sub-agent is wrapped as a `BaseTool` subclass with an async `_arun()` method:

```python
class _HostingTool(BaseTool):
    async def _arun(self, url: str) -> str:
        result = await HostingPageAgent(self.settings).run(url=url)
        return result.model_dump_json()
```

This means:
- The orchestrator sees a tool call result (JSON string) just like any other tool
- The full pipeline is one agent loop — no nested event loops
- Results are preserved in the orchestrator's message history and replayed by `_build_pipeline_result()` to construct the final `PipelineResult`

### Result Reconstruction

After the loop completes, `_build_pipeline_result()` iterates all `ToolMessage` objects
in the message history and identifies each by its JSON keys:

| JSON keys present | Identified as |
|-------------------|--------------|
| `page_type` + `confidence` + `reasoning` | `ClassificationResult` |
| `metadata.hosting_pages` | Landing agent output |
| `metadata.servers` | Hosting or Embedded agent output |
| List with `stream_url` key | `analyze_providers` output |
| List with `subject` key | `generate_takedown_emails` output |

---

*Next: [MCP Server & Tools](mcp-server.md) | [Data Flow](data-flow.md)*
