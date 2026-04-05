"""Shared agent configuration: LLM, callbacks, budgets."""

from __future__ import annotations

from langchain_google_genai import ChatGoogleGenerativeAI

from src.utils.config import Settings


def build_llm(settings: Settings, temperature: float | None = None) -> ChatGoogleGenerativeAI:
    """Construct the shared Gemini Flash LLM instance."""
    return ChatGoogleGenerativeAI(
        model=settings.gemini_model,
        google_api_key=settings.google_api_key,
        temperature=temperature if temperature is not None else settings.gemini_temperature,
        convert_system_message_to_human=True,
    )


class BudgetExceededError(Exception):
    """Raised when an agent exceeds its maximum tool call budget."""
    pass
