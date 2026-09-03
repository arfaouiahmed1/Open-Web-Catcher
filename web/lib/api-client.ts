/**
 * Typed API client for the operator console (plan task 38).
 *
 * All request/response shapes come from the generated bindings at
 * `src/types/api.d.ts`, which is produced from the committed backend
 * OpenAPI schema (`openapi.json` at the repo root) via `npm run types:gen`.
 *
 * Resource groups: `runsApi`, `datasetsApi`, `memoryApi`, `settingsApi`,
 * `adminApi`, `observabilityApi`, `workflowsApi`. Legacy JS pages keep working
 * through the thin delegates in `lib/api.js`.
 */
import type { components, operations, paths } from "@/src/types/api";

export type ApiSchemas = components["schemas"];
export type OperationName = keyof operations;
export type ApiPath = keyof paths;

/** Extract a generated response type for each requested numeric status code. */
type ResponseForStatus<Responses, Status extends number> = Status extends unknown
  ? Responses extends Record<Status, infer Response>
    ? Response
    : never
  : never;

type JsonResponseBody<Response> = [Response] extends [never]
  ? never
  : Response extends {
        content: { "application/json": infer Body };
      }
    ? Body
    : unknown;

/** The JSON payload of a success response for a generated operation. */
export type ApiSuccess<
  Op extends OperationName,
  Status extends number = 200,
> = JsonResponseBody<ResponseForStatus<operations[Op]["responses"], Status>>;

/** The JSON request body type for a generated operation (never when none). */
export type ApiBody<Op extends OperationName> =
  operations[Op]["requestBody"] extends {
    content: { "application/json": infer Body };
  }
    ? Body
    : never;

/** Query-parameter object type for a generated operation. */
export type ApiQuery<Op extends OperationName> =
  operations[Op]["parameters"] extends { query?: infer Q } ? Q : never;

export const TOKEN_STORAGE_KEY = "owc_token";

let cachedApiBase: string | null = null;

const DEFAULT_CACHE_TTL_MS = 10_000;

const CACHEABLE_GET_PATHS: Record<string, true> = {
  "/ui/pricing": true,
  "/api/health": true,
  "/ui/providers/models": true,
  "/ui/provider/models": true,
  "/ui/config": true,
  "/ui/overview": true,
};

function isCacheablePath(path: string): boolean {
  const clean = path.split("?")[0] ?? path;
  return CACHEABLE_GET_PATHS[clean] === true;
}

type CacheEntry = { data: unknown; expiresAt: number };
const responseCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<unknown>>();


export function clearApiCache(): void {
  responseCache.clear();
}

export function clearInflightRequests(): void {
  inflightRequests.clear();
}

/**
 * Resolve the API base URL from the explicitly configured origin.
 *
 * There is deliberately no localhost fallback: the variable is required at
 * build time. Browser requests use NEXT_PUBLIC_API_BASE_URL; server-side
 * rendering and tests retain the legacy API_BASE_URL override so an internal
 * backend origin is not accidentally exposed to the browser bundle.
 */
export function resolveApiBase(): string {
  if (cachedApiBase) return cachedApiBase;
  const raw = typeof window === "undefined"
    ? process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL
    : process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!raw || !raw.trim()) {
    throw new Error(
      "NEXT_PUBLIC_API_BASE_URL is required; the localhost API fallback was removed.",
    );
  }
  cachedApiBase = raw.trim().replace(/\/+$/, "");
  return cachedApiBase;
}

/** Test/SSR helper: forget any memoized base URL. @visibleForTesting */
export function resetApiBaseCache(): void {
  cachedApiBase = null;
  responseCache.clear();
  inflightRequests.clear();
}
export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Browser requests stay same-origin through the Next runtime proxy. This
  // removes host/port and CORS ambiguity between the Docker console (:3005),
  // a local Next dev server (:3000), and the API (:8000). Server code keeps
  // the explicitly configured internal/public base URL.
  if (typeof window !== "undefined") return `/api/proxy${normalizedPath}`;
  return `${resolveApiBase()}${normalizedPath}`;
}

export function getToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function eventSourceUrl(path: string): string {
  const rawUrl = apiUrl(path);
  const url = new URL(rawUrl, typeof window !== "undefined" ? window.location.origin : resolveApiBase());
  const token = getToken();
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export interface ApiFetchOptions extends RequestInit {
  /** Query parameters appended to `path`; null/undefined values are skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Abort signal for request cancellation (T44 perf hygiene). */
  signal?: AbortSignal;
  /** Optional TTL for GET caching; defaults to 10s for static endpoints. */
  ttlMs?: number;
  /** Skip both cache read and dedup for this request. */
  skipCache?: boolean;
}

/**
 * Untyped-path fetch used by the legacy JS surface and as the transport for
 * every typed wrapper below. Throws on non-2xx with the response body text
 * and redirects to /login on 401. Supports AbortSignal via options.signal (T44).
 * Includes in-flight dedup and short-TTL GET caching for static endpoints.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { query, ttlMs, skipCache, ...init } = options;
  const url = withQuery(path, query);
  const method = (init.method ? String(init.method) : "GET").toUpperCase();
  const isGet = method === "GET";
  const hasBody = init.body != null;
  const effectiveTtl =
    ttlMs !== undefined ? ttlMs : isGet && !hasBody && isCacheablePath(url) ? DEFAULT_CACHE_TTL_MS : undefined;
  const useCache =
    isGet &&
    !hasBody &&
    !skipCache &&
    effectiveTtl != null &&
    effectiveTtl > 0 &&
    !(init.signal?.aborted ?? false);
  let cacheKey: string | null = null;
  if (useCache) {
    cacheKey = `${method}:${url}`;
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as T;
    }
    if (cached) responseCache.delete(cacheKey);
  }

  const rawBody = init.body as BodyInit | null | undefined;
  const bodyKey = typeof rawBody === "string" ? rawBody : rawBody ? String(rawBody) : "";
  const dedupKey = !skipCache && !init.signal ? `${method}:${url}:${bodyKey}` : null;
  if (dedupKey && inflightRequests.has(dedupKey)) {
    return inflightRequests.get(dedupKey) as Promise<T>;
  }

  const doFetch = async (): Promise<T> => {
    const token = getToken();
    const response = await fetch(apiUrl(url), {
      ...init,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });

    if (response.status === 401 && typeof window !== "undefined") {
      const returnPath = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${returnPath}`;
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      throw await readApiError(response);
    }

    const data = (await response.json()) as T;
    if (cacheKey && effectiveTtl != null && effectiveTtl > 0) {
      responseCache.set(cacheKey, { data, expiresAt: Date.now() + effectiveTtl });
    }
    return data;
  };

  const promise = doFetch();
  if (dedupKey) {
    inflightRequests.set(dedupKey, promise);
    const cleanup = (): void => {
      inflightRequests.delete(dedupKey as string);
    };
    promise.then(cleanup, cleanup);
  }
  return promise;
}

/** Fetch an authenticated binary response through the same console proxy. */
export async function apiFetchBlob(
  path: string,
  options: ApiFetchOptions = {},
): Promise<Blob> {
  const { query, ...init } = options;
  const token = getToken();
  const response = await fetch(apiUrl(withQuery(path, query)), {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "image/*",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });

  if (response.status === 401 && typeof window !== "undefined") {
    const returnPath = encodeURIComponent(
      window.location.pathname + window.location.search,
    );
    window.location.href = `/login?next=${returnPath}`;
    throw new Error("Unauthorized");
  }
  if (!response.ok) throw await readApiError(response);
  return response.blob();
}

async function readApiError(response: Response): Promise<Error> {
  const body = await response.text();
  let message = body;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown };
    const detail = parsed.detail ?? parsed.error;
    if (typeof detail === "string" && detail.trim()) message = detail;
  } catch {
    // Keep plain-text backend errors unchanged.
  }
  return new Error(message || `Request failed with ${response.status}`);
}

function withQuery(
  path: string,
  query?: ApiFetchOptions["query"],
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* Runs (console overview, run detail, decisions, tasks)               */
/* ------------------------------------------------------------------ */

export const runsApi = {
  overview: () =>
    apiFetch<ApiSuccess<"ui_overview_ui_overview_get">>("/ui/overview"),

  recentEvents: (limit?: number) =>
    apiFetch<ApiSuccess<"ui_recent_runtime_events_ui_events_recent_get">>(
      "/ui/events/recent",
      { query: { limit } },
    ),

  listRuns: (query?: ApiQuery<"ui_runs_ui_runs_get">) =>
    apiFetch<ApiSuccess<"ui_runs_ui_runs_get">>("/ui/runs", { query }),

  getRun: (runId: string) =>
    apiFetch<ApiSuccess<"ui_run_detail_ui_runs__run_id__get">>(
      `/ui/runs/${enc(runId)}`,
    ),

  deleteRun: (runId: string) =>
    apiFetch<ApiSuccess<"ui_delete_run_ui_runs__run_id__delete">>(
      `/ui/runs/${enc(runId)}`,
      { method: "DELETE" },
    ),

  cancelRun: (runId: string) =>
    apiFetch<ApiSuccess<"ui_cancel_run_ui_runs__run_id__cancel_post">>(
      `/ui/runs/${enc(runId)}/cancel`,
      { method: "POST" },
    ),

  cancelActiveRuns: () =>
    apiFetch<ApiSuccess<"ui_cancel_active_runs_ui_runs_cancel_active_post">>(
      "/ui/runs/cancel-active",
      { method: "POST" },
    ),

  syncLogs: (runId: string, body?: ApiBody<"ui_sync_run_logs_ui_runs__run_id__sync_logs_post">) =>
    apiFetch<ApiSuccess<"ui_sync_run_logs_ui_runs__run_id__sync_logs_post">>(
      `/ui/runs/${enc(runId)}/sync-logs`,
      { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
    ),

  listDecisions: (runId: string) =>
    apiFetch<ApiSuccess<"ui_run_decisions_ui_runs__run_id__decisions_get">>(
      `/ui/runs/${enc(runId)}/decisions`,
    ),

  createDecision: (
    runId: string,
    body: ApiBody<"ui_create_run_decision_ui_runs__run_id__decisions_post">,
  ) =>
    apiFetch<ApiSuccess<"ui_create_run_decision_ui_runs__run_id__decisions_post">>(
      `/ui/runs/${enc(runId)}/decisions`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateDecision: (
    runId: string,
    decisionId: string,
    body: ApiBody<"ui_update_run_decision_ui_runs__run_id__decisions__decision_id__patch">,
  ) =>
    apiFetch<ApiSuccess<"ui_update_run_decision_ui_runs__run_id__decisions__decision_id__patch">>(
      `/ui/runs/${enc(runId)}/decisions/${enc(decisionId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  deleteDecision: (runId: string, decisionId: string) =>
    apiFetch<ApiSuccess<"ui_delete_run_decision_ui_runs__run_id__decisions__decision_id__delete">>(
      `/ui/runs/${enc(runId)}/decisions/${enc(decisionId)}`,
      { method: "DELETE" },
    ),

  listTasks: (runId: string) =>
    apiFetch<ApiSuccess<"ui_run_tasks_ui_runs__run_id__tasks_get">>(
      `/ui/runs/${enc(runId)}/tasks`,
    ),

  createTask: (
    runId: string,
    body: ApiBody<"ui_create_run_task_ui_runs__run_id__tasks_post">,
  ) =>
    apiFetch<ApiSuccess<"ui_create_run_task_ui_runs__run_id__tasks_post">>(
      `/ui/runs/${enc(runId)}/tasks`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateTask: (
    runId: string,
    taskId: string,
    body: ApiBody<"ui_update_run_task_ui_runs__run_id__tasks__task_id__patch">,
  ) =>
    apiFetch<ApiSuccess<"ui_update_run_task_ui_runs__run_id__tasks__task_id__patch">>(
      `/ui/runs/${enc(runId)}/tasks/${enc(taskId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  deleteTask: (runId: string, taskId: string) =>
    apiFetch<ApiSuccess<"ui_delete_run_task_ui_runs__run_id__tasks__task_id__delete">>(
      `/ui/runs/${enc(runId)}/tasks/${enc(taskId)}`,
      { method: "DELETE" },
    ),
};

/* ------------------------------------------------------------------ */
/* Datasets (/api/datasets/*)                                          */
/* ------------------------------------------------------------------ */

export const datasetsApi = {
  meta: () => apiFetch<ApiSuccess<"get_meta_api_datasets_meta_get">>("/api/datasets/meta"),

  listSites: (query?: ApiQuery<"list_sites_api_datasets_sites_get">) =>
    apiFetch<ApiSuccess<"list_sites_api_datasets_sites_get">>("/api/datasets/sites", { query }),

  getSite: (siteId: string, query?: ApiQuery<"get_site_api_datasets_sites__site_id__get">) =>
    apiFetch<ApiSuccess<"get_site_api_datasets_sites__site_id__get">>(
      `/api/datasets/sites/${enc(siteId)}`,
      { query },
    ),

  createSite: (body: ApiBody<"create_site_api_datasets_sites_post">) =>
    apiFetch<ApiSuccess<"create_site_api_datasets_sites_post">>(
      "/api/datasets/sites",
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateSite: (
    siteId: string,
    body: ApiBody<"update_site_api_datasets_sites__site_id__patch">,
  ) =>
    apiFetch<ApiSuccess<"update_site_api_datasets_sites__site_id__patch">>(
      `/api/datasets/sites/${enc(siteId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  replaceSite: (
    siteId: string,
    body: ApiBody<"replace_site_api_datasets_sites__site_id__put">,
  ) =>
    apiFetch<ApiSuccess<"replace_site_api_datasets_sites__site_id__put">>(
      `/api/datasets/sites/${enc(siteId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    ),

  deleteSite: (siteId: string) =>
    apiFetch<ApiSuccess<"delete_site_api_datasets_sites__site_id__delete">>(
      `/api/datasets/sites/${enc(siteId)}`,
      { method: "DELETE" },
    ),

  siteStats: () =>
    apiFetch<ApiSuccess<"get_stats_api_datasets_sites_stats_get">>(
      "/api/datasets/sites/stats",
    ),

  bulkUpdateSites: (body: ApiBody<"bulk_update_api_datasets_sites_bulk_update_post">) =>
    apiFetch<ApiSuccess<"bulk_update_api_datasets_sites_bulk_update_post">>(
      "/api/datasets/sites/bulk-update",
      { method: "POST", body: JSON.stringify(body) },
    ),

  bulkDeleteSites: (body: ApiBody<"bulk_delete_api_datasets_sites_bulk_delete_post">) =>
    apiFetch<ApiSuccess<"bulk_delete_api_datasets_sites_bulk_delete_post">>(
      "/api/datasets/sites/bulk-delete",
      { method: "POST", body: JSON.stringify(body) },
    ),

  healthCheckSites: (body: ApiBody<"check_site_health_api_datasets_sites_health_check_post">) =>
    apiFetch<ApiSuccess<"check_site_health_api_datasets_sites_health_check_post">>(
      "/api/datasets/sites/health-check",
      { method: "POST", body: JSON.stringify(body) },
    ),

  results: (query?: ApiQuery<"get_results_api_datasets_results_get">) =>
    apiFetch<ApiSuccess<"get_results_api_datasets_results_get">>(
      "/api/datasets/results",
      { query },
    ),

  recordResult: (body: ApiBody<"record_result_api_datasets_results_record_post">) =>
    apiFetch<ApiSuccess<"record_result_api_datasets_results_record_post">>(
      "/api/datasets/results/record",
      { method: "POST", body: JSON.stringify(body) },
    ),

  listBatches: (query?: ApiQuery<"list_batches_api_datasets_batches_get">) =>
    apiFetch<ApiSuccess<"list_batches_api_datasets_batches_get">>(
      "/api/datasets/batches",
      { query },
    ),

  getBatch: (batchId: string, query?: ApiQuery<"get_batch_api_datasets_batches__batch_id__get">) =>
    apiFetch<ApiSuccess<"get_batch_api_datasets_batches__batch_id__get">>(
      `/api/datasets/batches/${enc(batchId)}`,
      { query },
    ),

  createBatch: (body: ApiBody<"create_batch_api_datasets_batches_post">) =>
    apiFetch<ApiSuccess<"create_batch_api_datasets_batches_post">>(
      "/api/datasets/batches",
      { method: "POST", body: JSON.stringify(body) },
    ),

  cancelBatch: (batchId: string) =>
    apiFetch<
      ApiSuccess<"ui_cancel_dataset_batch_api_datasets_batches__batch_id__cancel_post">
    >(`/api/datasets/batches/${enc(batchId)}/cancel`, { method: "POST" }),
};

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export const memoryApi = {
  entries: () => apiFetch<ApiSuccess<"get_memory_entries_memory_get">>("/memory"),

  search: (body: ApiBody<"search_memory_memory_search_post">) =>
    apiFetch<ApiSuccess<"search_memory_memory_search_post">>("/memory/search", {
      method: "POST",
      body: JSON.stringify(body),
    }),

};

/* ------------------------------------------------------------------ */
/* Settings (config, pricing, providers, cost estimates)               */
/* ------------------------------------------------------------------ */

export const settingsApi = {
  getConfig: () => apiFetch<ApiSuccess<"ui_get_config_ui_config_get">>("/ui/config"),

  updateConfig: (body: ApiBody<"ui_update_config_ui_config_put">) =>
    apiFetch<ApiSuccess<"ui_update_config_ui_config_put">>("/ui/config", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  getPricing: () => apiFetch<ApiSuccess<"ui_pricing_ui_pricing_get">>("/ui/pricing"),

  updatePricing: (body: ApiBody<"ui_update_pricing_ui_pricing_put">) =>
    apiFetch<ApiSuccess<"ui_update_pricing_ui_pricing_put">>("/ui/pricing", {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  syncPricing: (body?: ApiBody<"ui_sync_pricing_ui_pricing_sync_post">) =>
    apiFetch<ApiSuccess<"ui_sync_pricing_ui_pricing_sync_post">>(
      "/ui/pricing/sync",
      { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) },
    ),

  estimateCosts: (query?: ApiQuery<"ui_estimate_costs_ui_settings_estimate_costs_get">) =>
    apiFetch<ApiSuccess<"ui_estimate_costs_ui_settings_estimate_costs_get">>(
      "/ui/settings/estimate-costs",
      { query },
    ),

  lookupProvider: (body: ApiBody<"ui_provider_lookup_ui_providers_lookup_post">) =>
    apiFetch<ApiSuccess<"ui_provider_lookup_ui_providers_lookup_post">>(
      "/ui/providers/lookup",
      { method: "POST", body: JSON.stringify(body) },
    ),

  providerHistory: (query?: ApiQuery<"ui_provider_history_ui_providers_history_get">) =>
    apiFetch<ApiSuccess<"ui_provider_history_ui_providers_history_get">>(
      "/ui/providers/history",
      { query },
    ),

  providerModels: (query?: ApiQuery<"ui_provider_models_ui_providers_models_get">) =>
    apiFetch<ApiSuccess<"ui_provider_models_ui_providers_models_get">>(
      "/ui/providers/models",
      { query },
    ),
};

/* ------------------------------------------------------------------ */
/* Admin (/api/admin/*)                                                */
/* ------------------------------------------------------------------ */

export const adminApi = {
  listUsers: (query?: ApiQuery<"list_users_api_admin_users_get">) =>
    apiFetch<ApiSuccess<"list_users_api_admin_users_get">>("/api/admin/users", { query }),

  createUser: (body: ApiBody<"create_user_api_admin_users_post">) =>
    apiFetch<ApiSuccess<"create_user_api_admin_users_post", 201>>(
      "/api/admin/users",
      { method: "POST", body: JSON.stringify(body) },
    ),

  updateUser: (
    userId: string,
    body: ApiBody<"update_user_api_admin_users__user_id__patch">,
  ) =>
    apiFetch<ApiSuccess<"update_user_api_admin_users__user_id__patch">>(
      `/api/admin/users/${enc(userId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  deleteUser: (userId: string) =>
    apiFetch<ApiSuccess<"delete_user_api_admin_users__user_id__delete">>(
      `/api/admin/users/${enc(userId)}`,
      { method: "DELETE" },
    ),

  modelPerformance: () =>
    apiFetch<ApiSuccess<"model_performance_metrics_api_admin_metrics_model_performance_get">>(
      "/api/admin/metrics/model-performance",
    ),

  listPromptVersions: (query?: ApiQuery<"list_prompt_versions_api_admin_prompt_versions_get">) =>
    apiFetch<ApiSuccess<"list_prompt_versions_api_admin_prompt_versions_get">>(
      "/api/admin/prompt-versions",
      { query },
    ),

  diffPromptVersions: (query: ApiQuery<"diff_prompt_versions_api_admin_prompt_versions_diff_get">) =>
    apiFetch<ApiSuccess<"diff_prompt_versions_api_admin_prompt_versions_diff_get">>(
      "/api/admin/prompt-versions/diff",
      { query },
    ),

  getPromptVersion: (versionId: string) =>
    apiFetch<ApiSuccess<"get_prompt_version_api_admin_prompt_versions__version_id__get">>(
      `/api/admin/prompt-versions/${enc(versionId)}`,
    ),

  activatePromptVersion: (versionId: string) =>
    apiFetch<
      ApiSuccess<"activate_prompt_version_api_admin_prompt_versions__version_id__activate_post">
    >(`/api/admin/prompt-versions/${enc(versionId)}/activate`, { method: "POST" }),

  listAgentTests: (query?: ApiQuery<"list_agent_tests_api_admin_agent_tests_get">) =>
    apiFetch<ApiSuccess<"list_agent_tests_api_admin_agent_tests_get">>(
      "/api/admin/agent-tests",
      { query },
    ),

  launchAgentTest: (body: ApiBody<"launch_agent_test_api_admin_agent_tests_post">) =>
    apiFetch<ApiSuccess<"launch_agent_test_api_admin_agent_tests_post", 202>>(
      "/api/admin/agent-tests",
      { method: "POST", body: JSON.stringify(body) },
    ),

  getAgentTest: (runId: string) =>
    apiFetch<ApiSuccess<"get_agent_test_api_admin_agent_tests__run_id__get">>(
      `/api/admin/agent-tests/${enc(runId)}`,
    ),

  costs: () => apiFetch<ApiSuccess<"cost_deltas_api_admin_costs_get">>("/api/admin/costs"),
};

/* ------------------------------------------------------------------ */
/* Observability                                                       */
/* ------------------------------------------------------------------ */

export const observabilityApi = {
  snapshot: () =>
    apiFetch<ApiSuccess<"observability_observability_get">>("/observability"),
};

/* ------------------------------------------------------------------ */
/* Workflows                                                           */
/* ------------------------------------------------------------------ */

export const workflowsApi = {
  estimate: (body: ApiBody<"api_workflows_estimate_api_workflows_estimate_post">) =>
    apiFetch<ApiSuccess<"api_workflows_estimate_api_workflows_estimate_post">>(
      "/api/workflows/estimate",
      { method: "POST", body: JSON.stringify(body) },
    ),

  run: (body: ApiBody<"ui_workflow_run_ui_workflows_run_post">) =>
    apiFetch<ApiSuccess<"ui_workflow_run_ui_workflows_run_post">>(
      "/ui/workflows/run",
      { method: "POST", body: JSON.stringify(body) },
    ),
};
