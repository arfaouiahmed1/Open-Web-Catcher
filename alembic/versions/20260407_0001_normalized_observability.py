"""initial normalized observability schema

Explicit DDL for the observability table families. This revision replaces the
old decorative ``Base.metadata.create_all`` body so that a fresh
``alembic upgrade head`` builds the schema deterministically instead of
mirroring whatever ``src/storage/models.py`` happens to contain at runtime.

Revision ID: 20260407_0001
Revises: -
Create Date: 2026-04-07 00:00:00

Ownership notes (do not duplicate slices owned by later revisions):
- run_screenshots attribution columns (agent_run_id, actor, agent_type,
  invocation_index, tool_name, target_url, seq) and their indexes are added by
  20260520_0015, which is NOT guarded against existing columns; they must not
  be created here. The agent_run_id foreign key is attached by c69a9ee239fd.
- Guarded later revisions (0009/0010/0012/0013/0014/0016) inspect the live
  schema and skip columns already present, so their columns are created here
  with full current metadata.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260407_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("page_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("streams_found", sa.Integer(), nullable=False),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("tool_calls", sa.Integer(), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("failure_mode", sa.String(length=64), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_runs_run_id"), "runs", ["run_id"], unique=True)
    op.create_index(op.f("ix_runs_created_at"), "runs", ["created_at"], unique=False)

    op.create_table(
        "background_jobs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("job_id", sa.String(length=64), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("job_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("error_text", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(), nullable=True),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "job_type", "idempotency_key", name="uq_background_jobs_type_idempotency"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_background_jobs_job_id"), "background_jobs", ["job_id"], unique=True)
    op.create_index(op.f("ix_background_jobs_run_id"), "background_jobs", ["run_id"], unique=True)
    op.create_index(op.f("ix_background_jobs_job_type"), "background_jobs", ["job_type"], unique=False)
    op.create_index(op.f("ix_background_jobs_status"), "background_jobs", ["status"], unique=False)
    op.create_index(op.f("ix_background_jobs_idempotency_key"), "background_jobs", ["idempotency_key"], unique=False)
    op.create_index(op.f("ix_background_jobs_lease_expires_at"), "background_jobs", ["lease_expires_at"], unique=False)
    op.create_index(op.f("ix_background_jobs_heartbeat_at"), "background_jobs", ["heartbeat_at"], unique=False)
    op.create_index(op.f("ix_background_jobs_created_at"), "background_jobs", ["created_at"], unique=False)

    op.create_table(
        "pipeline_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("root_url", sa.Text(), nullable=False),
        sa.Column("page_type", sa.String(length=32), nullable=False),
        sa.Column("final_status", sa.String(length=32), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("failure_mode", sa.String(length=64), nullable=False),
        sa.Column("stream_count", sa.Integer(), nullable=False),
        sa.Column("screenshot_count", sa.Integer(), nullable=False),
        sa.Column("email_count", sa.Integer(), nullable=False),
        sa.Column("provider_analysis_count", sa.Integer(), nullable=False),
        sa.Column("top_level_page_type", sa.String(length=32), nullable=False),
        sa.Column("classification_confidence", sa.String(length=16), nullable=False),
        sa.Column("classification_reasoning", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("total_tokens_in", sa.Integer(), nullable=False),
        sa.Column("total_cached_input_tokens", sa.Integer(), nullable=False),
        sa.Column("total_new_input_tokens", sa.Integer(), nullable=False),
        sa.Column("total_tokens_out", sa.Integer(), nullable=False),
        sa.Column("total_llm_calls", sa.Integer(), nullable=False),
        sa.Column("total_cache_hit_calls", sa.Integer(), nullable=False),
        sa.Column("total_tool_calls", sa.Integer(), nullable=False),
        sa.Column("total_messages", sa.Integer(), nullable=False),
        sa.Column("estimated_input_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_cached_input_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_cache_write_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_output_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_total_cost_usd", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_pipeline_runs_run_id"), "pipeline_runs", ["run_id"], unique=True)
    op.create_index(op.f("ix_pipeline_runs_root_url"), "pipeline_runs", ["root_url"], unique=False)
    op.create_index(op.f("ix_pipeline_runs_page_type"), "pipeline_runs", ["page_type"], unique=False)
    op.create_index(op.f("ix_pipeline_runs_final_status"), "pipeline_runs", ["final_status"], unique=False)
    op.create_index(op.f("ix_pipeline_runs_success"), "pipeline_runs", ["success"], unique=False)
    op.create_index(op.f("ix_pipeline_runs_started_at"), "pipeline_runs", ["started_at"], unique=False)
    op.create_index(op.f("ix_pipeline_runs_created_at"), "pipeline_runs", ["created_at"], unique=False)

    op.create_table(
        "run_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("snapshot_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_run_snapshots_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_snapshots_pipeline_run_id"), "run_snapshots", ["pipeline_run_id"], unique=True)
    op.create_index(op.f("ix_run_snapshots_run_id"), "run_snapshots", ["run_id"], unique=True)

    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("agent_type", sa.String(length=32), nullable=False),
        sa.Column("target_url", sa.Text(), nullable=False),
        sa.Column("page_type", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("tool_call_budget", sa.Integer(), nullable=False),
        sa.Column("tool_calls_made", sa.Integer(), nullable=False),
        sa.Column("llm_calls_made", sa.Integer(), nullable=False),
        sa.Column("prompt_compiled", sa.Boolean(), nullable=False),
        sa.Column("memory_injected", sa.Boolean(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False),
        sa.Column("new_input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("context_window", sa.Integer(), nullable=False),
        sa.Column("context_tokens", sa.Integer(), nullable=False),
        sa.Column("context_usage_pct", sa.Float(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("invocation_index", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_agent_runs_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_agent_runs_pipeline_run_id"), "agent_runs", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_agent_runs_actor"), "agent_runs", ["actor"], unique=False)
    op.create_index(op.f("ix_agent_runs_agent_type"), "agent_runs", ["agent_type"], unique=False)
    op.create_index(op.f("ix_agent_runs_page_type"), "agent_runs", ["page_type"], unique=False)
    op.create_index(op.f("ix_agent_runs_status"), "agent_runs", ["status"], unique=False)
    op.create_index(op.f("ix_agent_runs_provider"), "agent_runs", ["provider"], unique=False)
    op.create_index(op.f("ix_agent_runs_model_name"), "agent_runs", ["model_name"], unique=False)
    op.create_index(op.f("ix_agent_runs_started_at"), "agent_runs", ["started_at"], unique=False)

    op.create_table(
        "agent_outputs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_run_id", sa.Integer(), nullable=False),
        sa.Column("output_json", sa.JSON(), nullable=False),
        sa.Column("summary_text", sa.Text(), nullable=False),
        sa.Column("stream_count", sa.Integer(), nullable=False),
        sa.Column("embedded_url_count", sa.Integer(), nullable=False),
        sa.Column("hosting_page_count", sa.Integer(), nullable=False),
        sa.Column("validation_status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_agent_outputs_agent_run_id_agent_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_agent_outputs_agent_run_id"), "agent_outputs", ["agent_run_id"], unique=True)

    # Memory tables live here rather than in c69a9ee239fd: the unguarded
    # create_all decorations in 0003-0011 mirror current models metadata and
    # would otherwise create them before the head revision runs.
    op.create_table(
        "memory_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("domain", sa.String(length=255), nullable=False),
        sa.Column("page_type", sa.String(length=32), nullable=False),
        sa.Column("source_run_id", sa.String(length=64), nullable=False),
        sa.Column("source_agent_run_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("data_json", sa.JSON(), nullable=False),
        sa.Column("result_summary", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["source_agent_run_id"],
            ["agent_runs.id"],
            name="fk_memory_entries_source_agent_run_id_agent_runs",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_memory_entries_domain"), "memory_entries", ["domain"], unique=False)
    op.create_index(op.f("ix_memory_entries_page_type"), "memory_entries", ["page_type"], unique=False)
    op.create_index(op.f("ix_memory_entries_source_run_id"), "memory_entries", ["source_run_id"], unique=False)
    op.create_index(op.f("ix_memory_entries_source_agent_run_id"), "memory_entries", ["source_agent_run_id"], unique=False)
    op.create_index(op.f("ix_memory_entries_status"), "memory_entries", ["status"], unique=False)
    op.create_index(op.f("ix_memory_entries_success"), "memory_entries", ["success"], unique=False)
    op.create_index(op.f("ix_memory_entries_created_at"), "memory_entries", ["created_at"], unique=False)

    op.create_table(
        "memory_hints_used",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_run_id", sa.Integer(), nullable=False),
        sa.Column("memory_entry_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_memory_hints_used_agent_run_id_agent_runs",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["memory_entry_id"],
            ["memory_entries.id"],
            name="fk_memory_hints_used_memory_entry_id_memory_entries",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("agent_run_id", "memory_entry_id", name="uq_memory_hint_used"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_memory_hints_used_agent_run_id"), "memory_hints_used", ["agent_run_id"], unique=False)
    op.create_index(op.f("ix_memory_hints_used_memory_entry_id"), "memory_hints_used", ["memory_entry_id"], unique=False)

    op.create_table(
        "prompt_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_id", sa.String(length=32), nullable=False),
        sa.Column("source_path", sa.Text(), nullable=False),
        sa.Column("semantic_version", sa.String(length=64), nullable=False),
        sa.Column("content_hash", sa.String(length=128), nullable=False),
        sa.Column("prompt_text", sa.Text(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("agent_id", "content_hash", name="uq_prompt_versions_agent_hash"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_prompt_versions_agent_id"), "prompt_versions", ["agent_id"], unique=False)
    op.create_index(op.f("ix_prompt_versions_content_hash"), "prompt_versions", ["content_hash"], unique=False)
    op.create_index(op.f("ix_prompt_versions_active"), "prompt_versions", ["active"], unique=False)

    op.create_table(
        "prompt_compilations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("prompt_version_id", sa.Integer(), nullable=True),
        sa.Column("agent_run_id", sa.Integer(), nullable=False),
        sa.Column("cache_mode", sa.String(length=32), nullable=False),
        sa.Column("compiled_prompt_hash", sa.String(length=128), nullable=False),
        sa.Column("provider_cache_key", sa.Text(), nullable=False),
        sa.Column("provider_cache_eligible", sa.Boolean(), nullable=False),
        sa.Column("static_cache_hit", sa.Boolean(), nullable=False),
        sa.Column("memory_injected", sa.Boolean(), nullable=False),
        sa.Column("output_contract_version", sa.String(length=64), nullable=False),
        sa.Column("sections_json", sa.JSON(), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["prompt_version_id"],
            ["prompt_versions.id"],
            name="fk_prompt_compilations_prompt_version_id_prompt_versions",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_prompt_compilations_agent_run_id_agent_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_prompt_compilations_prompt_version_id"), "prompt_compilations", ["prompt_version_id"], unique=False)
    op.create_index(op.f("ix_prompt_compilations_agent_run_id"), "prompt_compilations", ["agent_run_id"], unique=False)
    op.create_index(op.f("ix_prompt_compilations_compiled_prompt_hash"), "prompt_compilations", ["compiled_prompt_hash"], unique=False)

    op.create_table(
        "llm_calls",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_run_id", sa.Integer(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("prompt_version", sa.String(length=128), nullable=False),
        sa.Column("prompt_hash", sa.String(length=128), nullable=False),
        sa.Column("cache_mode", sa.String(length=32), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False),
        sa.Column("new_input_tokens", sa.Integer(), nullable=False),
        sa.Column("cache_creation_input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("context_window", sa.Integer(), nullable=True),
        sa.Column("estimated_input_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_cached_input_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_cache_write_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_output_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_total_cost_usd", sa.Float(), nullable=False),
        sa.Column("tool_calls_requested", sa.Integer(), nullable=False),
        sa.Column("tools_requested", sa.JSON(), nullable=False),
        sa.Column("content_preview", sa.Text(), nullable=False),
        sa.Column("usage_metadata_json", sa.JSON(), nullable=False),
        sa.Column("response_metadata_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_llm_calls_agent_run_id_agent_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_llm_calls_agent_run_id"), "llm_calls", ["agent_run_id"], unique=False)
    op.create_index(op.f("ix_llm_calls_seq"), "llm_calls", ["seq"], unique=False)
    op.create_index(op.f("ix_llm_calls_provider"), "llm_calls", ["provider"], unique=False)
    op.create_index(op.f("ix_llm_calls_model_name"), "llm_calls", ["model_name"], unique=False)
    op.create_index(op.f("ix_llm_calls_prompt_hash"), "llm_calls", ["prompt_hash"], unique=False)

    op.create_table(
        "tool_calls",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("agent_run_id", sa.Integer(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("tool_name", sa.String(length=128), nullable=False),
        sa.Column("args_json", sa.JSON(), nullable=False),
        sa.Column("target_summary", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("result_preview", sa.Text(), nullable=False),
        sa.Column("error_text", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_tool_calls_agent_run_id_agent_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tool_calls_agent_run_id"), "tool_calls", ["agent_run_id"], unique=False)
    op.create_index(op.f("ix_tool_calls_seq"), "tool_calls", ["seq"], unique=False)
    op.create_index(op.f("ix_tool_calls_tool_name"), "tool_calls", ["tool_name"], unique=False)
    op.create_index(op.f("ix_tool_calls_status"), "tool_calls", ["status"], unique=False)

    op.create_table(
        "tool_playground_calls",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("call_id", sa.String(length=64), nullable=False),
        sa.Column("origin", sa.String(length=32), nullable=False),
        sa.Column("related_run_id", sa.String(length=64), nullable=False),
        sa.Column("profile", sa.String(length=64), nullable=False),
        sa.Column("tool_name", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("args_json", sa.JSON(), nullable=False),
        sa.Column("result_json", sa.JSON(), nullable=False),
        sa.Column("error_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tool_playground_calls_call_id"), "tool_playground_calls", ["call_id"], unique=True)
    op.create_index(op.f("ix_tool_playground_calls_origin"), "tool_playground_calls", ["origin"], unique=False)
    op.create_index(op.f("ix_tool_playground_calls_related_run_id"), "tool_playground_calls", ["related_run_id"], unique=False)
    op.create_index(op.f("ix_tool_playground_calls_profile"), "tool_playground_calls", ["profile"], unique=False)
    op.create_index(op.f("ix_tool_playground_calls_tool_name"), "tool_playground_calls", ["tool_name"], unique=False)
    op.create_index(op.f("ix_tool_playground_calls_status"), "tool_playground_calls", ["status"], unique=False)
    op.create_index(op.f("ix_tool_playground_calls_created_at"), "tool_playground_calls", ["created_at"], unique=False)

    op.create_table(
        "run_decisions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("details_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_run_decisions_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_decisions_pipeline_run_id"), "run_decisions", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_run_decisions_run_id"), "run_decisions", ["run_id"], unique=False)
    op.create_index(op.f("ix_run_decisions_actor"), "run_decisions", ["actor"], unique=False)
    op.create_index(op.f("ix_run_decisions_category"), "run_decisions", ["category"], unique=False)
    op.create_index(op.f("ix_run_decisions_status"), "run_decisions", ["status"], unique=False)
    op.create_index(op.f("ix_run_decisions_created_at"), "run_decisions", ["created_at"], unique=False)

    op.create_table(
        "run_tasks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("priority", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("details_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_run_tasks_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_tasks_pipeline_run_id"), "run_tasks", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_run_tasks_run_id"), "run_tasks", ["run_id"], unique=False)
    op.create_index(op.f("ix_run_tasks_actor"), "run_tasks", ["actor"], unique=False)
    op.create_index(op.f("ix_run_tasks_priority"), "run_tasks", ["priority"], unique=False)
    op.create_index(op.f("ix_run_tasks_status"), "run_tasks", ["status"], unique=False)
    op.create_index(op.f("ix_run_tasks_created_at"), "run_tasks", ["created_at"], unique=False)

    op.create_table(
        "provider_lookup_checks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("lookup_id", sa.String(length=64), nullable=False),
        sa.Column("stream_url", sa.Text(), nullable=False),
        sa.Column("hostname", sa.String(length=255), nullable=False),
        sa.Column("ip", sa.String(length=128), nullable=False),
        sa.Column("org", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("country", sa.String(length=64), nullable=False),
        sa.Column("region", sa.String(length=128), nullable=False),
        sa.Column("city", sa.String(length=128), nullable=False),
        sa.Column("abuse_email", sa.String(length=255), nullable=False),
        sa.Column("whois_raw", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_provider_lookup_checks_lookup_id"), "provider_lookup_checks", ["lookup_id"], unique=False)
    op.create_index(op.f("ix_provider_lookup_checks_hostname"), "provider_lookup_checks", ["hostname"], unique=False)
    op.create_index(op.f("ix_provider_lookup_checks_ip"), "provider_lookup_checks", ["ip"], unique=False)
    op.create_index(op.f("ix_provider_lookup_checks_provider"), "provider_lookup_checks", ["provider"], unique=False)
    op.create_index(op.f("ix_provider_lookup_checks_country"), "provider_lookup_checks", ["country"], unique=False)
    op.create_index(op.f("ix_provider_lookup_checks_abuse_email"), "provider_lookup_checks", ["abuse_email"], unique=False)
    op.create_index(op.f("ix_provider_lookup_checks_created_at"), "provider_lookup_checks", ["created_at"], unique=False)

    op.create_table(
        "runtime_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("agent_run_id", sa.Integer(), nullable=True),
        sa.Column("actor", sa.String(length=64), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("details_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_runtime_events_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name="fk_runtime_events_agent_run_id_agent_runs",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_runtime_events_pipeline_run_id"), "runtime_events", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_runtime_events_agent_run_id"), "runtime_events", ["agent_run_id"], unique=False)
    op.create_index(op.f("ix_runtime_events_actor"), "runtime_events", ["actor"], unique=False)
    op.create_index(op.f("ix_runtime_events_seq"), "runtime_events", ["seq"], unique=False)
    op.create_index(op.f("ix_runtime_events_kind"), "runtime_events", ["kind"], unique=False)
    op.create_index(op.f("ix_runtime_events_status"), "runtime_events", ["status"], unique=False)
    op.create_index(op.f("ix_runtime_events_created_at"), "runtime_events", ["created_at"], unique=False)

    op.create_table(
        "run_model_usage",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("llm_calls", sa.Integer(), nullable=False),
        sa.Column("cache_hit_calls", sa.Integer(), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False),
        sa.Column("new_input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("estimated_input_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_cached_input_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_cache_write_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_output_cost_usd", sa.Float(), nullable=False),
        sa.Column("estimated_total_cost_usd", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_run_model_usage_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("pipeline_run_id", "provider", "model_name", name="uq_run_model_usage"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_model_usage_pipeline_run_id"), "run_model_usage", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_run_model_usage_provider"), "run_model_usage", ["provider"], unique=False)
    op.create_index(op.f("ix_run_model_usage_model_name"), "run_model_usage", ["model_name"], unique=False)

    op.create_table(
        "run_streams",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("stream_url", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("protocol", sa.String(length=32), nullable=False),
        sa.Column("quality", sa.String(length=64), nullable=False),
        sa.Column("source_layer", sa.String(length=128), nullable=False),
        sa.Column("server_label", sa.String(length=128), nullable=False),
        sa.Column("dedupe_hash", sa.String(length=128), nullable=False),
        sa.Column("captured_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_run_streams_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("pipeline_run_id", "dedupe_hash", name="uq_run_stream_dedupe"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_streams_pipeline_run_id"), "run_streams", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_run_streams_dedupe_hash"), "run_streams", ["dedupe_hash"], unique=False)

    # Base slice only: the per-agent attribution columns (agent_run_id, actor,
    # agent_type, invocation_index, tool_name, target_url, seq) are added by
    # 20260520_0015, which is not guarded against existing columns.
    op.create_table(
        "run_screenshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("screenshot_url", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_run_screenshots_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_screenshots_pipeline_run_id"), "run_screenshots", ["pipeline_run_id"], unique=False)

    op.create_table(
        "provider_analyses",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("stream_url", sa.Text(), nullable=False),
        sa.Column("ip", sa.String(length=128), nullable=False),
        sa.Column("hostname", sa.String(length=255), nullable=False),
        sa.Column("org", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("country", sa.String(length=64), nullable=False),
        sa.Column("region", sa.String(length=128), nullable=False),
        sa.Column("city", sa.String(length=128), nullable=False),
        sa.Column("abuse_email", sa.String(length=255), nullable=False),
        sa.Column("whois_raw", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_provider_analyses_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_provider_analyses_pipeline_run_id"), "provider_analyses", ["pipeline_run_id"], unique=False)

    op.create_table(
        "takedown_emails",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("pipeline_run_id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("abuse_email", sa.String(length=255), nullable=False),
        sa.Column("channel_name", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("infringing_url", sa.Text(), nullable=False),
        sa.Column("stream_urls_json", sa.JSON(), nullable=False),
        sa.Column("screenshot_urls_json", sa.JSON(), nullable=False),
        sa.Column("server_labels_json", sa.JSON(), nullable=False),
        sa.Column("stream_evidence_json", sa.JSON(), nullable=False),
        sa.Column("provider_info_json", sa.JSON(), nullable=False),
        sa.Column("rights_owner_reference_url", sa.Text(), nullable=False),
        sa.Column("generated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["pipeline_run_id"],
            ["pipeline_runs.id"],
            name="fk_takedown_emails_pipeline_run_id_pipeline_runs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_takedown_emails_pipeline_run_id"), "takedown_emails", ["pipeline_run_id"], unique=False)
    op.create_index(op.f("ix_takedown_emails_channel_name"), "takedown_emails", ["channel_name"], unique=False)


def downgrade() -> None:
    # Reverse dependency order; dropping a table drops its indexes with it.
    op.drop_table("takedown_emails")
    op.drop_table("provider_analyses")
    op.drop_table("run_screenshots")
    op.drop_table("run_streams")
    op.drop_table("run_model_usage")
    op.drop_table("runtime_events")
    op.drop_table("provider_lookup_checks")
    op.drop_table("run_tasks")
    op.drop_table("run_decisions")
    op.drop_table("tool_playground_calls")
    op.drop_table("tool_calls")
    op.drop_table("llm_calls")
    op.drop_table("prompt_compilations")
    op.drop_table("prompt_versions")
    op.drop_table("agent_outputs")
    op.drop_table("memory_hints_used")
    op.drop_table("memory_entries")
    op.drop_table("agent_runs")
    op.drop_table("run_snapshots")
    op.drop_table("pipeline_runs")
    op.drop_table("background_jobs")
    op.drop_table("runs")
