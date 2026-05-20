# Provider Analysis

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Embedded](./embedded.md) | Next: [Email Generator](./email-generator.md)

Sources: `src/tools/ipinfo_tool.py`, `src/utils/ipinfo.py`

Provider analysis runs after the orchestrator has collected provider-like stream URLs. It resolves IP, hostname, organization, cleaned provider name, country/region/city, abuse email, and RDAP/Whois evidence.

## Provider Flow

```mermaid
sequenceDiagram
  participant Orchestrator
  participant Filter as _collect_all_streams
  participant Tool as IPInfoTool
  participant Lookup as lookup_multiple
  participant RDAP as RDAP/Whois
  participant Result as ProviderInfo[]

  Orchestrator->>Filter: extraction_results
  Filter-->>Orchestrator: stream URLs
  alt no stream URLs
    Orchestrator-->>Orchestrator: emit Provider analysis skipped
  else stream URLs exist
    Orchestrator->>Tool: _arun(stream_urls)
    Tool->>Lookup: resolve host/IP/provider
    Lookup->>RDAP: abuse contact enrichment
    RDAP-->>Lookup: whois_raw + abuse email
    Lookup-->>Tool: ProviderInfo rows
    Tool-->>Orchestrator: JSON provider rows
  end
```

## ProviderInfo Class

```mermaid
classDiagram
  class ProviderInfo {
    +str stream_url
    +str ip
    +str hostname
    +str org
    +str provider
    +str country
    +str region
    +str city
    +str abuse_email
    +str whois_raw
  }
```

## Stream Filtering

```mermaid
flowchart TD
  URL["candidate URL"]
  HTTP{"http/https?"}
  Ext{"extension m3u8/mpd/mp4/m4s/ts?"}
  StreamContext{"path/query mentions hls/dash/manifest/playlist/stream?"}
  Container{"stream container or playlist name?"}
  Accept["accept as provider stream URL"]
  Reject["reject"]

  URL --> HTTP
  HTTP -->|"no"| Reject
  HTTP -->|"yes"| Ext
  Ext -->|"yes"| Accept
  Ext -->|"no"| StreamContext
  StreamContext -->|"no"| Reject
  StreamContext -->|"yes"| Container
  Container -->|"yes"| Accept
  Container -->|"no"| Reject
```

