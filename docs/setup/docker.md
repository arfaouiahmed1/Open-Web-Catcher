# Docker Setup

The Docker topology is defined in [`docker-compose.yml`](../../docker-compose.yml).

## Services

- `postgres`
- `owc-tools`
- `owc`
- `owc-web`

## Ports

- `3000`: MCP tools server
- `3001`: Next.js operator console
- `8000`: FastAPI backend

## Build Files

- [`Dockerfile`](../../Dockerfile)
- [`Dockerfile.tools`](../../Dockerfile.tools)
- [`Dockerfile.web`](../../Dockerfile.web)

## Lifecycle Scripts

PowerShell helpers live in [`scripts/docker`](../../scripts/docker):

- `build.ps1`
- `start.ps1`
- `stop.ps1`
- `restart.ps1`
- `clean.ps1`
- `test.ps1`

## Typical Start

```powershell
cp .env.example .env
docker compose up --build
```

## Runtime Summary

- FastAPI runs under `supervisord` in the `owc` container
- Next.js runs in its own container
- the backend talks to the MCP tools container over the internal Docker network
- the web container talks to the backend through `API_BASE_URL`
