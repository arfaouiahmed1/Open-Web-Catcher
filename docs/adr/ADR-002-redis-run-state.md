# ADR-002: Redis for Run State, Postgres for Long-Term Memory

Date: 2026-08-22
Status: Accepted. Implementation is planned and not started. See `.omo/plans/full-audit.md`, batch W4 (tasks 17-19). Nothing in this ADR describes shipped code except the deletion targets, which exist today.

## Context

Memory is currently split across three stores with no owner:

1. Postgres holds telemetry and evidence.
2. `site_memory.db` (SQLite) holds accumulated site knowledge.
3. JSON profile files hold per-domain memory entries written by agents.

This split brain causes real failures. Two processes writing the same domain clobber each other because SQLite and flat files have no transactional guard. The short-term signal buckets freeze once they hit their cap because eviction is broken. The SSE fan-out has no shared transport, so a second backend process cannot see a run's live state. The audit IDs are `[MEM-C1]` through `[MEM-C3]` and `[MEM-H5]` through `[MEM-H8]` in the plan's evidence draft.

## Decision

Two tiers, one owner each:

- **Short term: Redis.** Run-scoped signals (streaming progress, tool results, stage events) live in a `RedisRunStore` keyed by run id. Buckets behave as ring buffers with newest-wins-at-cap eviction. Every key carries a 24h TTL so dead runs self-clean. Redis pub/sub also carries SSE fan-out so any process can serve the stream endpoint for an active run.
- **Long term: Postgres relational tables.** Site knowledge moves into `site_hints` rows (domain, page type, summary text, navigation steps, selectors, success rate, TTL) and visual matching vectors into `logo_embeddings` with pgvector. Writes go through repositories inside normal transactions, which makes cross-process races impossible by construction.

The old stores are deleted after a one-shot data migration imports existing `site_memory.db` rows and JSON profiles into summarized `site_hints`. No accumulated memory is lost at cutover. After the migration, writes to `site_memory.db` and the JSON profile stores stop entirely.

## Consequences

Positive:

- Two backend processes share run state; horizontal scaling stops being fiction.
- Eviction is deterministic, which fixes the frozen-bucket bug by design rather than patch.
- Long-term memory gains TTL pruning, concurrency safety, and vector search in one store.
- The `/memory` API and agent prompts read the same source, ending the dual-read drift.

Negative and risky:

- Compose gains a Redis service. It must stay on the internal network with no exposed host ports.
- The encoder-to-dimension pair must be pinned before the DDL lands (CLIP ViT-B/32 implies `vector(512)`); changing encoders later means a migration.
- The compose Postgres image must swap to a pgvector-enabled image before `vector` columns can exist.
- The one-shot import is a hard gate: old stores may only be deleted after the import reports full row counts.

## References

- Target design: `docs/architecture/target-design.md`, section 2 (Memory).
- Plan: `.omo/plans/full-audit.md`, batch W4 (tasks 17-19).
- Current split-brain sources: `src/memory/short_term.py`, `src/memory/long_term.py`, and the JSON profile writers under `src/agents/`.
