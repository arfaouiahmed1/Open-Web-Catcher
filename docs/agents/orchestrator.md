# Orchestrator Agent

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Agents Index](./README.md) | Next: [Classification](./classification.md)

Source: `src/agents/orchestrator.py`

The orchestrator is the routing authority. It builds the LangGraph state machine, checks memory, calls classification, prepares handoffs, executes landing/hosting/embedded stages, runs provider analysis, generates takedown drafts, computes final status, and returns a `PipelineResult`.

## LangGraph Route

```mermaid
flowchart TD
  Start([START])
  Classify["classify"]
  QueueRootHosting["queue_root_hosting"]
  QueueRootEmbedded["queue_root_embedded"]
  Landing["landing_page"]
  Hosting["hosting_page"]
  Embedded["embedded_page"]
  Providers["analyze_providers"]
  Emails["generate_takedown_emails"]
  End([END])

  Start --> Classify
  Classify -->|"landing"| Landing
  Classify -->|"hosting"| QueueRootHosting
  Classify -->|"embedded"| QueueRootEmbedded
  Classify -->|"unknown/other"| Providers
  QueueRootHosting --> Hosting
  QueueRootEmbedded --> Embedded
  Landing -->|"hosting urls"| Hosting
  Landing -->|"embedded urls"| Embedded
  Landing -->|"none"| Providers
  Hosting -->|"more hosting urls"| Hosting
  Hosting -->|"embedded urls"| Embedded
  Hosting -->|"done"| Providers
  Embedded --> Providers
  Providers --> Emails --> End
```

## State Class Diagram

```mermaid
classDiagram
  class PipelineState {
    +str url
    +str run_id
    +ClassificationResult? classification
    +list~MatchInfo~ matches
    +list~ExtractionResult~ extraction_results
    +list~str~ pending_hosting_urls
    +list~str~ pending_embedded_urls
    +list~ProviderInfo~ provider_analysis
    +list~TakedownEmail~ takedown_emails
    +str error
  }

  class HandoffContext {
    +str root_url
    +str target_url
    +str page_type
    +str classification_reasoning
    +str route_source
    +str navigation_policy
    +list~str~ required_evidence
    +str memory_hints
    +str pattern_context
  }

  class OrchestratorAgent {
    +build_graph(settings, observer)
    +run(url) PipelineResult
  }

  OrchestratorAgent --> PipelineState
  OrchestratorAgent --> HandoffContext
```

## Handoff Preparation

```mermaid
flowchart TD
  Classification["ClassificationResult"]
  Memory["LongTermMemory hints"]
  LandingHandoff["_build_landing_handoff"]
  HostingHandoff["_build_hosting_handoff"]
  EmbeddedHandoff["_build_embedded_handoff"]
  Render["render_handoff(ctx)"]
  ChildPrompt["Specialist initial message"]

  Classification --> LandingHandoff
  Classification --> HostingHandoff
  Classification --> EmbeddedHandoff
  Memory --> LandingHandoff
  Memory --> HostingHandoff
  Memory --> EmbeddedHandoff
  LandingHandoff --> Render
  HostingHandoff --> Render
  EmbeddedHandoff --> Render
  Render --> ChildPrompt
```

## Provider And Email Skip Logic

```mermaid
flowchart LR
  Results["extraction_results"]
  Collect["_collect_all_streams"]
  HasStreams{"stream URLs found?"}
  Analyze["IPInfoTool._arun"]
  SkipProvider["emit Provider analysis skipped"]
  Email["EmailTool._arun"]
  SkipEmail["emit Takedown draft generation skipped"]

  Results --> Collect --> HasStreams
  HasStreams -->|"yes"| Analyze --> Email
  HasStreams -->|"no"| SkipProvider --> SkipEmail
```

## Final Status Calculation

```mermaid
flowchart TD
  Streams{"all_streams?"}
  Timeout{"any timeout?"}
  Inaccessible{"page inaccessible evidence?"}
  NoHosting{"landing exhausted/no hosting?"}
  NoStreams{"hosting/embedded no streams?"}
  Partial{"pending followups or nonfailed evidence?"}

  Streams -->|"yes"| Success["success"]
  Streams -->|"no"| Timeout
  Timeout -->|"yes"| TimeoutStatus["timeout"]
  Timeout -->|"no"| Inaccessible
  Inaccessible -->|"yes"| PageInaccessible["page_inaccessible"]
  Inaccessible -->|"no"| NoHosting
  NoHosting -->|"yes"| NoHostingStatus["no_hosting_pages"]
  NoHosting -->|"no"| NoStreams
  NoStreams -->|"yes"| NoStreamsStatus["no_streams"]
  NoStreams -->|"no"| Partial
  Partial -->|"yes"| PartialStatus["partial"]
  Partial -->|"no"| Failed["failed"]
```

