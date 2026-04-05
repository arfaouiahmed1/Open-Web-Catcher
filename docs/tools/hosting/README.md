# Hosting Agent Tools

> See also: [Browser Tools Index](../browser-tools.md)

The hosting agent works on a single watch page and cycles through every server
to extract streams and fallback embeds.

## Tool Set

| Tool | Purpose |
|------|---------|
| `inspect` | Detect players, server tabs, iframes, and overlays |
| `navigate` | Recover from redirects or reopen the target hosting page |
| `interact` | Switch servers, press play, dismiss overlays, click coordinates |
| `harvest` | Capture streaming URLs from network/CDP/DOM/player signals |
| `screenshot` | Capture quick visual evidence between extraction attempts |

## Typical Flow

1. `inspect()` to identify server controls and player state
2. `interact()` to activate the player or change server
3. `harvest()` after activation
4. `screenshot()` when a lightweight checkpoint is enough
5. Repeat for every server on the page
