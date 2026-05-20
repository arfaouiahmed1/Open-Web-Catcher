# Embedded Agent Tools

> **Navigation:** [Docs Home](../../../../README.md) | [Section Index](../README.md) | Previous: [Legacy Hosting Tools](../hosting/README.md) | Next: [Legacy Documentation](../../README.md)

> Archived note. Current tool documentation lives in [MCP Browser Tools](../../../../tools/mcp-browser-tools.md).

The embedded agent is similar to the hosting agent but specializes in iframe and
embedded-player contexts where selectors are often unreliable.

## Tool Set

| Tool | Purpose |
|------|---------|
| `inspect` | Detect player iframe, overlays, and visible controls |
| `navigate` | Open or recover the embedded URL directly |
| `interact` | Play video, click coordinates, dismiss blockers, switch sources |
| `harvest` | Capture stream URLs after the player is activated |
| `screenshot` | Capture player evidence without a full inspect pass |

## Typical Flow

1. `inspect()` to understand iframe/player shape
2. `interact()` using selectors or coordinates
3. `harvest()` while the embedded player is active
4. `screenshot()` for proof when needed
