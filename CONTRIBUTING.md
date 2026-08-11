# Contributing to Griffin

Welcome. Griffin is a monorepo with two related products: a Python research
pipeline and a Bun/TypeScript research workspace. Start with the [repository
map](docs/repository-map.md), then choose the area that owns your change.

## Choose the right area

| Area | Main code | Tests and checks |
| --- | --- | --- |
| Python research CLI | `griffin/` | `tests/`, `uv run pytest -q`, `uv run ruff check .` |
| Workspace backend and CLI | `griffin-next/backend/cli/` | `griffin-next/backend/cli/test/`, `cd griffin-next && bun run typecheck && bun test` |
| Workspace UI | `griffin-next/frontend/workspace/` and `frontend/ui/` | package typechecks and Playwright tests |
| Docs and marketing | `docs/` and `griffin-next/frontend/{docs,landing}/` | package build/typecheck |
| Shared contracts | `schemas/` and backend API definitions | datastore workflow plus the relevant Python contract test |
| Cataloged capabilities | `griffin-next/catalog/` | catalog-specific checks in `griffin-next/.github/workflows/catalog.yml` |

## Find a change by concern

- CLI commands and process startup: `griffin/cli.py` or `griffin-next/backend/cli/src/cli/`.
- Deterministic biology logic: `griffin/bio/`.
- External services and model providers: `griffin/integrations/` and `griffin/adapters/`.
- Pipeline stages, manifests, checkpoints, and run state: `griffin/pipeline/`, `griffin/core/`, and `griffin/storage/`.
- Workspace HTTP/SSE APIs: `griffin-next/backend/cli/src/server/`.
- Agent prompts and runtime behavior: `griffin-next/backend/cli/src/agent/` and `src/session/`.
- Scientific workspace runs: `griffin-next/backend/cli/src/science/runs/` and `griffin-next/docs/GRIFFIN_SCIENTIFIC_RUNS.md`.
- Workspace screens and interactions: `griffin-next/frontend/workspace/src/`.
- Shared UI components and styles: `griffin-next/frontend/ui/src/`.
- Generated SDK and release tooling: `griffin-next/tooling/`.

## Local workflow

1. Create a focused branch, for example `codex/fix-run-validation`.
2. Make the smallest change in the owning area.
3. Update tests and the nearest documentation when behavior or contracts change.
4. If a backend API changes, regenerate the SDK with `griffin-next/tooling/repo/generate.ts`.
5. Run the checks for the area you changed before opening a pull request.

Do not edit dependency installs, build output, runtime state, or upstream
snapshots. They are local inputs and are intentionally ignored by Git.

## Pull request checklist

- The change has one clear area of ownership.
- Tests cover changed behavior, including schema or manifest changes.
- Scientific assumptions, limitations, and external data sources are documented.
- No provider keys, patient data, generated bundles, or large biological files are committed.
- The PR explains what was verified and calls out any checks that could not run.

For workspace-specific conventions, see [`griffin-next/CONTRIBUTING.md`](griffin-next/CONTRIBUTING.md).
