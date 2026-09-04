# Deployment & Docker

Open Web Catcher is containerized and orchestrated via Docker Compose.

---

## Architecture Diagram

```text
               ┌───────────────────────┐
               │    Operator Client    │
               └───────────┬───────────┘
                           │ HTTP 3005
                           ▼
               ┌───────────────────────┐
               │        owc-web        │ (Next.js 15 Console)
               └───────────┬───────────┘
                           │ HTTP 8000
                           ▼
               ┌───────────────────────┐
               │          owc          │ (FastAPI Backend + Orchestrator)
               └───┬───────────────┬───┘
                   │               │
        Internal   │               │ HTTP 3001
        Postgres   ▼               ▼
 ┌───────────────────────┐   ┌──────────────────────────┐
 │       postgres        │   │   owc-tools-playwright   │ (Playwright MCP)
 └───────────────────────┘   └─────────────┬────────────┘
                                           │
                                           ▼
                             ┌──────────────────────────┐
                             │    Chromium + uBOL       │
                             └──────────────────────────┘
```

---

## Quick Start: Using Cloud Pre-built Images

To run Open Web Catcher without compiling images locally, use the images built by our GitHub Actions CI/CD:

1. **Configure `.env`**:
   ```env
   OWC_IMAGE=ghcr.io/arfaouiahmed1/open-web-catcher
   OWC_WEB_IMAGE=ghcr.io/arfaouiahmed1/open-web-catcher-web
   OWC_TOOLS_PW_IMAGE=ghcr.io/arfaouiahmed1/open-web-catcher-tools-playwright
   OWC_TAG=latest

   POSTGRES_USER=owc
   POSTGRES_PASSWORD=your_strong_password
   POSTGRES_DB=owc

   GOOGLE_API_KEY=your_gemini_api_key
   ```

2. **Pull & Launch**:
   ```bash
   docker compose pull
   docker compose up -d
   ```

3. **Access Services**:
   - Console UI: `http://localhost:3005`
   - Backend API Docs: `http://localhost:8000/docs`
   - Playwright MCP Health: `http://localhost:3002/health`
   - Headless CDP Debugger: `http://localhost:9223`
