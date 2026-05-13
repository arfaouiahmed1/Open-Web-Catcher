# Quickstart

## 1. Configure Environment

```bash
cp .env.example .env
```

Fill in:

- `GOOGLE_API_KEY`
- optional Cloudinary credentials
- optional `IPINFO_TOKEN`

## 2. Start the Stack

```bash
docker compose up --build
```

## 3. Open the Product

- Operator console: `http://localhost:3000`
- API docs and routes: `http://localhost:8000`

## 4. Try a Workflow

Use the console:

- open `Live Workflow`
- enter a target URL
- run the workflow
- inspect streamed events, tool calls, previews, costs, and tokens

## 5. Validate the Runtime

```bash
cd web
npm run build
```

For backend startup sanity:

```powershell
.venv\Scripts\python.exe -c "from src.api.app import app; print('backend ok')"
```
