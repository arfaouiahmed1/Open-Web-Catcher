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

- Operator console: `http://localhost:3001`
- API docs and routes: `http://localhost:8000`

## 4. Try a Workflow

Use the console:

- open `Live Workflow`
- enter a target URL
- run the workflow
- inspect streamed events, tool calls, previews, costs, and tokens

## 5. Run Tests

Backend:

```bash
pytest tests/
```

Web:

```bash
cd web
npm run build
```
