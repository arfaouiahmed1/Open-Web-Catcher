# Classification Agent Tools

> See also: [Browser Tools Index](../browser-tools.md)

The classification agent gets the smallest tool surface so it can inspect and
route pages without drifting into extraction work.

## Tool Set

| Tool | Purpose |
|------|---------|
| `inspect` | Read the current page structure, links, iframes, buttons, and page signals |
| `navigate` | Visit a URL or recover after a redirect during classification |

## What This Agent Should Not Use

- No `interact`
- No `harvest`
- No `screenshot` as a standalone tool

## Typical Flow

1. `navigate(url)` when the current page is wrong or blank
2. `inspect()` to gather page evidence
3. Return page type and routing decision
