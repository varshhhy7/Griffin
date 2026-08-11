# Griffin

**Griffin is an open-source life-sciences research companion.** It turns a
biological question into a structured, reviewable, and reproducible research
workflow while keeping researchers in control of the scientific decisions.

Griffin is for research use only. It is not a diagnostic device, a clinical
decision-support system, or a source of medical advice. All clinically adjacent
outputs require independent expert review and appropriate experimental
validation.

## Why Griffin

Life-sciences research often spans literature, biological data, computational
tools, experimental design, and evidence review. Griffin brings those steps
into one workspace and records the context needed to understand or reproduce a
result later.

- A researcher-facing desktop workspace for projects, sessions, files, skills,
  models, and terminal work.
- Research, Biology Specialist, and Planning agent modes.
- Scientific Runs: structured workflows with explicit inputs, validation,
  review, approval, audit history, and expected outputs.
- Biology-oriented skills and connectors for literature, genomic, molecular,
  and biomedical research tasks.
- A deterministic Python CLI for transparent neoantigen research pipelines.

## Current Status

Griffin is actively under development. The platform is useful for research
planning, project organization, structured workflow validation, and
reproducibility records. It deliberately does not present unexecuted plans as
scientific results.

| Capability | Status | Notes |
| --- | --- | --- |
| Desktop research workspace | Available | Projects, sessions, files, skills, terminal, and model selection. |
| Biology research agents | Available | Research, Biology Specialist, and Planning modes. |
| Scientific Runs | Available | First workflow: RNA-seq differential-expression planning and validation. |
| RNA-seq execution | Planned | DESeq2/container worker and result artifacts are not implemented yet. |
| Literature retrieval | Under validation | Retrieval quality must be verified with PMID/DOI-based tests. |
| Reproducibility records | Available | Inputs, checksums, parameters, validation, approvals, warnings, and audit log. |
| Neoantigen CLI | Partial scientific MVP | Real VEP and MHCflurry integrations; complete non-mock peptide generation remains in progress. |

## Quick Start: Workspace

### Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- An LLM provider configured in Griffin, such as OpenRouter

### Run locally

```bash
git clone https://github.com/aegion-dynamic/Griffin
cd Griffin/griffin-next
bun install
bun dev serve --port 4097
```

Open `http://localhost:4097` and create a project. Choose a model in the
composer before starting a research session.

### Test the first scientific workflow

1. Create or open a project and start a Biology Specialist session.
2. Add a counts matrix and sample metadata file to the project.
3. Open **Runs**, choose **RNA-seq differential expression**, and supply the
   project-relative file paths.
4. Validate the run. Griffin checks matrix structure, sample-ID alignment,
   contrast values, replicate counts, and simple batch-confounding conditions.
5. Create and approve the run to preserve its reproducibility record.

Approval marks a run as ready for execution; it does not run DESeq2 or create
synthetic biological findings.

## Quick Start: Neoantigen CLI

The root package provides a deterministic CLI for neoantigen research. Python
3.11 is recommended for the scientific dependency stack.

```powershell
git clone https://github.com/aegion-dynamic/Griffin
cd Griffin
uv sync --python 3.11 --group dev
uv run python -m griffin doctor
```

Run the explicit synthetic demo:

```powershell
uv run python -m griffin run `
  --vcf data/examples/tiny.vcf `
  --hla HLA-A*02:01 `
  --cancer-type melanoma `
  --sample-id demo-001 `
  --out runs/demo-001 `
  --genome-assembly GRCh37 `
  --mock
```

Mock mode is for development and demonstrations only. Its outputs are visibly
synthetic and must not be used as scientific evidence.

## Repository Layout

```text
griffin/                 Python CLI, deterministic pipeline, and integrations
griffin/platform/        Versioned skill and recipe contracts
tests/                   Python test suite
docs/                    Scientific boundaries, architecture, and validation plans
griffin-next/            Griffin desktop workspace, API server, and frontend
griffin-next/backend/    Server, agent runtime, connectors, and scientific runs
griffin-next/frontend/   Research workspace UI and shared components
```

For contributor-oriented navigation, see [the repository map](docs/repository-map.md)
and [the contributor guide](CONTRIBUTING.md). Each major area also has a small
README that explains its ownership boundary.

## Quality Checks

Run the checks appropriate to the component you change.

```powershell
# Python CLI
uv run pytest -q
uv run ruff check .
uv run mypy griffin
```

```bash
# Workspace
cd griffin-next
bun run typecheck
bun test --cwd backend/cli
bun run build
```

## Scientific Principles

- Do not fabricate citations, biological observations, datasets, or results.
- Preserve provenance for inputs, tools, model choices, parameters, and outputs.
- Surface uncertainty, limitations, and validation requirements clearly.
- Keep human review at meaningful scientific and clinically adjacent decision
  points.
- Treat external data-source terms, privacy constraints, and permissions as
  part of the workflow.

See [Scientific MVP Status](docs/SCIENTIFIC_MVP_STATUS.md),
[Scientific Boundaries](docs/scientific_boundaries.md), and
[the workspace run guide](griffin-next/docs/GRIFFIN_SCIENTIFIC_RUNS.md) for
the current capability boundary.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) to
choose the owning package and the smallest relevant check. Keep changes focused, include tests for
behavioral changes, document scientific assumptions, and avoid claims beyond
what the implementation and evidence support.

Before opening a pull request, run the relevant quality checks above and
describe any external data sources, licenses, or research-use limitations.

## Security and Responsible Use

Do not commit provider keys, patient data, protected health information, or
unlicensed biological datasets. Use synthetic fixtures for tests. Report
security concerns privately to the maintainers rather than opening a public
issue.

## License and Attribution

Griffin is released under the [MIT License](LICENSE). The workspace contains
Apache-2.0-derived components and third-party research skills; attribution,
license notices, and provenance are retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[griffin-next/NOTICE](griffin-next/NOTICE).
