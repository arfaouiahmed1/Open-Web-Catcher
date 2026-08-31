# Provider Directory And BYOK

> **Navigation:** [Docs Home](../README.md) | [Operations Index](./README.md) | Previous: [Configuration](./configuration.md) | Next: [Validation](./validation.md)

The operator console treats provider configuration as a Settings-owned BYOK workflow. Provider
credentials are entered in **Settings → Provider Keys**, persisted as runtime overrides, and
never returned in plaintext by the UI API.

## Sources And Scope

The directory is based on the provider families documented by:

- [MLflow AI Gateway model providers](https://mlflow.org/docs/latest/genai/governance/ai-gateway/endpoints/model-providers/)
- [LiteLLM providers](https://docs.litellm.ai/docs/providers)
- [OpenCode Zen](https://opencode.ai/docs/zen/)
- [OpenCode Go](https://opencode.ai/docs/go/)

The implementation currently exposes **110 provider IDs** in
`src/utils/provider_models.py` and `web/components/console/settings/settings-page.tsx`. The
backend and frontend are checked to keep the IDs aligned. The directory includes direct
adapters, LiteLLM provider IDs, gateways, OpenAI-compatible endpoints, cloud runtimes, and local
model servers.

## Directory Groups

| Group | Representative providers | Configuration behavior |
| --- | --- | --- |
| Frontier | Google Gemini, OpenAI, Anthropic, xAI, DeepSeek, Z.AI, MiniMax | Provider key plus provider-specific or standard catalog adapter |
| Speed | Groq, Cerebras, NVIDIA NIM, SambaNova, Together AI, Fireworks AI, Nebius | Provider key; most expose an OpenAI-compatible models endpoint |
| Open | Mistral, Cohere, Perplexity, Codestral, Replicate, Hugging Face, Chutes | Provider key; model catalog is live when the provider exposes `/models` |
| Cloud / Enterprise | Azure OpenAI, AWS Bedrock, Vertex AI, Databricks, Snowflake, watsonx, SageMaker, Cloudflare | Provider key and, where required, a workspace, region, or endpoint URL |
| Gateway | OpenRouter, OpenCode Zen, OpenCode Go, LiteLLM, Portkey, Vercel AI Gateway, Helicone, CometAPI | Gateway key and the registry endpoint; custom gateways can override the base URL |
| Local | Ollama, LM Studio, vLLM, Hosted vLLM, Llamafile, Xinference, Docker Model Runner, Lemonade | Usually a local or self-hosted base URL; authentication is optional for local servers |

The UI also includes additional LiteLLM-compatible and regional providers such as Nscale,
OVHcloud, Scaleway, Lambda AI, Volcano Engine, DashScope, ModelScope, Tencent, Jina AI,
Apertis, Bytez, DataRobot, Predibase, fal.ai, Stability AI, and other directory IDs.

## OpenCode

OpenCode is represented as two gateway entries rather than as a new SDK integration:

| Entry | Models endpoint | Runtime transport |
| --- | --- | --- |
| OpenCode Zen | `https://opencode.ai/zen/v1/models` | OpenAI-compatible LiteLLM transport; model families are routed to the compatible family prefix |
| OpenCode Go | `https://opencode.ai/zen/go/v1/models` | OpenAI-compatible LiteLLM transport |

OpenCode documents different request endpoints for different model families. The runtime keeps
agent call sites on one LiteLLM seam and applies family routing for OpenCode model IDs: GPT and
OpenAI-compatible models use the OpenAI prefix, Claude models use the Anthropic prefix, and
Gemini models use the Gemini prefix. The live `/models` catalog remains the authority for the
currently available OpenCode models.

OpenCode Zen and Go keys are optional to the application, but required for live catalog access.
Enter them in their respective Provider Keys rows; do not put them in source files, Docker build
arguments, or committed configuration.

## LiteLLM And OpenAI-Compatible Gateways

LiteLLM remains the single runtime seam. The directory adds two gateway modes:

- **LiteLLM Gateway / Proxy** defaults to `http://localhost:4000/v1` and is intended for a
  separately running LiteLLM proxy.
- **Custom OpenAI-compatible** and **OpenAI-compatible** entries accept a base URL in the
  Provider Keys row. The backend calls `<base-url>/models` and returns normalized model rows.

For providers without a dedicated adapter, the backend uses this generic contract:

```text
GET <provider-base-url>/models
Authorization: Bearer <provider-key>   # only when a key is configured
```

Responses may use either OpenAI's `data[].id` shape or a simple `models[]` list. The UI falls
back to saved catalog rows or a curated model list when a live endpoint is unavailable.

## Settings API Contract

`GET /ui/config` returns safe directory metadata:

- `api_keys`: boolean configured-state map for every provider ID;
- `provider_registry`: provider ID, display name, key label, and default base URL;
- `provider_base_urls`: configured endpoint overrides;
- `settings_sources`: source metadata with provider key values masked.

It does **not** return the `provider_api_keys` map. `PUT /ui/config` accepts these Settings-owned
maps:

```json
{
  "provider_api_keys": {
    "opencode": "<operator-entered-value>"
  },
  "provider_base_urls": {
    "custom-openai": "https://gateway.example/v1"
  }
}
```

An empty value clears the selected runtime entry. Runtime YAML persistence is handled by
`Settings.save_yaml()` and writes to `data/settings.runtime.yaml`; local runtime artifacts must
not be committed.

## Model Assignment UX

**Settings → Models** assigns a provider and model independently for Classification, Landing,
Hosting, Embedded, and Orchestrator. Both provider and model menus are searchable. Each
assignment also supports a manual model ID for providers whose catalog is private, unavailable,
or workspace-specific.

When a selected provider has no configured key, the UI explains that live catalog access is
unavailable and links back to Provider Keys. Saved/fallback catalog rows remain usable for
reviewing or entering a model selection, but they are not presented as live verification.

## Verification Checklist

1. Open **Settings → Provider Keys**.
2. Search for `OpenCode`, `LiteLLM`, `Ollama`, or a provider name.
3. Enter the provider key in the matching row and add a base URL only when the provider requires
   a custom endpoint.
4. Select **Test**. Draft values are saved before the catalog request is made.
5. Open **Settings → Models**, search the provider menu, and assign a model to the target agent.
6. Confirm `GET /ui/config` exposes the provider as configured but does not expose the raw key.

Relevant implementation files:

- `src/utils/provider_models.py` — registry, fallback catalogs, endpoint resolution, and model normalization;
- `src/utils/config.py` — Settings-owned dynamic maps and runtime YAML persistence;
- `src/api/provider_config.py` — safe UI payload and update contract;
- `src/api/app.py` — nested provider-key masking;
- `web/components/console/settings/settings-page.tsx` — directory, Provider Keys, and Models UX;
- `web/components/ui/select.tsx` — searchable provider/model selector.
