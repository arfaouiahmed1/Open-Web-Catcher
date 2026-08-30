# ADR-005: JWT Bearer Auth with Three Roles and a Bootstrap Hatch

Date: 2026-08-22
Status: Accepted as an architecture decision. Implementation is in progress under plan task 3 of `.omo/plans/full-audit.md` and not yet verified: `src/api/auth/` contains router, security, and dependency files, but the role dependency is not wired into every router and no acceptance test has passed. Nothing here should be read as shipped.

## Context

The API had zero authentication. Every route, including mutating ones, answered any caller. The audit flagged this as `[SEC-C2]`. Separately, `[SEC-C3]` (arbitrary file write on the export endpoint) was fixed directly. The console needs a login flow, fresh installs need a first admin without manual database surgery, and operator actions need accountability by role.

## Decision

- **JWT bearer auth.** `POST /auth/login` verifies a bcrypt password hash and returns a signed JWT. Clients send it as `Authorization: Bearer <token>`.
- **Three roles:** `admin`, `operator`, `viewer`. A `require_role(...)` dependency gates routes; admin-only surfaces (user management, prompt versions, cost dashboards) check `admin`.
- **Global 401 by default.** Unauthenticated requests to any route are rejected with 401 except exactly three: `/auth/login`, `/auth/bootstrap-admin`, and `/health`. There is no anonymous read tier.
- **Bootstrap-admin hatch.** On a fresh install with zero users, `POST /auth/bootstrap-admin` creates the first admin from a one-time request. Once any user exists, the endpoint refuses, so it cannot be replayed later to escalate.

## Consequences

Positive:

- The console can log in immediately after the foundation lands; no manual SQL to create the first user.
- Role checks give admin surfaces a real gate instead of UI hiding.
- The 401-by-default posture means new routes are protected even if the author forgets auth entirely.

Negative and risky:

- Token revocation is limited to expiry. Short-lived tokens are the mitigation; a longer-lived "sessions" story would need its own decision.
- Global dependencies mean every router test needs an authenticated client fixture, or tests silently test the 401 path.
- The bootstrap hatch is safe only while the users table is empty. Its guard must be tested explicitly (second call must fail).
- Password storage, key rotation, and token lifetime settings become operational responsibilities; see `docs/operations/key-rotation.md`.

## References

- Implementation: `src/api/auth/router.py`, `src/api/auth/security.py`, `src/api/auth/dependencies.py`.
- Plan: `.omo/plans/full-audit.md`, batch W1 task 3, batch W9 task 35 (admin APIs behind roles).
- Target design: `docs/architecture/target-design.md` (AdminShell page set).
