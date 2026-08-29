# ADR-003: Playwright-Only Browser Stack with a Single Coherent Persona

Date: 2026-08-22
Status: Accepted. Implementation is planned and not started. See `.omo/plans/full-audit.md`, batch W5 (tasks 20-22). Both browser stacks still exist in the repo today.

## Context

The repo carries two parallel browser stacks: `tools/puppeteer/` and `tools/playwright/`, each with its own MCP server, Docker image, and tool surface. The duplication is expensive, and the split is not even: puppeteer holds port-worthy features (stream-CORS injection, playback activation, scoped element queries, byte-budget payload fitting) that playwright lacks.

Fingerprint handling is worse than duplicated. Rotation code (`shouldRotateFingerprint`, `pageFingerprintState`) swaps identity traits mid-session, which produces personas no real browser would present: mismatched user agent, platform, timezone, and locale. Settings also expose fingerprint and proxy knobs to users, which invites incoherent configurations and violates the zero-config mandate (D15).

## Decision

Consolidate on Playwright and delete the puppeteer stack:

1. Port first. Stream-CORS injection, `activatePlayback` wiring, scoped query params for `query_elements`, `fitPayloadToBudget` telemetry, window bounds enforcement, media helpers, and the five puppeteer test files move into `tools/playwright/` before anything is deleted.
2. Fix session lifecycle in the surviving MCP server: register abort handlers before browser acquisition, dedupe concurrent acquisitions per run key, bind CDP and MCP ports to localhost by default.
3. Delete `tools/puppeteer/**`, the `owc-tools` compose service, its Dockerfile, and the dual-engine settings surface.
4. One persona: a coherent Windows 11 x64 laptop profile (version-matched Chrome brands, disciplined client hints, real GPU strings, automation flags suppressed). Geo-binding resolves the exit proxy's geography into a matching timezone and locale pair, cached per proxy key.
5. Persistent cookie jars: one directory per (profile, target host) under `data/browser-state/<hash>/`, used through `launchPersistentContext`. No timestamped throwaway contexts.
6. Zero user-facing knobs. Fingerprint and proxy controls disappear from the settings UI; advanced overrides stay server-side and internal.

## Consequences

Positive:

- One browser codebase to test, secure, and deploy. One Docker image instead of two.
- Repeat visits to the same target reuse cookies, which raises success rates on login-gated and consent-walled pages.
- A pinned, coherent persona survives scrutiny better than rotation, because rotation is what looks robotic.
- Operators cannot configure the system into a detectable state.

Negative and risky:

- The port wave is a hard precondition. Deleting puppeteer before its features land would silently drop capability.
- Persona coherence needs a live probe test (UA, platform, timezone agreement in one page dump), not just unit checks.
- Proxy support narrows to a simple built-in list plus an optional paid-provider hook; free-proxy datasets go away.
- Existing runs that depended on puppeteer-specific behavior need revalidation against the playwright tools.

## References

- Target design: `docs/architecture/target-design.md` (agent modules consume one tool surface).
- Plan: `.omo/plans/full-audit.md`, batch W5 (tasks 20-23) and audit IDs `[TOOL-P*]`, `[FP-F1-F9]`.
