# Contributing to Open Web Catcher

Thank you for your interest in contributing to Open Web Catcher (OWC)! We welcome contributions from the community to help build a reliable, high-performance multi-agent anti-piracy and stream verification platform.

---

## Code of Conduct

All contributors and maintainers are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before participating.

---

## Development Setup

### Prerequisites
- **Node.js**: `v20.x` or `v22.x` (with `npm`)
- **Python**: `3.11` or `3.12` with [uv](https://github.com/astral-sh/uv)
- **Docker & Docker Compose**: Docker Desktop with Compose v2
- **Git**

### Clone the Repository
```bash
git clone https://github.com/arfaouiahmed1/Open-Web-Catcher.git
cd Open-Web-Catcher
```

### Environment Configuration
Copy the template configuration and set your keys:
```bash
cp .env.example .env
```

### Running Backend Tests
```bash
uv sync --extra dev
uv run pytest
```

### Running Frontend Tests
```bash
cd web
npm ci
npm run typecheck
npx vitest run
```

---

## Pull Request Guidelines

1. **Create a Topic Branch**:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. **Adhere to Code Standards**:
   - Ensure all TypeScript types compile cleanly: `npm run typecheck` in `/web`.
   - Ensure all tests pass: `npx vitest run` in `/web` and `uv run pytest` at root.
   - Do not commit sensitive environment files (`.env`) or runtime state (`data/*.runtime.*`).
3. **Commit Messages**:
   Use conventional commits:
   - `feat(...)`: new user-facing functionality
   - `fix(...)`: bug fixes
   - `docs(...)`: documentation and wiki updates
   - `test(...)`: new tests or test refactoring
   - `chore(...)`: maintenance tasks, dependency updates
4. **Open a PR**:
   Submit your pull request against the `main` branch. Provide a clear description of the problem solved and link any relevant issues.

---

## Architecture Overview

- **`src/`**: Python FastAPI backend and multi-agent orchestrator.
- **`src/agents/`**: Core agent implementations (Classification, Landing Page, Hosting Extraction, Embedded Player).
- **`tools/playwright/`**: Model Context Protocol (MCP) server providing browser tooling (`navigate`, `inspect`, `interact`, `harvest`, `screenshot`, `wait`).
- **`web/`**: Next.js 15 App Router operator console with Tailwind CSS, Radix UI, and Recharts.

---

## Reporting Issues

If you find a bug or have a feature suggestion, please open an issue using the appropriate template:
- [Bug Report](https://github.com/arfaouiahmed1/Open-Web-Catcher/issues/new?template=bug_report.yml)
- [Feature Request](https://github.com/arfaouiahmed1/Open-Web-Catcher/issues/new?template=feature_request.yml)

For security-sensitive disclosures, please refer to our [Security Policy](SECURITY.md).
