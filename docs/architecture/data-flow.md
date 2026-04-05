# End-to-End Data Flow

> **See also:** [Agents](agents.md) · [MCP Server](mcp-server.md) · [REST API](../api/fastapi.md) · [← Docs Home](../README.md)

---

## Pipeline Overview

```
POST /run  { "url": "https://illegal-site.com/match/123" }
│
▼
OrchestratorAgent.run(url)
│
├─ 1. classify_page(url)
│      └─ ClassificationAgent → { page_type: "landing_page", confidence: "high" }
│
├─ 2. run_landing_agent(url)
│      └─ LandingPageAgent → { hosting_pages: [{url, title, participants, ...}, ...] }
│
├─ 3. run_hosting_agent(hosting_pages[0].url)
│      └─ HostingPageAgent → { servers: [...], streaming_urls: [...] }
│
├─ 4. run_hosting_agent(hosting_pages[1].url)
│      └─ HostingPageAgent → { servers: [..., {embedded_url: "https://embed.cdn.net/..."}] }
│
├─ 5. run_embedded_agent("https://embed.cdn.net/...")
│      └─ EmbeddedPageAgent → { all_stream_urls: [...] }
│
├─ 6. analyze_providers(stream_urls=[...all collected...])
│      └─ IPInfoTool → [{ stream_url, ip, org, country, abuse_email }, ...]
│
└─ 7. generate_takedown_emails(infringing_url, provider_analysis, extraction_results)
       └─ EmailTool → [{ provider, abuse_email, subject, body, evidence }, ...]

▼
PipelineResult (returned as JSON + persisted to PostgreSQL)
```

---

## Data Models

### Input

```python
# POST /run body
class RunRequest(BaseModel):
    url: str
```

### ClassificationResult

```python
class ClassificationResult(BaseModel):
    url: str
    page_type: PageType          # LANDING | HOSTING | EMBEDDED | UNKNOWN
    confidence: Confidence       # HIGH | MEDIUM | LOW
    reasoning: str
```

### ExtractionResult

```python
class ExtractionResult(BaseModel):
    url: str
    page_type: PageType
    status: ExtractionStatus     # SUCCESS | PARTIAL | FAILED
    streams: list[StreamURL]
    screenshots: list[str]       # Cloudinary URLs
    embedded_urls: list[str]     # iframe srcs to pass to EmbeddedPageAgent
    agent_type: AgentType
    tool_calls_used: int
    metadata: dict               # Raw agent JSON output
```

### StreamURL

```python
class StreamURL(BaseModel):
    url: str                     # The actual .m3u8 / .mpd / .mp4 URL
    protocol: str                # "hls" | "dash" | "mp4" | ""
    source_layer: str            # Which harvest layer or server label found it
```

### ProviderInfo

```python
class ProviderInfo(BaseModel):
    stream_url: str
    hostname: str
    ip: str
    org: str                     # e.g. "AS12345 Cloudflare Inc"
    country: str
    city: str
    abuse_email: str             # From IPInfo abuse contact data
```

### TakedownEmail

```python
class TakedownEmail(BaseModel):
    provider: str                # CDN/hosting company name
    abuse_email: str
    subject: str
    body: str                    # Full DMCA notice text
    evidence: list[dict]         # Screenshots + stream URLs as evidence items
```

### PipelineResult

```python
class PipelineResult(BaseModel):
    run_id: str                  # UUID
    url: str                     # Original URL submitted
    classification: ClassificationResult | None
    matches: list[MatchInfo]     # Hosting pages found by landing agent
    extraction_results: list[ExtractionResult]
    final_status: ExtractionStatus
    all_streams: list[StreamURL] # Deduplicated across all extraction results
    all_screenshots: list[str]
    provider_analysis: list[ProviderInfo]
    takedown_emails: list[TakedownEmail]
```

---

## Message Flow Inside the Orchestrator

The orchestrator runs `run_agent_loop()` with 6 tools. Each tool call produces a
`ToolMessage` appended to the message history. After the loop, `_build_pipeline_result()`
reconstructs structured data by replaying the message history:

```
messages = [
    SystemMessage(orchestrator_prompt),
    HumanMessage("Process: https://..."),
    AIMessage(tool_calls=[{name: "classify_page", args: {url: "..."}}]),
    ToolMessage(content='{"url":"...","page_type":"landing_page","confidence":"high",...}'),
    AIMessage(tool_calls=[{name: "run_landing_agent", args: {url: "..."}}]),
    ToolMessage(content='{"url":"...","metadata":{"hosting_pages":[...]}}'),
    AIMessage(tool_calls=[{name: "run_hosting_agent", args: {url: "..."}}]),
    ToolMessage(content='{"url":"...","metadata":{"servers":[...]}}'),
    ...
    AIMessage(tool_calls=[{name: "analyze_providers", args: {...}}]),
    ToolMessage(content='[{"stream_url":"...","ip":"...","org":"..."}]'),
    AIMessage(tool_calls=[{name: "generate_takedown_emails", args: {...}}]),
    ToolMessage(content='[{"provider":"...","subject":"...","body":"..."}]'),
    AIMessage(content="Pipeline complete.")   ← no more tool_calls → loop ends
]
```

---

## MCP Tool Call Flow

For each agent tool call, `langchain-mcp-adapters` handles the HTTP round-trip:

```
Python Agent
    │
    │  tool.arun({"url": "https://..."})
    ▼
MCP Client (langchain-mcp-adapters)
    │
    │  POST http://localhost:3000/mcp/message?sessionId=abc123
    │  Body: { jsonrpc: "2.0", method: "tools/call", params: {name: "harvest", arguments: {...}} }
    ▼
MCP Server (Node.js Express)
    │
    │  routes to harvest.js handler
    ▼
harvest.js
    │
    │  puppeteer.connect("ws://localhost:9222")
    │  Setup CDP Network intercept
    │  Wait 3s for stream requests
    ▼
Cloudinary
    │  upload screenshot
    ▼
harvest.js returns JSON
    │
    ▼
MCP Server sends SSE event back to Python client
    │
    ▼
tool.arun() returns result string
    │
    ▼
run_agent_loop() appends ToolMessage, continues
```

---

## Database Storage

Every completed pipeline run is persisted to PostgreSQL:

```sql
-- runs table (RunRecord model in src/storage/database.py)
CREATE TABLE runs (
    id              SERIAL PRIMARY KEY,
    run_id          VARCHAR(64) UNIQUE,
    url             TEXT,
    page_type       VARCHAR(32),
    status          VARCHAR(32),
    streams_found   INTEGER,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    tool_calls      INTEGER,
    duration_seconds FLOAT,
    success         BOOLEAN,
    failure_mode    VARCHAR(64),
    result_json     JSONB,        -- full PipelineResult serialized
    created_at      TIMESTAMP
);
```

The `result_json` column stores the entire `PipelineResult` as JSONB, enabling
arbitrary queries on nested fields (streams, emails, screenshots) via PostgreSQL's JSON operators.

---

## LangSmith Tracing

When `LANGCHAIN_TRACING_V2=true` and `LANGCHAIN_API_KEY` is set, every LLM invocation
and tool call is automatically traced to LangSmith. Each `run_agent_loop()` invocation
produces a trace showing:

- System prompt used
- Every LLM invocation with token counts
- Every tool call with input/output
- Total cost estimate
- Duration per step

Traces are grouped by `LANGCHAIN_PROJECT` (default: `open-web-catcher`).

---

*Next: [Agents](agents.md) | [REST API](../api/fastapi.md) | [Configuration](../setup/configuration.md)*
