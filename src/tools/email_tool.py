"""EmailTool — orchestrator calls this after analyze_providers.

Input:  infringing_url + provider_analysis JSON (from analyze_providers output)
        + extraction_results JSON (from hosting/embedded agent outputs)
Output: list of TakedownEmail objects (JSON) — one per unique provider
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from langchain_core.tools import BaseTool

from src.utils.logging import get_logger

logger = get_logger(__name__)


class EmailTool(BaseTool):
    name: str = "generate_takedown_emails"
    description: str = (
        "Generate DMCA takedown emails — one per hosting provider. "
        "Call this AFTER analyze_providers. "
        "Inputs: "
        "  infringing_url (str) — the top-level illegal streaming site URL, "
        "  provider_analysis (list) — output from analyze_providers, "
        "  extraction_results (list) — server+stream+screenshot data from hosting/embedded agents. "
        "Returns a list of email objects with subject, body, and evidence links. "
        "Emails are NOT sent — they are written for human review."
    )

    def _run(
        self,
        infringing_url: str,
        provider_analysis: list[dict],
        extraction_results: list[dict],
    ) -> str:
        from src.agents.email_generator import generate_takedown_emails
        from src.models.schemas import ExtractionResult, ProviderInfo

        logger.info(
            "EmailTool: generating emails for %d providers, %d extractions",
            len(provider_analysis), len(extraction_results),
        )

        # Deserialise inputs
        providers = [ProviderInfo(**p) for p in provider_analysis]
        extractions = []
        for e in extraction_results:
            try:
                extractions.append(ExtractionResult(**e))
            except Exception:
                pass  # skip malformed entries

        emails = generate_takedown_emails(
            infringing_url=infringing_url,
            extraction_results=extractions,
            provider_analysis=providers,
        )
        return json.dumps([em.model_dump(mode="json") for em in emails])

    async def _arun(
        self,
        infringing_url: str,
        provider_analysis: list[dict],
        extraction_results: list[dict],
    ) -> Any:
        return await asyncio.to_thread(
            self._run,
            infringing_url,
            provider_analysis,
            extraction_results,
        )
