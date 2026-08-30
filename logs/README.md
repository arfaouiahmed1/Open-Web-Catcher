# Logs

This directory consolidates local build and runtime logs that were previously
scattered at the repository root (`build_log*.txt`) and under `data/logs/`.

- `build_log*.txt` — historical build outputs (git-ignored)
- `*.log`, `*.out.log`, `*.err.log` — runtime logs (git-ignored)

The directory itself is git-ignored (`logs/` in `.gitignore`) except for this
README and `.gitkeep` so the structure is preserved in the repo.

Runtime logs that matter for debugging in containers live under `data/logs/`
which is also git-ignored but kept via `data/logs/.gitkeep`.
