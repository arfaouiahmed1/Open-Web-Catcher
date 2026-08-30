# Security Policy

## Supported Versions

Security fixes are applied to the latest state of the default branch. There are
no long-term support branches; please update to the most recent commit before
reporting or verifying an issue.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Select **Report a vulnerability**.
3. Provide a description, reproduction steps, and affected components.

If private vulnerability reporting is unavailable, contact the maintainers
directly and mark the message as a security disclosure.

### What to include

- Affected component (backend `src/`, console `web/`, browser tools `tools/`,
  Docker setup, CI, etc.)
- Version / commit hash you tested against
- Step-by-step reproduction or proof of concept
- Expected vs. actual behavior
- Any known workarounds

### What to expect

- Acknowledgment within **5 business days**.
- An assessment and remediation plan within **30 days**.
- Credit in release notes if desired; otherwise reports are handled discreetly.

Please do not disclose the issue publicly until a fix is released and
coordinated with the maintainers.

## Secrets And Key Handling

This project relies on API keys and database credentials configured via `.env`
(see `.env.example`). Never commit real credentials.

If a key is exposed or needs replacement, follow the rotation procedure in
[docs/operations/key-rotation.md](../docs/operations/key-rotation.md).

## Scope Notes

- The operator console (`web/`) and FastAPI backend (`src/api/`) are intended to
  run on trusted networks; do not expose them directly to the internet without
  additional hardening.
- Browser tool services (`tools/puppeteer/`, `tools/playwright/`) control real
  browsers and must not be exposed beyond the compose network.
