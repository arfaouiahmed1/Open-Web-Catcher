# Agents

> **See also:** [Overview](overview.md) · [MCP Server](mcp-server.md) · [Data Flow](data-flow.md) · [Browser Tools](../tools/browser-tools.md) · [Docs Home](../README.md)

## Agent Inventory

| Agent | Model | MCP Profile | Max Tool Calls | Output |
|-------|-------|------------|----------------|--------|
| ClassificationAgent | flash | `classification` | 5 | `ClassificationResult` |
| LandingPageAgent | flash | `landing` | 50 | `ExtractionResult` + `hosting_pages[]` |
| HostingPageAgent | flash | `hosting` | 20 | `ExtractionResult` + streams |
| EmbeddedPageAgent | flash | `embedded` | 20 | `ExtractionResult` + streams |
| OrchestratorAgent | flash-lite | none | 60 | `PipelineResult` |

## Shared Runtime Model

All browser-facing agents use `run_agent_loop()` with MCP-scoped tool sessions. The important inspect change is architectural:

1. raw browser evidence is collected internally
2. the public inspect tool for that profile returns grouped, compressed summaries
3. exact expansion happens only through follow-up tools

This keeps agent prompts stable while avoiding context blow-ups on large landing pages.

## ClassificationAgent

**File:** [`src/agents/classification.py`](../../src/agents/classification.py)  
**Prompt:** [`configs/prompts/classification_v1.md`](../../configs/prompts/classification_v1.md)

### Purpose

Classify a URL as:

- `landing_page`
- `host_page`
- `embed_video_page`
- `other`

### Inspect contract

Classification uses `inspect`, but `inspect` is now classification-specific. It returns:

- `classification_hints`
- `link_groups`
- `action_groups`
- `top_candidates`
- `player_evidence`
- `frame_overview`
- `pagination`
- `blockers`
- compression telemetry in `stats`

Classification should reason from grouped evidence first and only expand through targeted follow-up tools when ambiguity remains.

### Why this matters

Large landing pages used to flood the model with giant flat inspect payloads. Classification now gets a grouped low-token summary instead of raw `contentLinks`, `elements`, or `frame_tree`.

## LandingPageAgent

**File:** [`src/agents/landing_page.py`](../../src/agents/landing_page.py)  
**Prompt:** [`configs/prompts/landing_page_v1.md`](../../configs/prompts/landing_page_v1.md)

### Purpose

Discover downstream hosting/watch targets from listing, schedule, or homepage surfaces.

### Inspect contract

Landing uses `inspect_landing`, which now returns grouped-first payloads:

- `grouped_sections`
- `match_groups`
- `navigation_groups`
- `action_groups`
- `top_match_candidates`
- `iframe_overview`
- `pagination`
- `popups`
- compression telemetry in `stats`

The landing agent should use groups to understand repeated DOM patterns, then use representative match candidates for navigation.

## HostingPageAgent

**File:** [`src/agents/hosting_page.py`](../../src/agents/hosting_page.py)  
**Prompt:** [`configs/prompts/hosting_page_v1.md`](../../configs/prompts/hosting_page_v1.md)

### Purpose

Extract streams from same-site watch/hosting pages and cycle through every distinct server/source path.

### Inspect contract

Hosting uses `inspect_hosting`, which now returns:

- `control_groups`
- `playback_groups`
- `iframe_groups`
- `player_evidence`
- `top_server_controls`
- `top_playback_targets`
- `popups`
- compression telemetry in `stats`

The agent should understand server structure from grouped summaries first, then use representative top controls for exact interactions.

## EmbeddedPageAgent

**File:** [`src/agents/embedded_page.py`](../../src/agents/embedded_page.py)  
**Prompt:** [`configs/prompts/embedded_page_v1.md`](../../configs/prompts/embedded_page_v1.md)

### Purpose

Extract streams from direct embedded or third-party player pages, especially iframe-heavy layouts.

### Inspect contract

Embedded uses `inspect_embedded`, which now returns:

- `control_groups`
- `player_groups`
- `frame_focus_groups`
- `player_evidence`
- `top_source_controls`
- `top_player_targets`
- `popups`
- compression telemetry in `stats`

The embedded agent should use grouped source/player structure first and only use the top representative controls for exact activation or server switching.

## OrchestratorAgent

**File:** [`src/agents/orchestrator.py`](../../src/agents/orchestrator.py)  
**Prompt:** `configs/prompts/orchestrator_v1.md` (deleted; the orchestrator now compiles from the reasoning-first prompt contracts, see plan task 25 of `.omo/plans/full-audit.md`)

### Purpose

Coordinate:

- classification
- landing discovery
- hosting extraction
- embedded extraction
- provider analysis
- takedown email generation

The orchestrator does not need changes to MCP profile wiring for this inspect redesign. The contract change is local to the prompt-facing inspect payloads used by sub-agents.

## Token-Efficiency Rule

Inspect payload size is now controlled by grouped summarization and adaptive compression, not by asking the LLM to read giant raw lists carefully. Follow-up tools are the only supported path for exact expansion when grouped summaries are insufficient.
