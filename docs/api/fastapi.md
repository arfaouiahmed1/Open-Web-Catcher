# REST API Reference

> **See also:** [Gradio Dashboard](gradio.md) · [Data Flow](../architecture/data-flow.md) · [← Docs Home](../README.md)

Interactive docs available at **http://localhost:8000/docs** when the container is running.

---

## Endpoints

### `GET /health`

Liveness check. Returns model names so you can confirm configuration.

**Response:**
```json
{
  "status": "ok",
  "orchestrator_model": "gemini-2.5-flash-lite-preview-05-20",
  "agent_model": "gemini-2.5-flash-preview-05-20"
}
```

---

### `POST /classify`

Run only the classification agent on a URL. Fast (1–5 tool calls, no stream extraction).

**Request:**
```json
{ "url": "https://illegal-site.com/schedule" }
```

**Response:** `ClassificationResult`
```json
{
  "url": "https://illegal-site.com/schedule",
  "page_type": "landing_page",
  "confidence": "high",
  "reasoning": "Page contains a schedule table with links to individual match pages..."
}
```

`page_type` values: `landing_page` | `hosting_page` | `embedded_page` | `unknown`  
`confidence` values: `high` | `medium` | `low`

---

### `POST /extract`

Run a single extraction agent when you already know the page type.
Skips classification and orchestration. Useful for testing individual agents.

**Request:**
```json
{
  "url": "https://illegal-site.com/match/123",
  "page_type": "hosting_page"
}
```

`page_type` values: `landing_page` | `hosting_page` | `embedded_page`

**Response:** `ExtractionResult`
```json
{
  "url": "https://illegal-site.com/match/123",
  "page_type": "hosting_page",
  "status": "success",
  "streams": [
    {
      "url": "https://cdn.example.com/hls/stream.m3u8",
      "protocol": "hls",
      "source_layer": "Server 1"
    }
  ],
  "screenshots": [
    "https://res.cloudinary.com/your-cloud/image/upload/v.../screenshot.jpg"
  ],
  "embedded_urls": [],
  "agent_type": "hosting_page",
  "tool_calls_used": 8,
  "metadata": { ... }
}
```

`status` values: `success` | `partial` | `failed`

---

### `POST /run`

Run the full pipeline on a URL. This is the main endpoint.

**Request:**
```json
{ "url": "https://illegal-site.com/match/123" }
```

**Response:** `PipelineResult` (also persisted to PostgreSQL)

```json
{
  "run_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "url": "https://illegal-site.com/match/123",
  "classification": {
    "url": "...",
    "page_type": "landing_page",
    "confidence": "high",
    "reasoning": "..."
  },
  "matches": [
    {
      "url": "https://illegal-site.com/match/123/watch",
      "title": "Team A vs Team B",
      "participants": ["Team A", "Team B"],
      "channel": "Sports HD"
    }
  ],
  "extraction_results": [
    {
      "url": "https://illegal-site.com/match/123/watch",
      "page_type": "hosting_page",
      "status": "success",
      "streams": [ ... ],
      "screenshots": [ ... ],
      "tool_calls_used": 12,
      "metadata": { ... }
    }
  ],
  "final_status": "success",
  "all_streams": [
    { "url": "https://cdn1.example.com/stream.m3u8", "protocol": "hls", "source_layer": "Server 1" },
    { "url": "https://cdn2.example.com/stream.mpd", "protocol": "dash", "source_layer": "Server 2" }
  ],
  "all_screenshots": [ "https://res.cloudinary.com/..." ],
  "provider_analysis": [
    {
      "stream_url": "https://cdn1.example.com/stream.m3u8",
      "hostname": "cdn1.example.com",
      "ip": "104.21.48.1",
      "org": "AS13335 Cloudflare Inc",
      "country": "US",
      "city": "San Francisco",
      "abuse_email": "abuse@cloudflare.com"
    }
  ],
  "takedown_emails": [
    {
      "provider": "Cloudflare Inc",
      "abuse_email": "abuse@cloudflare.com",
      "subject": "DMCA Takedown Notice — Illegal Streaming via Cloudflare CDN",
      "body": "Dear Cloudflare Inc Abuse Team,\n\nWe are writing to notify you...",
      "evidence": [
        { "type": "screenshot", "url": "https://res.cloudinary.com/...", "label": "Server 1" },
        { "type": "stream_url", "url": "https://cdn1.example.com/stream.m3u8" }
      ]
    }
  ]
}
```

---

### `GET /runs`

List recent pipeline runs from the database.

**Query parameters:**
- `limit` (int, default 50) — max number of runs to return

**Response:**
```json
[
  {
    "run_id": "f47ac10b-...",
    "url": "https://illegal-site.com/match/123",
    "page_type": "landing_page",
    "status": "success",
    "streams_found": 4,
    "emails_generated": 2,
    "success": true,
    "duration_seconds": 87.3,
    "created_at": "2024-01-15T20:00:00"
  }
]
```

---

### `GET /runs/{run_id}`

Get the full `PipelineResult` for a specific run.

**Response:** Same as `POST /run` response.

**Errors:**
- `404` if `run_id` not found

---

### `GET /runs/{run_id}/emails`

Get only the takedown emails for a specific run (lightweight endpoint for email clients).

**Response:**
```json
{
  "run_id": "f47ac10b-...",
  "url": "https://illegal-site.com/match/123",
  "emails": [
    {
      "provider": "Cloudflare Inc",
      "abuse_email": "abuse@cloudflare.com",
      "subject": "DMCA Takedown Notice...",
      "body": "...",
      "evidence": [...]
    }
  ]
}
```

---

## Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `400` | Bad request (invalid `page_type`, malformed JSON) |
| `404` | Run not found |
| `422` | Validation error (Pydantic) |
| `500` | Internal server error (agent crash, LLM error) |

---

## Common Errors

**`422 Unprocessable Entity`** — Usually a missing field or wrong type in the request body.
Check the request JSON against the schema above.

**`500 Internal Server Error`** — Check `data/logs/api.log` inside the container:
```bash
docker exec owc tail -50 data/logs/api.log
```

**Agent returns `status: failed`** — The LLM agent ran but couldn't extract streams.
Check the `metadata` field in `ExtractionResult` for the agent's reasoning.

---

*Next: [Gradio Dashboard](gradio.md) | [Data Flow](../architecture/data-flow.md)*
