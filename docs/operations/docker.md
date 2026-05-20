# Docker And Ports

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Operations Index](./README.md) | Next: [Configuration](./configuration.md)

Use this page for operational orientation. The physical topology is also diagrammed in [Deployment](../system/deployment.md).

## Services

| Service | Role | Host access |
| --- | --- | --- |
| `owc-web` | Next.js console | `http://localhost:3000` |
| `owc` | FastAPI backend | `http://localhost:8000` |
| `postgres` | database | internal |
| `owc-tools` | Puppeteer MCP + Chrome | `http://localhost:3001`, debug `9222` |
| `owc-tools-playwright` | Playwright MCP + browser | `http://localhost:3002`, debug `9223` |

## Health Check Flow

```mermaid
flowchart TD
  Start["docker compose up"]
  Postgres["postgres pg_isready"]
  Tools["owc-tools /health"]
  PW["owc-tools-playwright /health"]
  API["owc /health"]
  Web["owc-web starts"]
  UI["open localhost:3000"]

  Start --> Postgres --> API
  Start --> Tools --> API
  Start --> PW --> API
  API --> Web --> UI
```

## Useful Commands

```powershell
docker compose ps
docker compose logs --tail=120 owc
docker compose logs --tail=120 owc-web
docker compose logs --tail=120 owc-tools
docker compose logs --tail=120 owc-tools-playwright
curl.exe http://localhost:8000/health
curl.exe http://localhost:8000/ui/browser/status
```

## Rebuild Notes

If backend code changes, rebuild and restart `owc`. If frontend code changes, rebuild and restart `owc-web`. If browser tools change, rebuild the corresponding `owc-tools` or `owc-tools-playwright` image.

