# Hosting Page Agent

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Landing](./landing.md) | Next: [Embedded](./embedded.md)

Source: `src/agents/hosting_page.py`

The hosting agent works on watch/host pages. It activates players, handles blockers and server/source switching, harvests streams, records screenshots, and returns explicit embedded/player handoffs only when required.

## Hosting Activity

```mermaid
flowchart TD
  Handoff["Orchestrator hosting handoff<br/>target URL, route source, required evidence"]
  Open["open/navigate assigned target"]
  Inspect["inspect_hosting<br/>players, controls, iframes, overlays"]
  Activate["interact/play_media/click server controls"]
  Harvest["harvest / capture_streams"]
  Evidence["screenshot + network/iframe diagnostics"]
  Streams{"streams found?"}
  Embedded{"explicit embedded URL?"}
  Result["ExtractionResult<br/>servers, streams, embedded_urls, screenshots"]

  Handoff --> Open --> Inspect --> Activate --> Harvest --> Evidence --> Streams
  Streams -->|"yes"| Result
  Streams -->|"no"| Embedded
  Embedded -->|"yes"| Result
  Embedded -->|"no"| Result
```

## Server Result Class Focus

```mermaid
classDiagram
  class ServerResult {
    +label
    +server_up
    +m3u8_urls
    +mpd_urls
    +mp4_urls
    +stream_urls
    +primary_stream
    +screenshot_url
    +embedded_url
    +embedded_url_source
    +player_iframe_url
    +status
    +activation_attempts
    +player_state
    +visual_confirmation
    +detected_channel
    +playback_confirmed
    +server_change_observed
    +network_diagnostics
    +iframe_diagnostics
  }

  class ExtractionResult {
    +servers
    +streams
    +screenshots
    +embedded_urls
    +primary_channel
    +metadata
  }

  ExtractionResult --> ServerResult
```

## Parallel Hosting Targets

```mermaid
sequenceDiagram
  participant Orchestrator
  participant Semaphore as asyncio.Semaphore
  participant HostingA as HostingPageAgent target A
  participant HostingB as HostingPageAgent target B
  participant Results as extraction_results

  Orchestrator->>Semaphore: max_parallel_hosting_pages
  par target A
    Semaphore->>HostingA: run with handoff
    HostingA-->>Results: ExtractionResult
  and target B
    Semaphore->>HostingB: run with handoff
    HostingB-->>Results: ExtractionResult
  end
  Results-->>Orchestrator: streams + embedded handoffs + diagnostics
```

