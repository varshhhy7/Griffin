# Python package map

The root `griffin` package is the deterministic Python research pipeline.

| Directory | Responsibility |
| --- | --- |
| `cli.py` | Typer entry point and user-facing commands |
| `bio/` | Variant parsing, normalization, HLA handling, peptide generation, and scoring |
| `pipeline/` | Stage orchestration, context, artifacts, and execution order |
| `core/` | Domain models, manifests, checkpoints, hashing, logging, and errors |
| `integrations/` | Clients for VEP, PubMed, ClinicalTrials, MHCflurry, pVACseq, and LLMs |
| `adapters/` | Replaceable model and MHC implementations, including mock-safe adapters |
| `storage/` | Run records, graph/database access, cache, and path resolution |
| `platform/` | Skill, recipe, and runtime contracts and registries |
| `agents/` | Research-oriented orchestration agents |
| `reports/` | Markdown/PDF report rendering and templates |
| `config/` | Settings and packaged defaults |

Prefer domain logic in `bio/` or `core/`, orchestration in `pipeline/`, and
external I/O behind `integrations/` or `adapters/`. Keep CLI parsing thin so
the pipeline remains testable without invoking a shell command.
