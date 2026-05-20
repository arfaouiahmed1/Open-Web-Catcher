# Classification Agent Tools

> **Navigation:** [Docs Home](../../../../README.md) | [Section Index](../README.md) | Previous: [Legacy Playwright Vs Puppeteer](../playwright-vs-puppeteer.md) | Next: [Legacy Landing Tools](../landing/README.md)

> Archived note. Current tool documentation lives in [MCP Browser Tools](../../../../tools/mcp-browser-tools.md).

The classification agent uses the smallest browser tool surface. Its main job is to route a page to the right downstream agent without pulling a giant inspect payload into the model context.

## Tool Set

| Tool | Purpose |
|------|---------|
| `inspect` | Grouped, low-token page understanding for classification |
| `navigate` | Visit a URL or recover after drift |
| `interact` | One focused reveal action when the page state is ambiguous |
| `screenshot` | Visual confirmation after state changes |
| `query_elements` | Targeted expansion when grouped inspect is insufficient |
| `get_element_detail` | Local subtree expansion |
| `get_frame_tree` | Frame-level expansion when ownership is unclear |
| `get_page_context` | Lightweight compatibility read |

## `inspect` Contract

The classification `inspect` tool is grouped-first and compression-aware. It does not return the old giant flat arrays as its public contract.

### Output schema

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
    scores: {
      landing_page: number
      host_page: number
      embed_video_page: number
    }
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
  blockers: {
    popups: PopupSummary[]
  }
  pagination: PaginationSummary
  lazy_load_warmup: object | null
  stats: CompressionStats
}
```

### What changed

- Old flat inspect lists are no longer the classification contract.
- Repeated links are grouped by watch/category/nav/schedule/status patterns.
- Repeated controls are grouped by play/filter/server/pagination roles.
- Only representative actionable candidates are kept in `top_candidates`.
- Compression telemetry is exposed so oversized pages can be diagnosed.

## Expected Classification Flow

1. `inspect()` on the current page
2. read `classification_hints`, `link_groups`, `action_groups`, and `player_evidence`
3. if needed, use one follow-up expansion tool on a representative target
4. return `landing_page`, `host_page`, `embed_video_page`, or `other`

## Example Reasoning Targets

### Landing page

- multiple `link_groups` such as `live_watch_cards`, `sports_categories`, and `header_nav`
- pagination detected
- weak player evidence

### Host page

- strong `player_evidence`
- server/source controls present
- focused watch-page structure rather than a large listing hub

### Embedded page

- dominant player or iframe evidence
- very little surrounding site chrome
- weak navigation structure

## What this agent should not expect

- full `contentLinks` dumps
- full `elements` dumps
- full `frame_tree` dumps

If more detail is needed, use `query_elements`, `get_element_detail`, `get_frame_tree`, or `get_page_context`.
