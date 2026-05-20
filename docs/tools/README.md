# Tooling Documentation

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Operator Console API](../api/operator-console.md) | Next: [MCP Browser Tools](./mcp-browser-tools.md)

The active tooling documentation focuses on the MCP browser tools currently used by agents. Older tool notes are archived under `docs/archive/legacy/tools`.

## Reading Order

1. [MCP Browser Tools](./mcp-browser-tools.md)
2. [LangChain And LangGraph Runtime](../system/langchain-langgraph.md)
3. [Dashboard Logging And Run Telemetry](../workflow/dashboard-logging.md)

## Why Tools Are Profile-Scoped

Each agent receives a smaller tool surface than the whole system owns. This keeps prompts shorter, reduces accidental misuse, and lets the backend tune timeouts and budgets by stage.

```mermaid
flowchart LR
  Agent["agent runtime profile"]
  MCPClient["src/tools/mcp_client.py"]
  Classification["classification profile"]
  Landing["landing profile"]
  Hosting["hosting profile"]
  Embedded["embedded profile"]
  Puppeteer["Puppeteer MCP"]
  Playwright["Playwright MCP"]

  Agent --> MCPClient
  MCPClient --> Classification
  MCPClient --> Landing
  MCPClient --> Hosting
  MCPClient --> Embedded
  Classification --> Puppeteer
  Landing --> Puppeteer
  Hosting --> Puppeteer
  Embedded --> Puppeteer
  MCPClient --> Playwright
```

The broad rule is: inspect first, then use focused detail tools. Broad context tools should summarize page structure and candidates; detail tools should return selector, XPath, frame, media, and network details for a specific target.
