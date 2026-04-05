# Gradio Dashboard

> **See also:** [REST API](fastapi.md) · [Agents](../architecture/agents.md) · [← Docs Home](../README.md)

The Gradio dashboard is available at **http://localhost:7860** when the container is running.

**File:** [`src/api/gradio_app.py`](../../src/api/gradio_app.py)

---

## Tabs

### Full Pipeline

The main tab. Submits a URL through the entire orchestration pipeline:
classify → landing → hosting → embedded → IPInfo → DMCA emails.

**Inputs:**
- URL text box

**Outputs:**
- **Status** — `success | 4 streams` or `Error: ...`
- **Streams (JSON)** — all extracted stream URLs as formatted JSON
- **Screenshots** — inline screenshots uploaded to Cloudinary

Use this tab to demonstrate the full pipeline to stakeholders or test an unknown URL.

---

### Classification

Runs only the `ClassificationAgent`. Returns a JSON object with `page_type`, `confidence`, and `reasoning`.

Use this tab to:
- Quickly check what type a page is before running the full pipeline
- Test the classification prompt against edge cases
- Debug misclassifications

---

### Landing Page Agent

Runs `LandingPageAgent` directly on a URL (assumes it's a landing page, skips classification).
Returns all discovered hosting page URLs and match metadata.

Use this tab to:
- Verify the landing agent finds all matches on a schedule/catalog page
- Test pagination and lazy-loading handling
- Debug cases where some matches are missed

---

### Hosting Page Agent

Runs `HostingPageAgent` directly on a URL (assumes it's a hosting/player page).
Returns streams, screenshots, and embedded URLs found across all servers.

Use this tab to:
- Test stream extraction on a specific match URL
- Check if all server tabs are being cycled
- Verify harvest is capturing streams from the correct layers

---

### Embedded Page Agent

Runs `EmbeddedPageAgent` directly on an iframe/embed URL.
Returns streams extracted from the third-party player.

Use this tab to:
- Test coordinate-mode clicking on cross-origin iframes
- Debug cases where the iframe player doesn't load streams
- Verify multi-server cycling on embed players

---

## How Agent Calls Work in Gradio

Gradio handlers are synchronous functions. Since all agents are `async`, each handler
wraps the call with `asyncio.run()`:

```python
def _run_classification(url: str) -> str:
    result = asyncio.run(ClassificationAgent(settings).run(url=url.strip()))
    return result.model_dump_json(indent=2)
```

This is safe in Gradio because each button click runs in a separate thread.
Gradio's event loop doesn't conflict with `asyncio.run()` in worker threads.

---

## Launching Outside Docker

```bash
# From the project root with venv activated
python -m src.api.gradio_app

# Or with custom host/port
python -c "from src.api.gradio_app import launch; launch(server_port=8080)"
```

The Gradio server defaults to `0.0.0.0:7860`.

---

## Extending the Dashboard

To add a new tab (e.g., a batch processing view):

```python
# In src/api/gradio_app.py, inside build_ui():
with gr.Tab("Batch"):
    file_in = gr.File(label="URLs JSON file")
    run_btn = gr.Button("Run Batch")
    results_out = gr.DataFrame(label="Results")
    run_btn.click(fn=_run_batch, inputs=file_in, outputs=results_out)
```

---

*Next: [REST API](fastapi.md) | [Agents](../architecture/agents.md)*
