"""Gradio dashboard: per-agent testing + full pipeline demo."""

from __future__ import annotations

import json

import gradio as gr

from src.utils.config import Settings

settings = Settings.from_yaml()


def _run_pipeline(url: str) -> tuple[str, str, str]:
    """Run the full pipeline on a URL. Returns (status, streams_json, screenshots_md)."""
    from src.agents.orchestrator import run_pipeline

    if not url.strip():
        return "Error", "Please provide a URL.", ""
    try:
        result = run_pipeline(url=url.strip(), settings=settings)
        status = f"{result.final_status} | {len(result.streams)} streams found"
        streams = json.dumps([s.model_dump() for s in result.streams], indent=2)
        screenshots = "\n\n".join(f"![]({u})" for u in result.screenshots) or "_No screenshots._"
        return status, streams, screenshots
    except Exception as e:
        return "Error", str(e), ""


def _run_classification(url: str) -> str:
    from src.agents.classification import ClassificationAgent

    if not url.strip():
        return "Please provide a URL."
    try:
        agent = ClassificationAgent(settings)
        result = agent.run(url=url.strip())
        return result.model_dump_json(indent=2)
    except Exception as e:
        return f"Error: {e}"


def _run_landing(url: str) -> str:
    from src.agents.landing_page import LandingPageAgent

    if not url.strip():
        return "Please provide a URL."
    try:
        agent = LandingPageAgent(settings)
        result = agent.run(url=url.strip())
        return result.model_dump_json(indent=2)
    except Exception as e:
        return f"Error: {e}"


def _run_hosting(url: str) -> str:
    from src.agents.hosting_page import HostingPageAgent

    if not url.strip():
        return "Please provide a URL."
    try:
        agent = HostingPageAgent(settings)
        result = agent.run(url=url.strip())
        return result.model_dump_json(indent=2)
    except Exception as e:
        return f"Error: {e}"


def _run_embedded(url: str) -> str:
    from src.agents.embedded_page import EmbeddedPageAgent

    if not url.strip():
        return "Please provide a URL."
    try:
        agent = EmbeddedPageAgent(settings)
        result = agent.run(url=url.strip())
        return result.model_dump_json(indent=2)
    except Exception as e:
        return f"Error: {e}"


def build_ui() -> gr.Blocks:
    with gr.Blocks(title="Open Web Catcher", theme=gr.themes.Soft()) as demo:
        gr.Markdown("# Open Web Catcher\nMulti-agent streaming URL extractor.")

        with gr.Tab("Full Pipeline"):
            url_in = gr.Textbox(label="Target URL", placeholder="https://example-streaming-site.com/movie/123")
            run_btn = gr.Button("Run Pipeline", variant="primary")
            status_out = gr.Textbox(label="Status")
            streams_out = gr.Code(label="Streams (JSON)", language="json")
            shots_out = gr.Markdown(label="Screenshots")
            run_btn.click(_run_pipeline, inputs=url_in, outputs=[status_out, streams_out, shots_out])

        with gr.Tab("Classification"):
            c_url = gr.Textbox(label="URL")
            c_btn = gr.Button("Classify")
            c_out = gr.Code(label="Result", language="json")
            c_btn.click(_run_classification, inputs=c_url, outputs=c_out)

        with gr.Tab("Landing Page Agent"):
            l_url = gr.Textbox(label="URL")
            l_btn = gr.Button("Run")
            l_out = gr.Code(label="Result", language="json")
            l_btn.click(_run_landing, inputs=l_url, outputs=l_out)

        with gr.Tab("Hosting Page Agent"):
            h_url = gr.Textbox(label="URL")
            h_btn = gr.Button("Run")
            h_out = gr.Code(label="Result", language="json")
            h_btn.click(_run_hosting, inputs=h_url, outputs=h_out)

        with gr.Tab("Embedded Page Agent"):
            e_url = gr.Textbox(label="URL")
            e_btn = gr.Button("Run")
            e_out = gr.Code(label="Result", language="json")
            e_btn.click(_run_embedded, inputs=e_url, outputs=e_out)

    return demo


def launch(server_name: str = "0.0.0.0", server_port: int = 7860) -> None:
    build_ui().launch(server_name=server_name, server_port=server_port)


if __name__ == "__main__":
    launch()
