# LLM Model Specifications Comparison — Context Windows, Output Limits & Caching

*Compiled for OWC internship report — June 2026*

---

## ⚠️ Corrections before you cite these in the report

These aren't nitpicks — a jury member who knows the space will catch them.

1. **"Gemini 3.1 Flash" (non-Lite, text-only) does not exist.** Google's Gemini 3 generation ships *Gemini 3 Flash* (preview), *Gemini 3.5 Flash*, and *Gemini 3.1 Flash-Lite* as the text models. "3.1 Flash" only exists under Flash Image, Flash Audio/Live, or Flash TTS branding — different modalities entirely. I've substituted **Gemini 3.1 Flash-Lite** (the model you most likely meant) and added **Gemini 3.5 Flash** as the actual non-Lite equivalent in that generation, for completeness.

2. **DeepSeek V3.2's official API identity is currently in transition.** As of this writing, DeepSeek's pricing page no longer lists V3.2 at all — `deepseek-chat` and `deepseek-reasoner` (the old V3.2 aliases) now route to `deepseek-v4-flash`'s non-thinking and thinking modes respectively, and both legacy names are scheduled for full deprecation on **2026-07-24**. If you (or your test scripts) hit DeepSeek's own API using those model names anytime after their migration cutover, you were benchmarking V4-Flash, not V3.2. The only way to reliably hit actual V3.2 weights right now is via OpenRouter's `deepseek/deepseek-v3.2` endpoint. Worth a footnote in your methodology section if your test logs use the official API.

3. **Devstral 2's "2512" suffix is a date code** (YYMM → December 2025), not a version-2.512 number — same convention Mistral uses across its 2025-12 releases (`devstral-small-2-2512`, `ministral-3-14b-2512`, etc.).

---

## Master comparison table

| Model | Provider / Access | Architecture | Input context window | Max output tokens | Context caching | Pricing (input / cached input / output, per 1M tokens) | License | Released |
|---|---|---|---|---|---|---|---|---|
| **GLM-4.5-Air** | Z.ai (native API), OpenRouter | 106B total / 12B active MoE | 128K (131,072) | 98,304 | Not officially published for this model | $0.13–0.17 / — / $0.85–0.98 (varies by host) | Open-weight (modified MIT) | Jul 28, 2025 |
| **Gemini 2.5 Flash** | Google AI Studio / Vertex AI | Dense, hybrid reasoning ("thinking" toggle) | 1,048,576 (1M) | 65,536 | Yes — explicit context caching; storage ~$1.00/M tok/hr | $0.30 / ~$0.03 (10% of input) / $2.50 | Proprietary | Jun 17, 2025 |
| **Gemini 2.5 Flash-Lite** | Google AI Studio / Vertex AI | Dense, lighter reasoning tier | 1,048,576 (1M) | 65,535 | Yes — same mechanism as 2.5 Flash | $0.10 / ~$0.01 / $0.40 | Proprietary | Jul 22, 2025 |
| **Gemini 3.1 Flash-Lite** *(stand-in for "3.1 Flash")* | Google AI Studio / Vertex AI | Based on Gemini 3 Pro architecture, 4 thinking levels | 1,048,576 (1M) | 64,000 | Yes — implicit caching | $0.25 / — | Proprietary | GA May 7, 2026 |
| **Gemini 3.5 Flash** *(actual "3.x non-Lite Flash")* | Google AI Studio / Vertex AI | Frontier-tier flash, agentic-optimized | 1,048,576 (1M) | 64,000 | Yes | $1.50 / $0.15 / $9.00 | Proprietary | mid-2026 |
| **Devstral 2 2512** | Mistral API, OpenRouter (paid + free tier) | 123B dense transformer | 262,144 (256K) | Not separately published (bounded by context minus input) | Not confirmed for this model | $0.40 / — / $2.00 (paid); $0/$0 on `:free` tier | Modified MIT (open-weight) | Dec 9, 2025 |
| **GLM-4.7** | Z.ai (native API), OpenRouter | 358B total / 32B active MoE | 200K (202,752) | 128K (131,072) | Yes — native Z.ai cache read ≈$0.11–0.12/M; OpenRouter cache read ≈$0.08/M | $0.40–0.60 / $0.08–0.12 / $1.75–2.20 (native vs. OpenRouter differ) | Weights not yet public (per Z.ai's pattern with 4.5, likely later) | Dec 22, 2025 |
| **qwen/qwen3-coder:free** | OpenRouter (free tier) | Qwen3-Coder-480B-A35B, 480B total / 35B active MoE | 1,048,576 (1M) | 262,000 | Not specified on free tier | $0 / — / $0 (free); paid tier $0.22 / — / $1.80, tiered above 128K input | Open-weight | Jul 23, 2025 |
| **GPT-5.4 nano** | OpenAI API | Dense, small tier of GPT-5.4 family | 400,000 | 128,000 | Yes — prompt caching | $0.20 / $0.02 / $1.25 | Proprietary | Mar 17, 2026 |
| **DeepSeek V3.2 — non-reasoning** (`deepseek-chat` legacy / direct V3.2 weights) | OpenRouter (`deepseek/deepseek-v3.2`); official API name now aliases to V4-Flash | 671B MoE w/ DeepSeek Sparse Attention | 131,072 (128K) | 8,000 max (4,000 default) | Yes — cache hit ≈$0.028 vs. cache miss ≈$0.28 input | $0.23–0.28 / $0.028 / $0.34–0.42 | Open-weight (MIT) | Sep 2025 |
| **DeepSeek V3.2 — reasoning** (`deepseek-reasoner` legacy / direct V3.2 weights) | Same as above, `reasoning: enabled` | Same base model | 131,072 (128K) | 64,000 max (32,000 default) | Same caching mechanism | Same pricing as non-reasoning — reasoning mode just consumes more output tokens | Open-weight (MIT) | Sep 2025 |
| **openai/gpt-oss-120b:free** | OpenRouter (free tier) | 117B total / 5.1B active MoE, native MXFP4 | 131,072 (128K) | 131,072 | Provider-dependent, not confirmed on free tier | $0 / — / $0 (free); paid tier $0.03–0.09 / — / $0.15–0.45 across providers | Apache 2.0 (open-weight) | Aug 5, 2025 |

**Notes on reading the table:**
- "Cached input" pricing is the **cache-hit** rate — what you pay when a request reuses a previously-cached prefix. Where I've written "—", no published cache-hit rate exists (either caching isn't supported, or no provider documents one).
- Pricing for OpenRouter-listed models is often the *median/cheapest host*, not a single fixed number — OpenRouter routes the same model across multiple third-party hosts, each with its own price and uptime. This is directly relevant to your "OpenRouter sucked" finding below.
- Max output ≠ context window. A model with a 1M context window doesn't necessarily let a single response run anywhere near that long — Gemini and DeepSeek both cap output well below their input ceiling.

---

## Provider access notes (Gemini API / OpenAI API / OpenRouter)

I can't run live calls against any of these from this environment — no network path to `generativelanguage.googleapis.com`, `api.openai.com`, or `openrouter.ai` from the sandbox I have access to. So the numbers below are *architectural facts from documentation*, not my own latency/uptime measurements. Don't cite this section as empirical testing — cite your own logs for that.

| Dimension | Gemini API (Google AI Studio / Vertex) | OpenAI API | OpenRouter |
|---|---|---|---|
| Hosting | Single first-party host | Single first-party host | Aggregates 1–20+ third-party hosts per model, routes per request |
| SLA / uptime | Google-managed, tiered by paid vs. free | OpenAI-managed | No SLA — uptime is "higher with N providers," meaning it's a weighted average across hosts of varying reliability |
| Pricing consistency | Fixed, published per model | Fixed, published per model | Fixed *per host* — the same model can have 3–5 different prices depending on which host serves your request |
| Free tier behavior | Rate-limited but stable identity (you know which model you're hitting) | No meaningful free tier for most models | Free (`:free`) variants are explicitly lower-priority/rate-limited and may silently fail over to a different (sometimes lower-quality) host |
| Why this matters for OWC | If you're benchmarking model *quality* for the pipeline, Gemini/OpenAI give you a stable target. If you're benchmarking via OpenRouter, you may unknowingly be testing different underlying infra run-to-run — which is the most likely root cause of "OpenRouter sucked." |

### Template — drop your own test results in here

| Model | Provider used | Avg latency (s) | p95 latency (s) | Error/timeout rate | Notes (host instability, throttling, etc.) |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |

If you still have your test logs/timestamps, it's worth checking which **host** OpenRouter routed you to per request (visible in response headers / OpenRouter dashboard activity log) — "OpenRouter sucked" is much stronger evidence in a report if you can show *which provider* it routed to and *why* that provider underperformed, rather than blaming OpenRouter as a single entity.

---

## Sources

- GLM-4.5-Air: https://openrouter.ai/z-ai/glm-4.5-air · https://artificialanalysis.ai/models/glm-4-5-air
- Gemini 2.5 Flash: https://openrouter.ai/google/gemini-2.5-flash · https://ai.google.dev/gemini-api/docs/pricing · https://inworld.ai/models/google-ai-studio-gemini-2-5-flash
- Gemini 2.5 Flash-Lite: https://openrouter.ai/google/gemini-2.5-flash-lite · https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite
- Gemini 3.1 Flash-Lite: https://deepmind.google/models/model-cards/gemini-3-1-flash-lite/ · https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-lite/ · https://openrouter.ai/google/gemini-3.1-flash-lite-preview
- Gemini 3.1 Flash Audio/Image (showing "3.1 Flash" doesn't exist standalone): https://deepmind.google/models/model-cards/gemini-3-1-flash-audio/ · https://deepmind.google/models/model-cards/gemini-3-1-flash-image/
- Gemini 3.5 Flash / Gemini 3 family context limits: https://deepmind.google/models/gemini/flash/ · https://ai.google.dev/gemini-api/docs/gemini-3
- Devstral 2 2512: https://mistral.ai/news/devstral-2-vibe-cli/ · https://huggingface.co/mistralai/Devstral-2-123B-Instruct-2512 · https://openrouter.ai/mistralai/devstral-2512
- GLM-4.7: https://openrouter.ai/z-ai/glm-4.7 · https://kilo.ai/models/z-ai-glm-4-7 · https://www.atlascloud.ai/models/zai-org/glm-4.7 · https://developer.puter.com/tutorials/zai-glm-api-pricing/
- Qwen3-Coder (free): https://openrouter.ai/qwen/qwen3-coder:free · https://openrouter.ai/qwen/qwen3-coder
- GPT-5.4 nano: https://developers.openai.com/api/docs/models/gpt-5.4-nano · https://openai.com/index/introducing-gpt-5-4-mini-and-nano/
- DeepSeek V3.2 / V4 migration: https://api-docs.deepseek.com/quick_start/pricing · https://api-docs.deepseek.com/guides/reasoning_model · https://openrouter.ai/deepseek/deepseek-v3.2 · https://www.datastudios.org/post/deepseek-context-window-maximum-token-limits-memory-retention-conversation-length-and-context-ha
- gpt-oss-120b (free): https://openrouter.ai/openai/gpt-oss-120b:free · https://developers.openai.com/api/docs/models/gpt-oss-120b
