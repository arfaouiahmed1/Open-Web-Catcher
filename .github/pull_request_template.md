<!-- Pull requests that touch security-sensitive areas must complete every section. -->

## Summary

<!-- What does this PR change and why? Link related issues/tasks. -->

-

## Risk

<!-- What can break? Which components are affected (backend, web console, browser tools, storage, CI)? -->

- Risk level: <!-- low | medium | high -->
- Blast radius:

## Test Evidence

<!-- Paste command output or CI run links proving the change works. -->

- [ ] `uv sync --extra dev` succeeds
- [ ] `uv run pytest -m unit` passes
- [ ] `cd tools/playwright && npm test` passes (if browser tools touched)
- [ ] `cd web && npm run build` passes (if console touched)

## Adversarial Probes

<!-- Checks for hostile-input and failure-path behavior. Mark N/A explicitly if not applicable. -->

- [ ] Malformed/untrusted input handled (bad URLs, oversized payloads, invalid JSON)
- [ ] No secrets or credentials committed (checked diff against `.env.example`)
- [ ] Failure paths tested (missing service, empty evidence, provider errors)
- [ ] New dependencies reviewed for supply-chain risk
