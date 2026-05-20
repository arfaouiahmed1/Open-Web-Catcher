# Email Generator

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Provider Analysis](./provider-analysis.md) | Next: [API Index](../api/README.md)

Sources: `src/tools/email_tool.py`, `src/agents/email_generator.py`

Email generation is a draft-only evidence packaging stage. Emails are not sent. The generator groups provider rows by channel, provider, and abuse contact, then attaches stream URLs, screenshots, server labels, provider info, and per-stream evidence.

## Email Generation Sequence

```mermaid
sequenceDiagram
  participant Orchestrator
  participant Tool as EmailTool
  participant Generator as generate_takedown_emails
  participant Evidence as _collect_stream_evidence
  participant Channel as channel_detection helpers
  participant Email as TakedownEmail[]

  Orchestrator->>Tool: infringing_url, provider_analysis, extraction_results
  Tool->>Generator: deserialize ProviderInfo and ExtractionResult
  Generator->>Evidence: collect stream/screenshot/server/channel evidence
  Generator->>Channel: normalize and infer channel names
  Generator->>Generator: group by channel + provider + contact
  Generator-->>Tool: TakedownEmail objects
  Tool-->>Orchestrator: JSON email drafts
```

## Evidence Packaging

```mermaid
flowchart TD
  Extractions["ExtractionResult[]"]
  Providers["ProviderInfo[]"]
  StreamEvidence["StreamEvidence per stream URL"]
  Grouping["group by channel_name + provider_name + abuse contact"]
  Subject["DMCA subject"]
  Body["DMCA body with URLs and screenshots"]
  Email["TakedownEmail"]

  Extractions --> StreamEvidence
  Providers --> Grouping
  StreamEvidence --> Grouping
  Grouping --> Subject
  Grouping --> Body
  Subject --> Email
  Body --> Email
```

## Email Class Diagram

```mermaid
classDiagram
  class EmailTool {
    +name generate_takedown_emails
    +_run(infringing_url, provider_analysis, extraction_results) str
    +_arun(infringing_url, provider_analysis, extraction_results) Any
  }

  class TakedownEmail {
    +provider
    +abuse_email
    +channel_name
    +subject
    +body
    +infringing_url
    +stream_urls
    +screenshot_urls
    +server_labels
    +stream_evidence
    +provider_info
    +rights_owner_reference_url
  }

  class StreamEvidence {
    +stream_url
    +protocol
    +source_layer
    +server_label
    +channel_name
    +screenshot_urls
    +page_url
    +provider_hostname
    +ocr_text
  }

  EmailTool --> TakedownEmail
  TakedownEmail --> StreamEvidence
```

