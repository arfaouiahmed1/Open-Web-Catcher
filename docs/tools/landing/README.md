# Landing Agent Tools

> See also: [Browser Tools Index](../browser-tools.md)

The landing agent explores catalog or hub pages and discovers every watchable
hosting page it should hand off for extraction.

## Tool Set

| Tool | Purpose |
|------|---------|
| `inspect` | Understand structure, cards, pagination, iframes, and interactive elements |
| `navigate` | Move between sections, next pages, or recover from redirects |
| `interact` | Click tabs, pagination controls, filters, and watch links |
| `screenshot` | Capture lighter visual checkpoints without doing a full inspect again |

## Typical Flow

1. `inspect()` to map the current page
2. `interact()` or `navigate()` through tabs/pages
3. `screenshot()` for quick evidence between steps
4. Return discovered hosting page URLs
