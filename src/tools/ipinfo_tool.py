"""IPInfoTool — orchestrator calls this after all stream extractions are done.

Input: list of stream URLs.
Output: list of ProviderInfo objects (JSON) with IPInfo geolocation plus RDAP/Whois
ownership and abuse-contact evidence per URL.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import Field

from src.utils.logging import get_logger

logger = get_logger(__name__)


class IPInfoTool(BaseTool):
    name: str = "analyze_providers"
    description: str = (
        "Look up the hosting provider for each stream URL using IPInfo plus RDAP/Whois enrichment. "
        "Call this AFTER all run_hosting_agent and run_embedded_agent calls are done. "
        "Input: a list of stream URLs (m3u8/mpd/mp4). "
        "Returns provider name, country, abuse email, IP, and raw whois evidence for each URL."
    )
    ipinfo_token: str = Field(default="")

    def _run(self, stream_urls: list[str]) -> str:
        from src.utils.ipinfo import lookup_multiple

        if not stream_urls:
            return json.dumps([])

        logger.info("IPInfoTool: looking up %d stream URLs", len(stream_urls))
        results = lookup_multiple(stream_urls=stream_urls, ipinfo_token=self.ipinfo_token)
        return json.dumps([r.model_dump() for r in results])

    async def _arun(self, stream_urls: list[str]) -> Any:
        return await asyncio.to_thread(self._run, stream_urls)
