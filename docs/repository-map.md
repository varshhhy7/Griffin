# Griffin repository map

This file is the shortest route from a question to the code that owns it.

```text
.
├── griffin/                 Python CLI and deterministic research pipeline
├── tests/                   Python tests and shared fixtures
├── data/examples/           Small synthetic inputs safe to commit
├── schemas/                 Cross-component database and manifest contracts
├── docs/                    Python CLI architecture and scientific guidance
└── griffin-next/            Bun/TypeScript desktop workspace
    ├── backend/cli/         CLI, local server, agent runtime, tools, skills
    ├── frontend/workspace/  Main SolidJS research workspace
    ├── frontend/ui/         Shared UI components, theme, and assets
    ├── frontend/docs/       Documentation and share site
    ├── frontend/landing/    Public marketing site
    ├── catalog/             Curated external skills and capability manifests
    ├── tooling/             SDK, plugin, launcher, generators, and release tools
    └── docs/                Workspace architecture, plans, and verification notes
```

## Where to look first

| Question | Start here | Follow-up |
| --- | --- | --- |
| How does the Python CLI start? | `griffin/cli.py` | `griffin/pipeline/runner.py` |
| How does the workspace start? | `griffin-next/backend/cli/src/index.ts` | `src/cli/cmd/web.ts` |
| Where is the local API? | `griffin-next/backend/cli/src/server/` | `tooling/sdk/js/` |
| Where is a research run defined? | `griffin-next/backend/cli/src/science/runs/` | `griffin-next/docs/GRIFFIN_SCIENTIFIC_RUNS.md` |
| Where are biological integrations? | `griffin/integrations/` | `griffin/adapters/` |
| Where are UI components? | `griffin-next/frontend/workspace/src/` | `griffin-next/frontend/ui/src/` |
| Where are tests? | `tests/` or the package-local `test/` directory | Read the nearest package README |
| Where are contracts and schemas? | `schemas/` | `griffin-next/backend/cli/src/storage/` |
| Where are build and release commands? | `griffin-next/tooling/` | `griffin-next/.github/workflows/` |

## Dependency direction

The Python side flows from CLI commands into pipeline stages, domain logic,
integrations, and storage. The workspace side flows from the frontend through
the local server into the agent/tool/runtime layers. Shared contracts should be
changed deliberately because both the TypeScript datastore and Python contract
tests consume them.

Generated files, package installs, local runtime state, and upstream snapshots
are not source-of-truth locations. Change the generator or source package
instead.
