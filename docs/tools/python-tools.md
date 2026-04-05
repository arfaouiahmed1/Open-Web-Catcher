# Python Tools Reference

> **See also:** [Browser Tools](browser-tools.md) · [Data Flow](../architecture/data-flow.md) · [← Docs Home](../README.md)

Python-side tools used directly by the orchestrator or as infrastructure.

---

## `mcp_client` — MCP Connection Manager

**File:** [`src/tools/mcp_client.py`](../../src/tools/mcp_client.py)

Async context manager that connects to the MCP server for a specific agent profile
and returns LangChain `BaseTool` objects.

### Usage

```python
from src.tools.mcp_client import agent_tools

async with agent_tools("hosting", settings) as tools:
    # tools: list[BaseTool] — only inspect/interact/harvest/screenshot/navigate
    result = await run_agent_loop(llm=llm, tools=tools, ...)
```

### How It Works

```python
@asynccontextmanager
async def agent_tools(profile: str, settings: Settings):
    url = f"{settings.mcp_server_url}/mcp/{profile}/sse"
    async with MultiServerMCPClient({
        profile: {"url": url, "transport": "sse"}
    }) as client:
        yield client.get_tools()
```

`MultiServerMCPClient` (from `langchain-mcp-adapters`) handles:
1. SSE handshake with the MCP server
2. Tool schema discovery (gets JSON schemas for all tools in the profile)
3. Converting MCP tool schemas → LangChain `BaseTool` objects
4. Routing `tool.arun(args)` calls back to the MCP server via HTTP POST

The context manager ensures the SSE connection is properly closed after the agent loop.

### Profile → Available Tools

| Profile | Tools |
|---------|-------|
| `classification` | `inspect`, `navigate` |
| `landing` | `inspect`, `navigate`, `interact`, `screenshot` |
| `hosting` | `inspect`, `interact`, `harvest`, `screenshot`, `navigate` |
| `embedded` | `inspect`, `interact`, `harvest`, `screenshot`, `navigate` |

---

## `IPInfoTool` — Provider Analysis

**File:** [`src/tools/ipinfo_tool.py`](../../src/tools/ipinfo_tool.py)  
**Utility:** [`src/utils/ipinfo.py`](../../src/utils/ipinfo.py)

LangChain `BaseTool` that resolves stream URLs to CDN provider info.
Called by the orchestrator after all stream extraction is complete.

### Input

```python
{
  "stream_urls": [
    "https://cdn1.example.com/hls/stream.m3u8",
    "https://cdn2.otherprovider.net/stream.mpd"
  ]
}
```

### Output (JSON string)

```json
[
  {
    "stream_url": "https://cdn1.example.com/hls/stream.m3u8",
    "hostname": "cdn1.example.com",
    "ip": "104.21.48.1",
    "org": "AS13335 Cloudflare Inc",
    "country": "US",
    "city": "San Francisco",
    "abuse_email": "abuse@cloudflare.com"
  }
]
```

### How It Works

For each unique URL:
1. Extract hostname from URL
2. Resolve hostname → IP via `socket.gethostbyname()`
3. Query `https://ipinfo.io/{ip}/json` with optional `IPINFO_TOKEN`
4. Parse `org` field (format: `AS12345 Company Name`)
5. Extract `abuse_email` from IPInfo's abuse contact data

Duplicate hostnames are deduplicated — if 3 stream URLs all resolve to the same IP,
only 1 IPInfo query is made.

### Rate Limits

- Free tier (no token): 50,000 requests/month
- Set `IPINFO_TOKEN` in `.env` for higher limits

---

## `EmailTool` — DMCA Notice Generator

**File:** [`src/tools/email_tool.py`](../../src/tools/email_tool.py)  
**Generator:** [`src/agents/email_generator.py`](../../src/agents/email_generator.py)

LangChain `BaseTool` that generates DMCA takedown emails, grouped by CDN provider.
**Deterministic — no LLM involved.** Takes the analysis results and fills a template.

### Input

```python
{
  "infringing_url": "https://illegal-site.com/match/123",
  "provider_analysis": [...],   # list of ProviderInfo dicts from IPInfoTool
  "extraction_results": [...]   # list of ExtractionResult dicts
}
```

### Output (JSON string)

```json
[
  {
    "provider": "Cloudflare Inc",
    "abuse_email": "abuse@cloudflare.com",
    "subject": "DMCA Takedown Notice — Unauthorized Streaming via Cloudflare CDN",
    "body": "Dear Cloudflare Inc Abuse Team,\n\nWe are writing to report...",
    "evidence": [
      {
        "type": "screenshot",
        "url": "https://res.cloudinary.com/...",
        "label": "Server 1 — illegal-site.com/match/123"
      },
      {
        "type": "stream_url",
        "url": "https://cdn1.cloudflare-stream.com/hls/stream.m3u8",
        "protocol": "hls"
      }
    ]
  }
]
```

### Grouping Logic

Streams are grouped by `org` (the CDN company name from IPInfo):
- All Cloudflare-served streams → one email to `abuse@cloudflare.com`
- All Akamai-served streams → one email to Akamai's abuse contact
- Unresolved streams → one "unknown provider" email with raw IPs

### Email Template Structure

```
Subject: DMCA Takedown Notice — Unauthorized Streaming via {Provider} CDN

Dear {Provider} Abuse Team,

We are writing to report unauthorized distribution of copyrighted content
being served through your infrastructure.

INFRINGING URL: {url}
DATE OBSERVED: {date}

STREAM URLS FOUND:
- {stream_url_1} (HLS, Server 1)
- {stream_url_2} (DASH, Server 2)

VISUAL EVIDENCE:
[screenshots with Cloudinary URLs]

This content is being streamed without authorization...

[standard DMCA boilerplate]

Regards,
[Right holder contact]
```

---

## Agent-as-Tool Wrappers (Orchestrator)

**File:** [`src/agents/orchestrator.py`](../../src/agents/orchestrator.py)

The orchestrator wraps each sub-agent as a `BaseTool` so the LLM can call them
as regular tool calls. Each wrapper implements `async _arun()`:

```python
class _HostingTool(BaseTool):
    name = "run_hosting_agent"
    description = "Run the Hosting Page Agent on a single hosting page URL..."
    settings: Settings

    async def _arun(self, url: str) -> str:
        from src.agents.hosting_page import HostingPageAgent
        result = await HostingPageAgent(self.settings).run(url=url)
        return result.model_dump_json()
```

Key design:
- `_run()` raises `NotImplementedError` — only async path is supported
- Each wrapper is instantiated with `settings` so it can construct the agent
- The result is serialized to JSON string (LangChain tool results are always strings)
- Lazy import (`from src.agents.xxx import ...`) avoids circular imports

---

*Next: [Browser Tools](browser-tools.md) | [MCP Server Architecture](../architecture/mcp-server.md)*
