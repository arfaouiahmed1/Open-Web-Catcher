# Landing Page Agent

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Classification](./classification.md) | Next: [Hosting](./hosting.md)

Source: `src/agents/landing_page.py`

The landing agent explores listing/home/schedule surfaces and returns hosting candidates. It must preserve iframe, video, player, redirect, route-source, channel, and pattern evidence so hosting and embedded agents receive useful context.

## Landing Output Flow

```mermaid
flowchart TD
  Handoff["ORCHESTRATOR HANDOFF<br/>root URL, classification, memory hints"]
  Inspect["inspect_landing<br/>grouped sections, candidates, pagination"]
  Interact["navigate/interact/scroll/query detail"]
  Normalize["_augment_landing_output<br/>normalize hosting_pages"]
  Match["MatchInfo[]<br/>url, title, channel, route, iframes, player_urls"]
  Streams["direct_stream_urls<br/>if landing reveals provider stream URLs"]
  Extraction["ExtractionResult<br/>metadata.hosting_pages"]

  Handoff --> Inspect --> Interact --> Normalize
  Normalize --> Match
  Normalize --> Streams
  Match --> Extraction
  Streams --> Extraction
```

## Candidate Routing

```mermaid
flowchart LR
  Candidate["Landing candidate"]
  ProviderStream{"looks like provider stream URL?"}
  EmbeddedRoute{"route == embed_agent<br/>direct embedded/player?"}
  HostingQueue["pending_hosting_urls"]
  EmbeddedQueue["pending_embedded_urls"]
  DirectStreams["landing_direct_streams"]

  Candidate --> ProviderStream
  ProviderStream -->|"yes"| DirectStreams
  ProviderStream -->|"no"| EmbeddedRoute
  EmbeddedRoute -->|"yes"| EmbeddedQueue
  EmbeddedRoute -->|"no"| HostingQueue
```

## Memory Use

```mermaid
sequenceDiagram
  participant Orchestrator
  participant Memory as LongTermMemory
  participant Landing as LandingPageAgent
  participant MCP as landing MCP profile

  Orchestrator->>Memory: build_prompt_context(root_url, landing_page)
  Memory-->>Orchestrator: soft hints
  Orchestrator->>Landing: run(url, handoff with memory_hints)
  Landing->>MCP: memory_lookup and inspect_landing
  Landing->>MCP: memory_update after useful pattern discovery
```

