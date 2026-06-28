# Agent Sequence And Activity Diagrams In PlantUML

> **Navigation:** [Docs Home](../README.md) | [Agents](./README.md)

This page links the report-ready PlantUML source files for agent sequence and activity diagrams without storage participants.

## Scope

The diagrams cover the runtime behavior of each agent or downstream agent-like tool stage:

| Stage | Sequence diagram | Activity diagram |
| --- | --- | --- |
| Orchestrator | [`orchestrator_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/orchestrator_sequence_no_storage.puml) | [`orchestrator_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/orchestrator_activity_no_storage.puml) |
| Classification agent | [`classification_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/classification_sequence_no_storage.puml) | [`classification_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/classification_activity_no_storage.puml) |
| Landing-page agent | [`landing_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/landing_sequence_no_storage.puml) | [`landing_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/landing_activity_no_storage.puml) |
| Hosting-page agent | [`hosting_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/hosting_sequence_no_storage.puml) | [`hosting_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/hosting_activity_no_storage.puml) |
| Embedded-page agent | [`embedded_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/embedded_sequence_no_storage.puml) | [`embedded_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/embedded_activity_no_storage.puml) |
| Provider analysis tool | [`provider_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/provider_sequence_no_storage.puml) | [`provider_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/provider_activity_no_storage.puml) |
| Email generator tool | [`email_sequence_no_storage.puml`](../../Report/figures/plantuml/no-storage/email_sequence_no_storage.puml) | [`email_activity_no_storage.puml`](../../Report/figures/plantuml/no-storage/email_activity_no_storage.puml) |

## Storage Exclusion Rule

These diagrams intentionally omit storage, repository, database, and persistence lifelines. The objective is to show agent-to-agent routing, prompt compilation, browser-tool usage, typed extraction outputs, provider enrichment, and draft generation without mixing in review-table persistence.

Storage-backed reviewability remains documented separately in the system and workflow documentation.

## Source Grounding

The diagrams are grounded in:

- `src/agents/orchestrator.py`
- `src/agents/classification.py`
- `src/agents/landing_page.py`
- `src/agents/hosting_page.py`
- `src/agents/embedded_page.py`
- `src/tools/ipinfo_tool.py`
- `src/tools/email_tool.py`
- `src/agents/email_generator.py`
- `docs/agents/*.md`
- `Report/chapters/04-architecture.tex`

## Rendering

Use any PlantUML renderer on the individual `.puml` files in `Report/figures/plantuml/no-storage/`. Each file contains exactly one `@startuml` block and one `@enduml` block so the report toolchain can render one image per diagram.

## Additional Architecture PlantUML

These PlantUML files complement the per-agent sequence/activity files:

- Figure 4.7 shared browser-agent activity loop: [`fig-04-07-shared-browser-agent-activity-loop.puml`](../../Report/figures/plantuml/architecture/fig-04-07-shared-browser-agent-activity-loop.puml)
- Agent JSON communication contracts: [`agent-json-communication.puml`](../../Report/figures/plantuml/architecture/agent-json-communication.puml)
- Orchestrator-centered specialist routing activity: [`orchestrator-agent-specialist-routing-activity.puml`](../../Report/figures/plantuml/architecture/orchestrator-agent-specialist-routing-activity.puml)
- Tool families component diagram: [`tool-families-component.puml`](../../Report/figures/plantuml/architecture/tool-families-component.puml), [`PNG`](../../Report/figures/plantuml/architecture/tool-families-component.png)
- Tool-call lifecycle sequence diagram: [`tool-call-lifecycle-sequence.puml`](../../Report/figures/plantuml/architecture/tool-call-lifecycle-sequence.puml), [`PNG`](../../Report/figures/plantuml/architecture/tool-call-lifecycle-sequence.png)
- Agent JSON communication component diagram: [`agent-json-communication-component.puml`](../../Report/figures/plantuml/architecture/agent-json-communication-component.puml), [`PNG`](../../Report/figures/plantuml/architecture/agent-json-communication-component.png)
