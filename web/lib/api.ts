/**
 * Legacy API surface — now a thin re-export of the typed client.
 *
 * Historically `lib/api.js` owned `resolveApiBase`/`apiFetch` directly.
 * Since T38 the canonical implementation lives in `lib/api-client.ts`; this
 * module re-exports that contract so older `import { apiFetch } from "@/lib/api"`
 * sites keep working without a codemod, and so `api.test.ts` continues to
 * assert the "no localhost fallback" guarantee against the single source of truth.
 */

export {
  apiFetch,
  apiUrl,
  eventSourceUrl,
  getToken,
  resetApiBaseCache,
  resolveApiBase,
  TOKEN_STORAGE_KEY,
} from "./api-client";

export type { ApiFetchOptions } from "./api-client";
