# Python test map

Tests mirror the responsibilities of the `griffin` package.

- `test_cli.py` — command wiring and user-facing behavior.
- `test_vcf_parser.py`, `test_hla.py`, `test_scoring.py` — deterministic biology logic.
- `test_vep_client.py`, `test_mhcflurry_adapter.py` — external integration boundaries.
- `test_manifest.py`, `test_platform_foundations.py` — platform contracts and registries.
- `test_schema_contract.py` — compatibility with `schemas/griffin-db.sql` and the workspace datastore.
- `platform/runtime/` — runtime hashing, graph, and no-op execution behavior.
- `fixtures/` — small synthetic payloads used by multiple tests.

Use synthetic fixtures. Tests must not require provider keys, patient data, or
live biological services unless a test explicitly opts into an integration
environment.
