# ADR-004: RAG Strategy, Vector and Agentic, No GraphRAG

Date: 2026-08-22
Status: Accepted. The OCR skeleton that feeds the visual index is live behind `ocr_enabled` (`src/agents/ocr_agent.py`). The pgvector tables and the `memory_search` tool are planned; see `.omo/plans/full-audit.md`, batch W4 (task 18).

## Context

The system has two distinct retrieval needs:

1. **Visual matching.** Screenshots show channel logos and names. Deciding "which channel is this" needs similarity search over image embeddings.
2. **Site memory.** Agents revisit domains and need prior navigation knowledge (which buttons to press, which selectors worked). This is textual recall with structure.

GraphRAG was evaluated as a third option for both. It was rejected.

## Decision

One retrieval strategy per need:

- **Vector RAG for logo and channel matching.** CLIP-style embeddings (512 dimensions) stored in a `logo_embeddings` table backed by pgvector. `OcrAgent` crops logo and channel regions from screenshots, embeds them, and returns candidate channels with confidence. Retrieval is nearest-neighbor cosine search.
- **Agentic RAG for site memory.** A `memory_search(query, domain?)` tool is registered in agent tool profiles. It queries summarized `site_hints` rows (hybrid SQL filter plus cosine similarity on the hint embedding). Agents call it when they need prior knowledge instead of receiving stuffed context every turn. Hints are injected once at run start into `HandoffContext.memory_hints`; mid-run re-injection is forbidden so prompts stay stable across stages. A summarizer runs at write time, so stored hints stay compact rather than accumulating raw transcripts.

**GraphRAG is rejected**, for two reasons:

1. Corpus size. The knowledge base is per-domain hints and logo vectors, hundreds to low thousands of rows. GraphRAG's community-detection and multi-hop traversal machinery pays off at corpus scales orders of magnitude larger.
2. Redundancy. The relational schema already provides graph-shaped queries: joins across domains, page types, runs, and hints answer the "how does X relate to Y" questions GraphRAG would serve. Adding a graph store would duplicate that capability behind a new operational burden.

## Consequences

Positive:

- Each need gets the cheapest sufficient mechanism. No graph database to run, no entity extraction pipeline to maintain.
- Agentic retrieval keeps prompts small and stable; context size stops growing with memory size.
- The encoder-to-vector contract is explicit and testable.

Negative and risky:

- The encoder choice is frozen into the DDL. Pinning CLIP ViT-B/32 to `vector(512)` must happen before the migration; changing encoders later means re-embedding everything and altering columns.
- Summarization quality bounds retrieval quality. A bad summary poisons future runs, so summarizer output needs its own tests.
- Vector search adds a pgvector dependency to the Postgres image; vanilla postgres cannot serve it.
- Agentic retrieval means agents can choose not to look. Tool descriptions and budgets must make `memory_search` the obvious first move on known domains.

## References

- Target design: `docs/architecture/target-design.md`, section 2 (Memory) and `ChannelDetection` / `LogoEmbedding` contracts.
- Plan: `.omo/plans/full-audit.md`, batch W3 task 16 (OCR skeleton), batch W4 task 18 (pgvector tables, `memory_search`).
