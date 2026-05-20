# Deployment And Physical Runtime

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Runtime Classes And Functions](./runtime-classes-functions.md) | Next: [Data Model](./data-model.md)

The local product stack is Docker-first. The browser opens the operator console on port `3000`, while the backend API is exposed on port `8000`. Browser automation is split into Puppeteer and Playwright tool containers so both engines can be tested and kept available.

## Docker Topology

```mermaid
flowchart TB
  Browser["Browser<br/>http://localhost:3000"]

  subgraph Compose["docker-compose.yml"]
    Web["owc-web<br/>container port 3001<br/>host localhost:3000"]
    API["owc<br/>FastAPI :8000<br/>host localhost:8000"]
    DB[("postgres<br/>5432 internal")]
    Puppeteer["owc-tools<br/>MCP :3000 -> host 3001<br/>DevTools :9222 -> host 9222"]
    Playwright["owc-tools-playwright<br/>MCP :3001 -> host 3002<br/>DevTools :9223 -> host 9223"]
    Data["./data volume"]
    Configs["./configs read-only"]
    Datasets["./datasets read-only"]
  end

  Browser --> Web
  Web -->|"API_BASE_URL=http://owc:8000"| API
  Web -->|"NEXT_PUBLIC_API_BASE_URL=http://localhost:8000"| API
  API --> DB
  API -->|"MCP_SERVER_URL_PUPPETEER=http://owc-tools:3000"| Puppeteer
  API -->|"MCP_SERVER_URL_PLAYWRIGHT=http://owc-tools-playwright:3001"| Playwright
  API --> Data
  API --> Configs
  API --> Datasets
  Puppeteer --> Data
  Playwright --> Data
```

## Port Matrix

| Service | Container | Internal port | Host port | Purpose |
| --- | --- | ---: | ---: | --- |
| `owc-web` | Next.js console | `3001` | `3000` | Operator console |
| `owc` | FastAPI backend | `8000` | `8000` | Runtime API and SSE |
| `postgres` | PostgreSQL | `5432` | internal | Run history and telemetry |
| `owc-tools` | Puppeteer MCP | `3000` | `3001` | Puppeteer profile tools |
| `owc-tools` | Chrome DevTools | `9222` | `9222` | Browser diagnostics |
| `owc-tools-playwright` | Playwright MCP | `3001` | `3002` | Playwright profile tools |
| `owc-tools-playwright` | DevTools | `9223` | `9223` | Browser diagnostics |

## Service Dependencies

```mermaid
graph TD
  PostgresReady["postgres healthy"]
  PuppeteerReady["owc-tools healthy"]
  PlaywrightReady["owc-tools-playwright healthy"]
  APIReady["owc healthy"]
  WebReady["owc-web running"]

  PostgresReady --> APIReady
  PuppeteerReady --> APIReady
  PlaywrightReady --> APIReady
  APIReady --> WebReady
```

## Runtime Environment Flow

```mermaid
flowchart LR
  Env[".env"]
  SettingsYaml["configs/settings.yaml"]
  RuntimeYaml["data/settings.runtime.yaml"]
  BrowserJson["data/browser.runtime.json"]
  FastAPI["FastAPI settings cache"]
  Agents["Agent runtime config"]
  Tools["MCP browser runtime config"]

  Env --> FastAPI
  SettingsYaml --> FastAPI
  RuntimeYaml --> FastAPI
  FastAPI --> Agents
  FastAPI --> BrowserJson
  BrowserJson --> Tools
```

## Operational Notes

- The web service talks to the API by Docker service name internally, but the browser talks to `http://localhost:8000`.
- If the page looks stale after docs or frontend changes, check whether Docker is serving an older built image.
- `owc-tools` can be healthy while the browser endpoint is unhealthy. Use `/ui/browser/status` to distinguish MCP profile health from browser DevTools reachability.
- `./data` is shared by backend and tool containers for runtime state, memory files, browser runtime config, and generated artifacts.

