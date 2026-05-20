# MCP Browser Tools

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Tools Index](./README.md) | Next: [Operations Index](../operations/README.md)

Browser tools are exposed through profile-scoped MCP servers. The backend loads profile tools with `src/tools/mcp_client.py`, which converts MCP tool schemas into LangChain `BaseTool` objects and pins one SSE session for the agent loop.

## Profile Tool Exposure

```mermaid
flowchart TB
  Backend["src/tools/mcp_client.py"]
  Classification["classification profile"]
  Landing["landing profile"]
  Hosting["hosting profile"]
  Embedded["embedded profile"]
  Shared["shared actions<br/>open_url, navigate, context, query/detail, memory"]
  Media["media tools<br/>harvest, capture_streams, get_media_state"]

  Backend --> Classification
  Backend --> Landing
  Backend --> Hosting
  Backend --> Embedded
  Classification --> Shared
  Landing --> Shared
  Hosting --> Shared
  Embedded --> Shared
  Hosting --> Media
  Embedded --> Media
```

## Tool Profile Matrix

| Tool group | Classification | Landing | Hosting | Embedded |
| --- | --- | --- | --- | --- |
| Memory | `memory_lookup`, `memory_update` | same | same | same |
| Navigation | `navigate`, `open_url`, `go_back`, waits | same | same | same |
| Broad inspect | `inspect` | `inspect_landing` | `inspect_hosting` | `inspect_embedded` |
| Context/detail | `get_page_context`, `get_frame_tree`, `query_elements`, `get_element_detail` | same | same | same |
| Actions | selected interaction/screenshot/scroll tools | full click/type/select/play/scroll tools | full action tools | full action tools |
| Media extraction | no | no | `harvest`, `capture_streams`, `get_media_state` | `harvest`, `capture_streams`, `get_media_state` |

## MCP Session Sequence

```mermaid
sequenceDiagram
  participant Agent
  participant Client as MultiServerMCPClient
  participant MCP as /mcp/{profile}/sse
  participant Browser as isolated browser session
  participant Tool as browser tool

  Agent->>Client: agent_tools(profile, settings, observer)
  Client->>MCP: open SSE session
  MCP->>Browser: create/reuse isolated browser
  MCP-->>Client: tool schemas for profile
  Client-->>Agent: LangChain BaseTool list
  Agent->>Tool: invoke tool
  Tool->>Browser: DOM/network/media/screenshot work
  Browser-->>Tool: result
  Tool-->>Agent: JSON/tool message
  Agent->>MCP: close session at loop end
```

## Browser Engine Split

```mermaid
flowchart LR
  SharedPolicy["tools/shared/browser-policy.js<br/>streaming safe policy, proxy decisions"]
  Proxy["tools/shared/proxy-pool.js<br/>sticky-success ordered candidates"]
  Errors["tools/shared/error-codes.js<br/>Chrome error classification"]
  Puppeteer["tools/puppeteer<br/>Chrome extension/runtime path"]
  Playwright["tools/playwright<br/>persistent-context behavior"]
  Runtime["shared runtime diagnostics<br/>effectivePolicy + effectiveRuntime"]

  SharedPolicy --> Puppeteer
  SharedPolicy --> Playwright
  Proxy --> Puppeteer
  Proxy --> Playwright
  Errors --> Puppeteer
  Errors --> Playwright
  Puppeteer --> Runtime
  Playwright --> Runtime
```

## Broad Context First, Detail Second

```mermaid
flowchart TD
  Inspect["inspect / inspect_landing / inspect_hosting / inspect_embedded"]
  Summary["tree/grouped/sampled page context"]
  NeedMore{"need exact element details?"}
  Query["query_elements"]
  Detail["get_element_detail"]
  Action["click/type/play/select via exact selector/xpath/ref"]

  Inspect --> Summary --> NeedMore
  NeedMore -->|"no"| Reason["LLM reasons from compact context"]
  NeedMore -->|"yes"| Query --> Detail --> Action
```

## Tool Categories

| Category | Examples | Purpose |
| --- | --- | --- |
| Memory | `memory_lookup`, `memory_update` | reuse domain/page patterns as soft hints |
| Navigation | `open_url`, `navigate`, `go_back`, `wait_for_page_state` | load and recover pages |
| Context | `inspect_*`, `get_page_context`, `get_frame_tree` | broad structural page understanding |
| Detail | `query_elements`, `get_element_detail` | exact selectors, XPath, text, attributes |
| Actions | `click_*`, `type_into`, `select_option`, `play_media`, `scroll_*` | player and page interaction |
| Media | `harvest`, `capture_streams`, `get_media_state` | stream capture and playback evidence |
| Evidence | `screenshot` | screenshot checkpoints |

