# LangChain And LangGraph Runtime

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [System Architecture](./architecture.md) | Next: [Runtime Classes And Functions](./runtime-classes-functions.md)

This system uses LangChain for model/tool abstractions and LangGraph for deterministic agent control flow. The distinction matters: LangChain provides messages, tool binding, and the Gemini chat model wrapper; LangGraph provides explicit state machines for the agent loop and the orchestrator route; the application code owns the domain policy.

The result is not a single unconstrained chatbot. It is a controlled workflow where LLM calls are one step inside a larger graph.

## Why This Fits This Project

Streaming-site extraction has several properties that make a graph-based runtime useful. The page type is not known until a browser checks the live page. Different page types need different tool profiles and different prompts. Browser state can drift because of ads, redirects, iframes, and server switches. A useful run is also not just a final answer; it needs screenshots, stream URLs, provider rows, model usage, tool history, and a replayable event log.

LangGraph keeps those decisions explicit. The model can propose tool calls and produce structured JSON, but the graph decides the next node and the backend records every step.

## Current Source Map

| Concern | Current source |
| --- | --- |
| Gemini model construction | `src/agents/base.py::build_llm` |
| Tool-calling loop | `src/agents/base.py::run_agent_loop` |
| Agent loop state | `src/agents/base.py::AgentGraphState` |
| Tool/result wrapper | `src/agents/base.py::AgentLoopResult` |
| Orchestrator graph | `src/agents/orchestrator.py::build_graph` |
| Orchestrator state | `src/agents/orchestrator.py::PipelineState` |
| Handoff text | `src/agents/orchestrator.py::render_handoff` |
| Runtime events and metrics | `src/utils/observability.py` |
| Prompt layering | `src/agents/prompting.py` |
| Gemini/tool caches | `src/agents/cache.py` |

## Which Agents Use LangChain And LangGraph

All LLM-facing browser agents use LangChain abstractions. `src/agents/base.py` builds `ChatGoogleGenerativeAI`, exchanges LangChain `SystemMessage`, `HumanMessage`, `AIMessage`, and `ToolMessage` objects, and invokes LangChain `BaseTool` instances loaded from MCP adapters.

LangGraph is used in two layers:

| Runtime piece | Uses LangChain | Uses LangGraph | How |
| --- | --- | --- | --- |
| `OrchestratorAgent` | No direct model loop | Yes | Owns the pipeline `StateGraph` in `src/agents/orchestrator.py::build_graph`. |
| `ClassificationAgent` | Yes | Yes, through `run_agent_loop` | Uses Gemini + browser tools, then the shared agent-loop graph controls model/tool turns. |
| `LandingPageAgent` | Yes | Yes, through `run_agent_loop` | Same shared graph, with landing prompt, landing MCP profile, and landing short-memory state. |
| `HostingPageAgent` | Yes | Yes, through `run_agent_loop` | Same shared graph, with hosting prompt, hosting MCP profile, and server/player state. |
| `EmbeddedPageAgent` | Yes | Yes, through `run_agent_loop` | Same shared graph, with embedded prompt, embedded MCP profile, and iframe/player state. |
| `IPInfoTool` | Yes | No standalone graph | It is a LangChain `BaseTool` called from an orchestrator node after stream extraction. |
| `EmailTool` / `generate_takedown_emails` | Yes at tool wrapper, deterministic Python inside | No standalone graph | The tool wrapper is LangChain; email grouping/content generation is deterministic code. |

So the short version is: every specialist browser agent uses LangChain, and the orchestrator plus the four browser-facing specialists use LangGraph. Provider analysis and email generation are downstream LangChain tools/nodes, not independent LangGraph agents.

## Context Continuation

`run_agent_loop` monitors context usage from every `llm_response`. For landing, hosting, and embedded profiles, if `input_tokens + output_tokens` reaches `settings.context_continuation_threshold` (default `0.8`) and the model still requested tools, the graph routes through `compact_context` before the next model turn. Classification is excluded by `runtime_profile == classification`.

The compaction node emits visible runtime events:

- `context_compaction_started`
- `agent_finished` with `stop_reason=context_compacted`
- `agent_started` for the continuation invocation
- `context_compaction_finished`

Persistence sees those `agent_finished` and `agent_started` events as separate `agent_runs` rows for the same actor with a higher `invocation_index`. The continuation capsule is stored in event details and in `AgentLoopResult.continuation_capsules`, then copied into specialist output under `agent_run.continuation_capsules`.

The capsule is deterministic and intentionally compact. It preserves objective, target URL, page type, actor, continuation index, context usage, used/remaining tool budget, visited URLs, confirmed URL and pagination patterns, pending landing frontier, server evidence, screenshots, streams, blockers, and `next_best_move`. It is inserted as a new human message with the original system prompt and original task so the next invocation can continue from the current frontier instead of restarting.

Context-window metadata is logged across the whole lifecycle. `agent_loop_started`,
model retry, timeout, rate-limit, and error events include provider/model and
`context_window`. Successful `llm_response` events additionally include
`context_tokens` and `context_usage_pct`. The compaction events repeat
`context_window`, `context_tokens`, `context_usage_pct`, and the continuation
capsule so persistence and the Agent desk can explain why continuation happened.
If a tool turn both crosses the threshold and exhausts the budget, compaction
runs before the budget-exhausted final-answer path so the final answer request
does not carry the oversized history.

## Layered Runtime Diagram

```mermaid
flowchart TB
  subgraph Product["Product workflow"]
    Console["Next.js console"]
    API["FastAPI routes"]
    Jobs["background_jobs table + worker loop"]
    RunDetail["Run detail dashboard"]
  end

  subgraph Graphs["LangGraph control"]
    OrchestratorGraph["orchestrator StateGraph<br/>classification -> routing -> extraction -> provider -> email"]
    AgentGraph["agent loop StateGraph<br/>model turn -> tool calls -> stop checks"]
  end

  subgraph LangChain["LangChain interfaces"]
    Messages["System/Human/AI/Tool messages"]
    Tools["BaseTool list from MCP adapters"]
    Gemini["ChatGoogleGenerativeAI<br/>streaming + bound tools"]
  end

  subgraph Domain["Domain contracts"]
    Prompts["layered prompts<br/>base policy + contract + task brief + memory"]
    Schemas["Pydantic outputs<br/>PipelineResult, ExtractionResult, ProviderInfo"]
    Observer["RunObserver<br/>events + metrics"]
    Storage["SQLAlchemy persistence"]
  end

  Console --> API --> Jobs --> OrchestratorGraph
  OrchestratorGraph --> AgentGraph
  AgentGraph --> Messages
  AgentGraph --> Tools
  AgentGraph --> Gemini
  AgentGraph --> Prompts
  AgentGraph --> Observer
  OrchestratorGraph --> Schemas
  Observer --> Storage
  Storage --> RunDetail
```

## Agent Loop Mechanics

Each browser-facing specialist agent follows the same broad pattern:

1. Build a `LongTermMemory` client when memory is enabled.
2. Create `ShortTermMemory` for this run.
3. Compile a layered prompt from the base prompt file, agent contract, task brief, memory context, working state, and runtime context.
4. Open profile-scoped MCP tools with `agent_tools(profile, settings, observer=observer)`.
5. Run `run_agent_loop` with the Gemini model, tools, max tool-call budget, bootstrap behavior, and runtime profile.
6. Parse the final model text into JSON using `AgentLoopResult.parse_json`.
7. Normalize the output into Pydantic schemas.
8. Remember the run and emit `agent_finished`.

The bootstrap behavior is important. Most agents can start by calling memory lookup and navigation before the first normal model turn. That puts real page evidence into the conversation and prevents the model from deciding from URL shape alone.

```mermaid
sequenceDiagram
  participant A as Specialist agent
  participant P as compile_agent_prompt
  participant M as LongTermMemory
  participant MCP as agent_tools(profile)
  participant AgentLoop as run_agent_loop
  participant LLM as Gemini
  participant T as Browser tool
  participant O as RunObserver

  A->>M: build_memory_context(url, page_type)
  M-->>A: prior hints or empty context
  A->>P: base policy + contract + task + memory + runtime
  P-->>A: compiled prompt + cache metadata
  A->>O: prompt_compiled
  A->>MCP: open profile session
  A->>AgentLoop: settings, llm, tools, prompt, bootstrap flags
  AgentLoop->>T: bootstrap memory_lookup when available
  AgentLoop->>T: bootstrap navigate/open_url
  AgentLoop->>T: bootstrap inspect/get_page_context
  loop model and tool turns
    AgentLoop->>LLM: messages + bound tools
    LLM-->>AgentLoop: AIMessage with tool calls or final text
    AgentLoop->>O: llm_response and usage metrics
    opt requested tool call
      AgentLoop->>T: invoke tool with timeout
      T-->>AgentLoop: serialized tool result
      AgentLoop->>O: tool_call_finished
    end
  end
  AgentLoop-->>A: AgentLoopResult
  A->>A: parse and normalize result
  A->>O: agent_finished
```

## Agent Loop State

`AgentGraphState` is intentionally small. It tracks the conversation, budget, repeated tool batches, and no-progress count. More durable state lives outside the graph in `RunObserver`, `ShortTermMemory`, and Postgres.

```mermaid
classDiagram
  class AgentGraphState {
    +list messages
    +int tool_calls_made
    +int max_tool_calls
    +bool budget_exhausted
    +str stop_reason
    +str last_tool_batch_signature
    +int repeated_tool_batch_count
    +int no_progress_turn_count
    +bool context_compaction_pending
    +float context_usage_pct
    +int last_context_tokens
    +int continuation_index
    +list continuation_capsules
  }

  class AgentLoopResult {
    +str final_text
    +int tool_calls_made
    +int bootstrap_tool_calls
    +int llm_tool_calls_made
    +list messages
    +str stop_reason
    +bool budget_exhausted
    +str parse_error
    +int continuation_count
    +list continuation_capsules
    +parse_json() dict
  }

  class ToolResultCache {
    +int hits
    +int misses
    +int bypasses
    +int writes
    +int invalidations
    +is_eligible(tool_name) bool
    +get(tool_name, args) tuple
    +put(tool_name, args, result) str
    +invalidate(reason) void
  }

  AgentGraphState --> AgentLoopResult
  AgentGraphState --> ToolResultCache
```

The graph state is not the full run. It is the control envelope for one specialist loop. The heavy data stays in messages, runtime events, short memory, and persisted result rows.

```mermaid
flowchart TB
  State["AgentGraphState"]
  Messages["messages<br/>System + Human + AI + Tool"]
  Budget["tool budget<br/>tool_calls_made / max_tool_calls"]
  LoopGuards["loop guards<br/>repeated batch + no progress"]
  Context["context pressure<br/>usage pct + last token count"]
  Continuation["continuation<br/>index + capsules"]
  QueryGuard["query specificity guard<br/>repeated broad reads"]

  State --> Messages
  State --> Budget
  State --> LoopGuards
  State --> Context
  State --> Continuation
  State --> QueryGuard

  Messages --> ModelTurn["llm node"]
  ModelTurn --> ToolTurn["tools node"]
  ToolTurn --> State
  Context --> Compact["compact_context node"]
  Budget --> Final["budget_exhausted node"]
  LoopGuards --> Final
```

`PipelineState` is the orchestrator-level state. It carries the run URL, classification result, discovered matches, extraction results, pending hosting targets, pending embedded targets, provider analysis rows, takedown drafts, and an error string. The orchestrator graph mutates those lists as each stage completes.

```mermaid
stateDiagram-v2
  [*] --> Classify
  Classify --> LandingPage: page_type=landing
  Classify --> QueueRootHosting: page_type=hosting
  Classify --> QueueRootEmbedded: page_type=embedded
  Classify --> AnalyzeProviders: unknown or unsupported
  QueueRootHosting --> HostingPage
  QueueRootEmbedded --> EmbeddedPage
  LandingPage --> HostingPage: pending_hosting_urls
  LandingPage --> EmbeddedPage: pending_embedded_urls
  LandingPage --> AnalyzeProviders: no downstream targets
  HostingPage --> HostingPage: more pending_hosting_urls
  HostingPage --> EmbeddedPage: pending_embedded_urls
  HostingPage --> AnalyzeProviders: streams or no more targets
  EmbeddedPage --> AnalyzeProviders
  AnalyzeProviders --> GenerateTakedownEmails
  GenerateTakedownEmails --> [*]
```

## Stop Conditions

The loop is not allowed to run forever. The current runtime checks `max_tool_calls`, `agent_timeout_seconds`, `llm_turn_timeout_seconds`, `tool_timeout_seconds`, repeated identical tool batches, no-progress turns, user cancellation, and bounded provider retries.

These checks are logged as events so the dashboard can show the difference between a genuine extraction failure, a tool timeout, a cancelled run, and a model/provider problem.

```mermaid
stateDiagram-v2
  [*] --> Bootstrap
  Bootstrap --> ModelTurn
  ModelTurn --> ToolTurn: model requested tools
  ModelTurn --> FinalParse: model returned final text
  ToolTurn --> ModelTurn: result appended
  ToolTurn --> BudgetExhausted: max_tool_calls reached
  ToolTurn --> NoProgress: repeated/no-progress limit reached
  ModelTurn --> RetryDelay: retryable LLM error
  RetryDelay --> ModelTurn: attempts remain
  ModelTurn --> Failed: fatal model error
  Bootstrap --> Cancelled: cancel requested
  ModelTurn --> Cancelled: cancel requested
  ToolTurn --> Cancelled: cancel requested
  BudgetExhausted --> FinalParse
  NoProgress --> FinalParse
  FinalParse --> [*]
  Failed --> [*]
  Cancelled --> [*]
```

## Prompt And Memory Compilation

Prompt compilation exists because the same base runtime rules must be combined with agent-specific behavior. Classification is not allowed to extract downstream streams, while hosting is expected to activate players and collect server-level evidence.

```mermaid
flowchart LR
  Base["base prompt file<br/>configs/prompts/*_v1.md"]
  Contract["agent contract<br/>hard stage duties"]
  Task["task brief<br/>URL + run goal + extras"]
  Memory["memory context<br/>soft domain hints"]
  Working["short-term working state<br/>objective + recent observations"]
  Runtime["runtime context<br/>tool profile + budget"]
  Compiled["Compiled prompt<br/>content + metadata"]

  Base --> Compiled
  Contract --> Compiled
  Task --> Compiled
  Memory --> Compiled
  Working --> Compiled
  Runtime --> Compiled
```

`compile_agent_prompt` normalizes six inputs and returns both the final prompt text and metadata. The static prefix is `BASE POLICY`, `AGENT CONTRACT`, and `RUNTIME CONTEXT`; that prefix is cached in-process and can be marked provider-cache eligible. The dynamic part is `TASK BRIEF`, `SITE MEMORY HINTS`, and `WORKING STATE`, because these change by URL, domain history, and current run state.

The compiled metadata is recorded in `prompt_compiled` events and persisted through `prompt_versions` and `prompt_compilations`. That is why the dashboard can answer which prompt hash ran, whether memory was injected, what sections were present, whether the static prefix hit the app cache, and whether provider caching was eligible.

Example compiled shape:

```text
BASE POLICY
<contents of configs/prompts/hosting_page_v1.md or prompt override>

AGENT CONTRACT
<stage duties, output contract, evidence rules>

RUNTIME CONTEXT
- tool profile: `hosting`
- tool-call budget: `24`
- rely on live page evidence and tool results, not assumptions

TASK BRIEF
- target url: `https://example.test/watch/team-a-vs-team-b`
- page type: `hosting_page`
- run goal: extract working stream URLs and player evidence

SITE MEMORY HINTS
SITE MEMORY PLAYBOOK
Use as hints only; re-verify on the live page.
- scope: `example.test` `hosting_page`; remembered `3` runs, `2` successes
- steps: `open_url` -> `inspect_player` -> `click_server` -> `harvest_network`

WORKING STATE
- current objective: activate same-event servers and capture stream evidence
- steps already tried: `open_url`, `inspect_player`
- server snapshots remembered: `2`
- next best move: inspect or activate the next untried same-content server
```

## Short Memory

Short memory is run-local. `ShortTermMemory` records recent navigation, tool calls, selectors/clicks, observations, URL patterns, critical links, iframes, stream URLs, landing candidates, live counters, server records, screenshots, activated servers, and per-server stream URLs. It is not generic chat history; it is a compact extraction ledger.

The current state is compiled into the prompt before model turns through `turn_context_provider=lambda _state: short_memory.working_state(...)`. This keeps the model aware of what has already been tried without making it reread the whole transcript.

```mermaid
flowchart TB
  Tools["tool result<br/>inspect, click, harvest, screenshot"]
  Short["ShortTermMemory<br/>run-local ledger"]
  Signals["signals<br/>selectors, links, candidates, streams, servers"]
  Working["working_state()<br/>small current-state prompt"]
  AgentLoop["run_agent_loop<br/>next LLM turn"]
  Export["export_run_memory()<br/>structured run memory"]
  Long["remember_agent_run<br/>long memory input"]

  Tools --> Short
  Short --> Signals
  Short --> Working --> AgentLoop
  Short --> Export --> Long
```

Example short-memory working state:

```text
- current objective: discover hosting pages from the landing page
- current page type: `landing_page`
- current target url: `https://example.test/live`
- steps already tried: `open_url`, `inspect_landing`, `click Live`
- blockers seen: `popup_overlay`
- detected run url patterns: `https://example.test/watch/{id}`, `/live?page={n}`
- critical links discovered this run: `https://example.test/watch/abc123`
- landing hosting candidates remembered: `8`
- visible live counters: `live_matches=12`
- next best move: open a representative hosting candidate and verify same-event focus
```

## Long Memory

Long memory is cross-run site memory. `LongTermMemory` writes compact entries into a dedicated `data/site_memory.db` SQLite database and maintains profile-style summaries in `data/site_memory_profiles.json` for fast agent retrieval. The main relational database (PostgreSQL/SQLite) mirrors these outputs into the `memory_entries` and `memory_hints_used` tables for dashboard observability and database views. The agent-facing prompt lookup strictly reads from the dedicated `LongTermMemory` helper.

Long memory is deliberately summarized. `build_site_memory_entry` compiles trace events, output payloads, and exported short memory into bounded arrays: tool sequence, tool steps, navigation targets, selectors, URL patterns, pagination patterns, critical links, server labels, stream hosts, hosting candidate URLs, server records, server screenshots, server stream URLs, activated servers, rejected patterns, failure cues, pagination rules, landing match URLs, continuation notes, and a short-memory summary. `LongTermMemory.build_prompt_context` then turns recent entries and profile data into a concise `SITE MEMORY PLAYBOOK`.

```mermaid
flowchart LR
  RunTrace["RunTrace events"]
  Output["agent output payload"]
  ShortExport["short memory export"]
  Entry["build_site_memory_entry<br/>bounded playbook fields"]
  SQLite[("site_memory_entries<br/>data/site_memory.db")]
  Profile["site profile<br/>profiles json"]
  PromptContext["build_prompt_context()<br/>SITE MEMORY PLAYBOOK"]
  Prompt["compile_agent_prompt<br/>SITE MEMORY HINTS"]

  RunTrace --> Entry
  Output --> Entry
  ShortExport --> Entry
  Entry --> SQLite
  Entry --> Profile
  SQLite --> PromptContext
  Profile --> PromptContext
  PromptContext --> Prompt
```

Example long-memory playbook:

```text
SITE MEMORY PLAYBOOK
Use as hints only; re-verify on the live page.
- scope: `example.test` `landing_page`; remembered `5` runs, `3` successes
- steps: `open_url` -> `inspect_landing` -> `click text=Live` -> `inspect_landing`
- selectors/clicks: `text=Live`, `selector=.match-card a`, `xpath=//a[contains(@href,'watch')]`
- route patterns: `https://example.test/watch/{id}`, `https://example.test/live?page={n}`
- pagination: `https://example.test/live?page={n}`
- critical links: `https://example.test/watch/abc123`, `https://example.test/watch/def456`
- failure cues: `popup_overlay`, `redirect_to_home`
```

## Why Not Let The LLM Route Everything

The system still uses an LLM for page understanding, but routing is mostly deterministic because the consequences of a bad route are expensive. A host page sent to an embedded agent may miss server controls. A landing page sent directly to provider analysis has no streams. A broken page should not trigger email generation. Keeping graph routes explicit makes failures explainable in the dashboard.

The model is best used for the parts where static code is brittle: reading messy DOM context, interpreting page intent, deciding which visible control to inspect next, and summarizing evidence. The graph is better for lifecycle control, persistence, cancellation, retries, and deciding which specialist owns the next stage.
