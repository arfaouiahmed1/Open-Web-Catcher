# Classification Agent

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Orchestrator](./orchestrator.md) | Next: [Landing](./landing.md)

Source: `src/agents/classification.py`

The classification agent determines whether a URL is a landing page, hosting page, embedded player page, or unknown/other. Its answer drives the first orchestrator route.

## Input And Output

```mermaid
flowchart LR
  URL["url"]
  Memory["memory_lookup<br/>domain/page hints"]
  Browser["classification MCP profile<br/>navigate, inspect, open_url, context/detail tools"]
  Gemini["Gemini model"]
  Result["ClassificationResult<br/>url, page_type, confidence, reasoning"]

  URL --> Memory --> Browser --> Gemini --> Result
```

## Classification State Flow

```mermaid
stateDiagram-v2
  [*] --> Start
  Start --> MemoryLookup
  MemoryLookup --> Navigate
  Navigate --> Inspect
  Inspect --> ModelReasoning
  ModelReasoning --> Landing: page_type landing
  ModelReasoning --> Hosting: page_type hosting
  ModelReasoning --> Embedded: page_type embedded
  ModelReasoning --> Unknown: inaccessible/other
  Landing --> [*]
  Hosting --> [*]
  Embedded --> [*]
  Unknown --> [*]
```

## Tool Profile

The `classification` MCP profile exposes broad navigation/context tools but not stream harvesting:

- `memory_lookup`, `memory_update`
- `navigate`, `open_url`, `inspect`
- `get_page_context`, `get_frame_tree`, `query_elements`, `get_element_detail`
- `interact`, `screenshot`, scrolling and wait helpers

## Route Contract

```mermaid
flowchart TD
  Result["ClassificationResult.page_type"]
  Landing["landing_page"]
  Hosting["queue_root_hosting"]
  EmbeddedCheck{"embedded shell fallback?"}
  Embedded["queue_root_embedded"]
  Analyze["analyze_providers"]

  Result -->|"landing"| Landing
  Result -->|"hosting"| Hosting
  Result -->|"embedded"| EmbeddedCheck
  EmbeddedCheck -->|"decorative/site shell"| Hosting
  EmbeddedCheck -->|"direct player"| Embedded
  Result -->|"unknown/other"| Analyze
```

