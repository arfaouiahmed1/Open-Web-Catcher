# Evidence Contract (v2)

All claims produced by OWC browser agents must be grounded in verifiable proof artifacts.

## Evidence Kinds

- `screenshot`: Reference to a content-addressed image (`blobref:<sha256[:16]>`). Used for visual confirmation of page state, playback verification, and challenge documentation.
- `network_entry`: URL recorded in the always-on network ledger during page lifetime.
- `manifest_probe`: Validated probe result for an HLS (.m3u8) or DASH (.mpd) stream (HTTP status 200/206).
- `media_sample`: Transient SHA-256 hash of the first media segment (live smoke tests only).
- `page_state`: Pointer to a specific `page_state.id` establishing temporal consistency.
- `dom_snapshot`: Stored ARIA or accessibility tree snapshot.

## Invariant Rules

1. **Anti-Hallucination**: Every stream URL, server label, or match card claimed in the final answer must cite at least one evidence item returned by a tool call in this session. Uncited claims are rejected by the validator.
2. **State Consistency**: Proof cited with a `page_state_id` that does not match the page state at the time of claim will be considered stale and rejected.
3. **No Fabricated URLs**: URLs containing placeholder text (e.g. `example.com`, `stream.m3u8`) or URLs not observed in network ledger or DOM inspect results will trigger an automatic replan or failure.
