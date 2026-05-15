# Browser Tools Reference

> **See also:** [MCP Server Architecture](../architecture/mcp-server.md) · [Python Tools](python-tools.md) · [Classification Tools](classification/README.md) · [Docs Home](../README.md)

All browser tools run inside the Node.js MCP server under `tools/puppeteer/` and `tools/playwright/`.

## Inspect Architecture

The inspect stack now has 2 layers:

1. **Internal collector**
   - File: [`tools/puppeteer/tools/inspect_full.js`](../../tools/puppeteer/tools/inspect_full.js)
   - Purpose: gather full raw DOM, frame, player, popup, and pagination evidence
   - Audience: internal summarizers only
   - Not part of the LLM-facing contract

2. **Public summarizers**
   - [`inspect`](../../tools/puppeteer/tools/inspect.js): classification-focused
   - [`inspect_landing`](../../tools/puppeteer/tools/inspect_landing.js): landing-focused
   - [`inspect_hosting`](../../tools/puppeteer/tools/inspect_hosting.js): hosting-focused
   - [`inspect_embedded`](../../tools/puppeteer/tools/inspect_embedded.js): embedded-focused

Public inspect tools do **not** expose giant flat arrays as their primary contract anymore. They return grouped summaries plus representative actionable samples.

## Compression Model

Each public inspect tool:

1. collects raw evidence through `inspect_full.js`
2. groups repeated links, controls, and frames by semantic pattern
3. builds representative candidates
4. adaptively compresses the payload until it fits the profile budget

Profile budgets:

| Tool | Target serialized size |
|------|-------------------------|
| `inspect` | <= 8 KB |
| `inspect_landing` | <= 18 KB |
| `inspect_hosting` | <= 14 KB |
| `inspect_embedded` | <= 14 KB |

This is adaptive compression, not crude per-array hard caps. Compression prefers to:

1. dedupe exact duplicates
2. hoist repeated structure to group level
3. keep generalized URL patterns instead of repeating every URL
4. shrink per-group samples
5. shrink lower-priority groups

Critical player and watch-pattern evidence is preserved as long as possible.

Every public inspect response includes compression telemetry in `stats`:

- `raw_counts`
- `output_counts`
- `compressed_bytes`
- `estimated_tokens`
- `compression_ratio`
- `budget_target`
- `budget_fit`
- `compression_steps`

## When To Use Follow-up Tools

Use the grouped inspect output first. If more detail is needed, expand with:

- `query_elements`
- `get_element_detail`
- `get_frame_tree`
- `get_page_context`

Do not expect `inspect` to dump exhaustive raw DOM lists. Expansion is explicit.

## Tool-to-Profile Mapping

| Tool | classification | landing | hosting | embedded |
|------|:--------------:|:-------:|:-------:|:--------:|
| `inspect` | yes | no | no | no |
| `inspect_landing` | no | yes | no | no |
| `inspect_hosting` | no | no | yes | no |
| `inspect_embedded` | no | no | no | yes |
| `navigate` | yes | yes | yes | yes |
| `interact` | no | yes | yes | yes |
| `screenshot` | no | yes | yes | yes |
| `harvest` | no | no | yes | yes |

## `inspect`

**File:** [`tools/puppeteer/tools/inspect.js`](../../tools/puppeteer/tools/inspect.js)

Classification-oriented grouped inspect.

### Output contract

```ts
{
  context_type: "classification"
  page: {
    url: string
    title: string
    screenshot: "available" | "missing"
  }
  screenshot_url: string | null
  classification_hints: {
    likely_page_type: "landing_page" | "host_page" | "embed_video_page"
    scores: Record<string, number>
    reasons: string[]
  }
  link_groups: Group[]
  action_groups: Group[]
  top_candidates: {
    watch: ActionableLink[]
    navigation: ActionableLink[]
    actions: ActionableAction[]
  }
  player_evidence: PlayerEvidence
  frame_overview: FrameOverview
  blockers: { popups: PopupSummary[] }
  pagination: PaginationSummary
  lazy_load_warmup: object | null
  stats: CompressionStats
}
```

## `inspect_landing`

**File:** [`tools/puppeteer/tools/inspect_landing.js`](../../tools/puppeteer/tools/inspect_landing.js)

Landing-page grouped inspect.

### Output contract

```ts
{
  context_type: "landing"
  page: PageSummary
  screenshot_url: string | null
  grouped_sections: { page: PageSummary, groups: Group[] }
  match_groups: Group[]
  navigation_groups: Group[]
  action_groups: Group[]
  top_match_candidates: ActionableLink[]
  iframe_overview: FrameOverview & { iframe_groups: FrameGroup[] }
  pagination: PaginationSummary
  popups: PopupSummary[]
  lazy_load_warmup: object | null
  stats: CompressionStats
}
```

## `inspect_hosting`

**File:** [`tools/puppeteer/tools/inspect_hosting.js`](../../tools/puppeteer/tools/inspect_hosting.js)

Hosting-page grouped inspect.

### Output contract

```ts
{
  context_type: "hosting"
  page: PageSummary
  screenshot_url: string | null
  control_groups: Group[]
  playback_groups: Group[]
  iframe_groups: FrameGroup[]
  player_evidence: PlayerEvidence
  top_server_controls: ActionableAction[]
  top_playback_targets: ActionableAction[]
  popups: PopupSummary[]
  lazy_load_warmup: object | null
  stats: CompressionStats
}
```

## `inspect_embedded`

**File:** [`tools/puppeteer/tools/inspect_embedded.js`](../../tools/puppeteer/tools/inspect_embedded.js)

Embedded-player grouped inspect.

### Output contract

```ts
{
  context_type: "embedded"
  page: PageSummary
  screenshot_url: string | null
  control_groups: Group[]
  player_groups: Group[]
  frame_focus_groups: FrameGroup[]
  player_evidence: PlayerEvidence
  top_source_controls: ActionableAction[]
  top_player_targets: ActionableAction[]
  popups: PopupSummary[]
  lazy_load_warmup: object | null
  stats: CompressionStats
}
```

## Representative Samples

Representative actionable samples preserve the fields needed for follow-up actions:

- `text`
- `selector`
- `xpath`
- `frame_path`
- `x`
- `y`

Grouped samples may omit some of those fields to save tokens. Exact interaction should use the top candidate arrays or follow-up tools.

## Other Core Tools

- `interact`: perform clicks, play, type, select, checks, or coordinate clicks with frame-aware resolution
- `navigate`: move to a URL and capture redirect outcome
- `screenshot`: fast visual confirmation without a full grouped inspect
- `harvest`: capture stream URLs after player activation

*Next: [Python Tools](python-tools.md) | [MCP Server Architecture](../architecture/mcp-server.md)*
