/**
 * Local prop contracts for the T37 component library.
 *
 * TODO(plan-T38-types): every interface in this file is a hand-written mirror
 * of a backend schema. When the generated API types land (sibling lane,
 * web/src/types/), replace these locals with the generated equivalents and
 * delete the duplicates here. Field names intentionally match the snake_case
 * JSON emitted by the FastAPI/pydantic layer.
 */

/** Shared UI lifecycle for every library component. */
export type ComponentState = "loading" | "error" | "empty" | "success";

/** Mirror of RunPlanRepository.PLAN_STEP_STATUSES (src/storage/repositories.py). */
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

/** Step shape emitted by src/orchestrator/run_plan.py `_normalize_steps`. */
export interface PlanStep {
  id: string;
  title: string;
  criteria: string;
  /** Free-form budget passthrough from the declarative plan (may be null). */
  budget: number | string | null;
  status: PlanStepStatus;
}

/** Verdict enum documented on src/models/judge.py::JudgeVerdict.verdict. */
export type JudgeVerdictValue = "pass" | "replan" | "fail";

/**
 * TODO(plan-T38-types): mirror of src/models/judge.py::JudgeVerdict.
 * Replace with the generated type; only the fields rendered by ValidationBadge
 * are declared here.
 */
export interface JudgeVerdictFields {
  verdict: JudgeVerdictValue;
  /** 0..1 overall evidence sufficiency. */
  evidence_score?: number;
  /** 0..1 how likely the streams actually play. */
  playback_confidence?: number;
  /** screenshots ↔ claims consistency. */
  channel_match?: boolean;
  required_fixes?: string[];
  flagged_urls?: string[];
}

/**
 * TODO(plan-T38-types): subset of src/models/orchestrator.py::RunMetrics cost
 * fields. Replace with the generated type; field names must stay identical to
 * the JSON keys returned by web/lib/api.js responses.
 */
export interface RunCostFields {
  estimated_input_cost_usd?: number;
  estimated_cached_input_cost_usd?: number;
  estimated_cache_write_cost_usd?: number;
  estimated_output_cost_usd?: number;
  estimated_total_cost_usd?: number;
}

/** One reasoning/trace entry rendered by ReasoningTrace. */
export interface ReasoningEntry {
  id: string;
  title: string;
  thought?: string;
  /** ISO timestamp as delivered by the trace stream. */
  timestamp?: string;
}

/** One console/SSE event rendered by EventFeedItem. */
export interface FeedEvent {
  id: string;
  kind: string;
  message: string;
  level?: "debug" | "info" | "warn" | "error";
  timestamp?: string;
}
