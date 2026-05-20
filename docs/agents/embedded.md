# Embedded Page Agent

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Hosting](./hosting.md) | Next: [Provider Analysis](./provider-analysis.md)

Source: `src/agents/embedded_page.py`

The embedded agent works only on direct embedded/player URLs. It should not drift back into general host-page exploration. Its job is to activate iframe-local players, switch embedded sources when available, harvest streams, and return evidence.

## Embedded Route Discipline

```mermaid
flowchart TD
  Target["assigned embedded/player URL"]
  Policy["same-content navigation policy<br/>recover on unrelated drift"]
  Inspect["inspect_embedded"]
  Activate["frame-aware interact/play_media"]
  Harvest["harvest/capture_streams"]
  Drift{"navigated away?"}
  Recover["recover to assigned target"]
  Result["ExtractionResult"]

  Target --> Policy --> Inspect --> Activate --> Harvest --> Drift
  Drift -->|"yes"| Recover --> Inspect
  Drift -->|"no"| Result
```

## Embedded Evidence Contract

```mermaid
flowchart LR
  Required["Required evidence"]
  Screenshot["screenshot_url"]
  Streams["m3u8/mpd/mp4 URLs"]
  Iframe["iframe_diagnostics"]
  Network["network_diagnostics"]
  Playback["confirmed player_state"]
  Channel["detected channel / OCR"]
  Result["ExtractionResult"]

  Required --> Screenshot --> Result
  Required --> Streams --> Result
  Required --> Iframe --> Result
  Required --> Network --> Result
  Required --> Playback --> Result
  Required --> Channel --> Result
```

