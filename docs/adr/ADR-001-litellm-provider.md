# ADR-001: LiteLLM as the Single LLM Provider Layer

Date: 2026-08-22
Status: Accepted. Adapter landed in `src/llm/provider.py` (plan tasks 10 and 11 of `.omo/plans/full-audit.md`). Cost math v2 landed. Forecasting endpoint is planned, not built.

## Context

The runtime called Gemini through `langchain-google-genai` directly. That coupling caused three problems:

1. Provider lock-in. Switching to OpenAI, Anthropic, OpenRouter, or NVIDIA NIM meant new SDK code paths in every agent.
2. Duplicated caching machinery. A custom `GeminiCacheManager` block sat inside the shared agent loop and behaved differently from every other provider's cache story.
3. Broken cost math. Usage extraction assumed one token-accounting shape, so cached tokens, cache writes, and thinking tokens were mispriced or silently dropped.

## Decision

All model traffic goes through one seam built on LiteLLM:

- `LlmProvider` protocol declares `async complete(messages, model_spec, tools)`. `LiteLLMProvider` implements it over `litellm.acompletion`.
- `ChatLiteLLM` keeps agent call-sites LangChain-shaped, so agents did not change form when the backend swapped.
- `normalize_model_name` maps legacy bare names such as `gemini-2.5-flash` to LiteLLM's `provider/model` routing format, using the selected provider as the prefix hint. OpenCode Zen/Go additionally route Claude and Gemini model families to their compatible LiteLLM prefixes; unrecognized names pass through bare so misconfiguration surfaces at the provider instead of being masked.
- Provider switching is config-only: `llm_provider`, `llm_base_url`, per-provider `provider_base_urls`, and the per-agent model map. No code changes to move families.
- The operator-facing provider directory is extensible. `PROVIDER_METADATA` and `SUPPORTED_PROVIDERS` include direct adapters plus LiteLLM-compatible providers, gateways, and local runtimes. Providers without a dedicated adapter use the normalized OpenAI-compatible `/models` catalog contract.
- Provider credentials are Settings-owned. `provider_api_keys` is persisted in `data/settings.runtime.yaml`, masked in `/ui/config` responses, and never required in frontend source or Docker build inputs.

Two consequences were accepted as part of the design:

- **Tool-call normalization layer.** Families emit tool calls in different shapes. The adapter normalizes them into one OpenAI-style dict form before agents see them, and converts bound tools back per family on the way out.
- **Per-family usage extraction.** `TokenUsage` buckets are filled defensively per family: Gemini (`promptTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount`, `thoughtsTokenCount`), OpenAI (`prompt_tokens_details.cached_tokens`), Anthropic (disjoint `cache_read_input_tokens` / `cache_creation_input_tokens`). Cost accounting applies family rules on top: Gemini cached tokens are a subset of input, Anthropic reads and writes are separate buckets, thinking tokens bill at the output rate.

The managed Gemini explicit-cache flow and `GeminiCacheManager` are gone. Caching now uses LiteLLM's native flags behind `prompt_cache_enabled`.

## Consequences

Positive:

- Any directory provider with a compatible LiteLLM route is reachable by editing Settings; custom OpenAI-compatible gateways can supply their own base URL.
- OpenCode Zen and OpenCode Go can be configured without adding another SDK dependency. Their catalog endpoints and current model availability remain controlled by OpenCode.
- One usage schema feeds one pricing path. Unknown models emit a warning event instead of a silent $0.
- Agent code is family-blind, which keeps prompts and tool contracts portable.

Negative and risky:

- The project now tracks LiteLLM's release cadence for family support and bug fixes.
- Family quirks concentrate in one adapter. A normalization bug affects every agent at once, so per-family fixture tests are mandatory.
- `langchain-google-genai` import paths are removed from `src/`, but the dependency entry remains in `pyproject.toml` until the dead-code purge (plan task 45) prunes it.
- Redis-backed prompt caching is planned as part of batch W4; today's cache is process-local in-memory.

## References

- Target design: `docs/architecture/target-design.md`, section 4 (LLM Provider Layer).
- Implementation: `src/llm/provider.py`.
- Provider directory: `docs/operations/provider-directory.md`.
- Plan: `.omo/plans/full-audit.md`, batch W2 (tasks 10-12).
