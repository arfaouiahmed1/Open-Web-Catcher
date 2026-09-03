# Configuration

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Docker And Ports](./docker.md) | Next: [Validation](./validation.md)

Configuration is layered. Service/bootstrap secrets belong in `.env`; model provider credentials
are entered through **Settings → Provider Keys** and persisted as runtime overrides. Non-secret
defaults live in `configs/settings.yaml`; runtime changes can also be written through `/ui/config`
and related runtime files in `data/`.

## Config Flow

```mermaid
flowchart LR
  Env[".env<br/>secrets and service URLs"]
  SettingsYaml["configs/settings.yaml<br/>runtime defaults"]
  RuntimeYaml["data/settings.runtime.yaml<br/>operator overrides"]
  BrowserRuntime["data/browser.runtime.json<br/>tool runtime bridge"]
  ApiConfig["GET/PUT /ui/config"]
  ProviderModels["GET /ui/providers/models?provider=<id>"]
  Pricing["/ui/pricing and /ui/pricing/sync"]
  Agents["Agent runtime"]
  Tools["Browser tools"]

  Env --> Agents
  SettingsYaml --> ApiConfig
  RuntimeYaml --> ApiConfig
  ProviderModels --> ApiConfig
  Pricing --> ApiConfig
  ApiConfig --> Agents
  ApiConfig --> BrowserRuntime --> Tools
```

## Important Config Areas

| Area | Current behavior |
| --- | --- |
| Provider | 110-provider LiteLLM-compatible directory, including OpenCode, gateways, cloud, and local runtimes |
| Provider keys | Settings-owned `provider_api_keys` map; values are masked in UI responses |
| Provider endpoints | Settings-owned `provider_base_urls` map for custom or workspace-specific endpoints |
| Models | provider/model assignments exposed in Settings and the backend config payload |
| Thinking | gated by model compatibility in backend runtime profile |
| Cache | prompt/static cache, provider cache eligibility, tool-result cache |
| Browser | Puppeteer/Playwright runtime bridge, streaming-safe policy, proxy/fingerprint/tool controls |
| Pricing | input, output, cached input, and cache write costs tracked separately |

## Provider Credential Storage

Use **Settings → Provider Keys** for model credentials. The UI sends a partial `PUT /ui/config`
update and the backend persists provider values to `data/settings.runtime.yaml` through
`Settings.save_yaml()`.

- `provider_api_keys` stores extensible provider IDs, including `opencode`, `opencode-go`,
  `litellm`, `ollama`, and `custom-openai`.
- `provider_base_urls` stores endpoint overrides. The UI shows the endpoint field for providers
  without a registry default and for providers with an existing override.
- Blank values remove runtime entries.
- `GET /ui/config` returns `api_keys` as booleans, not raw credentials. Nested provider key maps
  in `settings_sources` are masked.
- Provider keys must not be committed, placed in Docker build arguments, or copied into logs or
  screenshots.

## Provider Model Catalogs

`GET /ui/providers/models?provider=<id>` uses a direct adapter for providers with specialized
APIs. Other providers use the normalized OpenAI-compatible contract:

```text
GET <base-url>/models
Authorization: Bearer <key>   # when the provider requires authentication
```

The response may expose OpenAI-style `data[].id` rows or a simple `models[]` list. If the live
endpoint is unavailable, saved catalog rows or curated fallback models are returned with a
non-live source marker. See [Provider Directory](./provider-directory.md) for the full setup
matrix.
