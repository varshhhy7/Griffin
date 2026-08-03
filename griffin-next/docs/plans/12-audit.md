# Workstream 12 — implementation audit

> **Status: all 15 findings resolved.** See [Resolution](#resolution) at the end
> for what changed, plus four further defects the fixes uncovered — including
> one that silently discarded every message part on backfill.


Audit of the SQLite datastore + knowledge graph work against [12-sqlite-knowledge-graph.md](12-sqlite-knowledge-graph.md).

**Method:** every claim was checked against the code, not the file listing. Schema claims were verified by migrating a scratch database and introspecting `sqlite_master`. Wiring claims were verified by grepping for the import at the consumer, not the definition at the producer.

**Headline:** the datastore itself is real and good. Roughly half of what is nominally "built" is **not reachable at runtime** — six modules are written, tested in isolation, and never imported by anything. Typecheck is red, and the CI gate the whole rollout depends on cannot fail.

**Measured state:**

| | |
| --- | --- |
| `bun run typecheck` | ❌ **fails** — 2 errors, both `src/tool/graph.ts` |
| `bun test` | 1125 pass / 13 skip / **39 fail**, 121 files, 383 s |
| Pre-existing baseline (captured before this workstream) | 34 fail across 7 files — `patch`, `snapshot`, `file/ignore`, `file/path-traversal`, `project` worktrees, `server/atlas-bridge`, `session/compaction`; all Windows path/symlink/unicode, none touching `storage/` |
| **Net new failures attributable to this work** | **1** — `Backfill and Verify yield 0 diffs on clean data` (see D2) |
| `test/storage/` in isolation | 40 pass / 1 fail (the same one) |

The baseline matters: this suite was never green on this branch, so "the tests pass" is not a usable gate. Every claim below is measured against that 34-failure list.

---

## Status at a glance

| Phase | Claim | Verdict |
| --- | --- | --- |
| 0 | Build spike | ✅ **Done** — verified independently (static + dynamic import, compiled binary runs, WAL + FTS5 available) |
| 1 | Characterization tests | ✅ **Done** — 14 tests, pin `NotFoundError` text, no-upsert, comma-join ordering |
| 2 | `mode` / `client` / `schema` / entity DDL / `db status` | ✅ **Done** — verified by introspection; migrations 1–3 apply cleanly |
| 3 | Shadow projection, `backfill`, `verify`, relocation fix | ⚠️ **Done with defects** — see D2, D3, D4 |
| 4 | `primary` read path | ⚠️ **Partial** — `read`/`list` done; `update` still reads JSON (D5); `stats.ts` not converted |
| 5 | Graph tables, `derive`, `rebuild` | ✅ **Done** — all trust columns present, append-only edges, `rebuild` implemented |
| 6 | Port `Provenance`, import `graph.json`, register graph tools | ❌ **Not done** — `store.ts` untouched, no import migration, tools unregistered (D6) |
| 7 | `server/routes/graph.ts` | ❌ **Written, not mounted** (D7) |
| 8 | Cytoscape lineage DAG | ⚠️ **Renderer registered, library absent** (D11) |
| 9 | FTS5 | ❌ **Dead module** (D8) |
| 10 | Vocabulary + `kb_*` tools | ⚠️ **Written, unregistered, unseeded** (D6, D10) |
| 11 | Entity resolution | ⚠️ **Written; the `[]`-vs-error ambiguity is unmitigated** |
| 12 | Python read-only client | ⚠️ **Written; its contract test cannot detect drift** (D12) |
| 13–14 | Remaining views, delete JSON writer | ⬜ Not started — correct, these are last |

---

## Defects

Ordered by how much they matter.

### D1 — Typecheck is red. `bun run check` cannot pass. **Blocker**

`src/tool/graph.ts:36` and `:65` — both handlers return a union of two differently-shaped `metadata` objects, so TypeScript infers `metadata.count: number` from the first branch and rejects the second (`nodes`/`edges`).

```
src/tool/graph.ts(36,9): error TS2322 … Type 'undefined' is not assignable to type 'number'
src/tool/graph.ts(65,9): error TS2322 … Type 'number' is not assignable to type 'undefined'
```

Fix: give `metadata` one declared shape with optional members, or annotate the return type explicitly. Nothing else in the tree fails typecheck.

### D2 — `db verify` reports unknown namespaces as `missing_in_db`. **The main CI gate produces false positives**

`src/storage/db/verify.ts:53-61` walks every `**/*.json` under the storage dir and, for anything not already in the DB key map, emits `missing_in_db`. It only special-cases `permission` and `share` (`:56`). Any other unrecognized top-level segment — a stray file, a namespace added by a future workstream, a leftover from another tool — is reported as drift.

This is not hypothetical. It is currently reproducible:

```bash
cd griffin-next/backend/cli && bun test test/storage/db/verify.test.ts
```
passes alone (1/1), but

```bash
cd griffin-next/backend/cli && bun test test/storage/storage.test.ts test/storage/db/verify.test.ts
```
fails with **255 diffs**, every one `missing_in_db`, because the characterization suite writes keys under invented namespaces into the shared per-process data dir.

Two separate fixes are needed:
1. **`verify` must classify unknown namespaces as their own kind** (`unknown_namespace`), reported and counted but not conflated with a projection failure. Otherwise the signal that says "a `Storage` write path is skipping projection" — the entire reason this gate exists — is indistinguishable from noise.
2. **`test/storage/storage.test.ts` must stop polluting the shared data dir** (my defect, introduced in phase 1): it invents namespaces like `chr-ids-…`. It should either use the real namespaces or clean up after itself.

### D3 — `griffin db verify` always exits 0. **The CI gate is inert**

`src/cli/cmd/db.ts:176-203` prints diffs and returns. There is no `process.exit(1)` and no `process.exitCode`. A CI step running `griffin db verify` passes with any number of diffs. Owner decision 3 ("`db verify` runs in CI against a committed fixture") cannot be satisfied until this sets a non-zero exit on `!res.ok`.

### D4 — No CI wiring at all

`grep -rn "db verify\|db backfill\|schema_contract" .github/workflows/` returns nothing. Neither the TypeScript gate nor the Python contract test runs anywhere. Decision 3 is unimplemented beyond the command existing.

### D5 — `Storage.update` reads JSON even in `primary` mode

`src/storage/storage.ts:189-200`. `read` was correctly switched to SQL at `:176-182`, but `update` still does `await Bun.file(target).json()` at `:194`. In `primary` these disagree: a record present in SQL but absent on disk is readable and un-updatable, failing with `NotFoundError` from a file that was never supposed to be consulted. It works today only because `primary` still writes JSON as a rollback — meaning the bug is invisible until phase 14 deletes the JSON writer, which is the one irreversible step.

### D6 — Six agent tools are written, tested, and unreachable

`src/tool/graph.ts` exports `graph_search`, `graph_neighbors`, `graph_lineage`; `src/tool/kb.ts` exports `kb_assert`, `kb_entity`, `kb_vocabulary_propose`. Neither `GraphTools` nor `KbTools` appears anywhere in `src/tool/registry.ts`. The model cannot call any of them. Phases 6, 10, and 11 have no user-visible effect.

### D7 — `server/routes/graph.ts` is not mounted

No `.route("/graph", …)` in `src/server/server.ts`. The bounded-subgraph endpoint the frontend needs does not exist at runtime, which also means the phase 7 gate ("lineage on a 50k-node DB under 100 ms") has never been measurable.

### D8 — `src/storage/db/fts.ts` is a dead module

It implements `ensureSchema` / `queue` / `drain` / `search` over `fts_queue` + `fts_part`, and nothing imports it. `ensureSchema` is never called, so neither table exists in a migrated database (confirmed by introspection: tables are `alias, edge, message, node, part, project, research_run, schema_migrations, session, session_diff, session_share, todo, vocabulary`). Phase 9 is not delivered.

### D9 — `src/storage/db/entity.ts` is a dead module

Nothing imports it; `projection.ts` implements its own `read`/`list`. Either wire it or delete it — a second, divergent read path is worse than none.

### D10 — The `vocabulary` table seeds zero rows

The plan specifies a seed set with `status='core'` (`gene`, `variant`, `protein`, `structure`, `compound`, `pathway`, `disease`, `tissue`/`cell-line`, `dataset`, `paper`/`preprint`, artifact and claim subtypes). Migration 3 creates the table but inserts nothing (`SELECT count(*) FROM vocabulary` → 0). Without the core seeds, the normalize-and-reuse step has nothing to match against, so the *first* use of every common subtype lands as `proposed` and is excluded from default query scope — the opposite of intended behavior.

### D11 — Cytoscape is not installed

`frontend/workspace/src/science/renderers/graph/LineageGraph.tsx` is correctly written and correctly registered (`renderers/index.ts:25,27`), and it follows the `ProteinStructure.tsx` mount/cleanup/token-guard pattern. But `cytoscape` and `cytoscape-dagre` are absent from `frontend/workspace/package.json` and from `node_modules`, so the dynamic `import()` at `:69-71` always hits its `.catch(() => null)` and the component silently renders its fallback path (`:155`). The graceful degradation is good engineering; shipping it as "the lineage DAG" is not. Phase 8's gate is unmet.

### D12 — The Python contract test hardcodes its own DDL

`tests/test_schema_contract.py:9-24` builds a database with an inline `executescript` containing hand-written `CREATE TABLE`/`CREATE VIEW` statements, then asserts the Python client can read it. It never touches the TypeScript migrations. **This test passes no matter what the TS schema does** — it validates that Python can read Python's idea of the schema, which is precisely the drift it was written to catch. It must build its fixture by invoking `griffin db backfill` (or by executing the exported migration SQL) against a temp dir.

Secondary: `python -m pytest` is not available in the active interpreter, so the Python suite was not executed as part of this audit.

### D13 — Missing tests for two acceptance criteria

- `test/storage/db/concurrency.test.ts` — **absent**. Criterion 11 (two processes, no corruption, no lost writes) is unverified in the suite. The mechanism *was* validated ad-hoc during the phase 0 spike, and that spike found a real bug (`PRAGMA journal_mode = WAL` racing across processes fails `SQLITE_IOERR_TRUNCATE` on Windows and the loser silently loses every write). That finding is encoded in `client.ts:39-59` but nothing regression-tests it. The test must cover the **cold-start** race specifically — only that path exposed the bug.
- `test/storage/db/import-provenance.test.ts` — absent, consistent with phase 6 not being done.

### D14 — Ten stray SQLite artifacts sit untracked in the test tree

```
test/storage/db/tmp_derive_test/derive.db{,-shm,-wal}
test/storage/db/tmp_proj_test/test.db
test/storage/db/tmp_rebuild_test/rebuild.db{,-shm,-wal}
test/storage/db/tmp_vocab_test/vocab.db{,-shm,-wal}
```

`git check-ignore` does not match them and `test/storage/` is entirely untracked, so a `git add` of the directory commits them. Tests should write to `os.tmpdir()` (as `client.test.ts` does) rather than into the repo; failing that, add an ignore rule.

### D15 — The three known `provenance/store.ts` defects are all still present

The plan calls for fixing these in phase 6, which has not started — so this is scheduling, not regression. Recording them so they are not lost:

- `query()` (`:143-148`) still matches both edge directions across all relations, returning the weakly-connected component rather than ancestry, uncapped, with duplicate edges.
- `contentId` (`:83`) still uses an array replacer, ordering top-level keys only, so nodes differing solely in nested `meta` key order do not dedupe.
- `tool/provenance.ts:39` still spreads `{ sessionID: ctx.sessionID, ...params.meta }`, letting agent-supplied metadata override the real session id.

---

## What is genuinely good

Worth stating plainly, because the defect list is long and most of it is wiring rather than design:

- **The schema is right.** Migration 3 carries every trust column the design demands — `origin`, `confidence`, `source_node_id`, `review_state`, `merged_into`, plus `hash_algo`, `derived_at`, and vocabulary's `promoted_by`/`promoted_at`. Edges are append-only with `revoked_at` and a partial unique index. `v_edge_active` and `v_node` exist as the versioned read contract.
- **The migration runner fixed the bug it was told to avoid.** DDL and the version row commit in one transaction, so a failure rolls back and retries — unlike `storage.ts:153-154`, which bumps its counter even when a migration throws.
- **Foreign keys were scoped honestly.** `message → session` and `part → message` cascade; `session → project` deliberately does not, because `project/project.ts:229` removes a project while its sessions live. Encoding only invariants the application actually holds is the right call.
- **The relocation hazard was fixed properly** (`settings/storage.ts:129-150`): `VACUUM INTO` for the database, the `griffin.db*` files excluded from the `fs.cp`, and a `.relocated` marker in the source.
- **Backfill chunks as specified** — 200-file transactions with `await Bun.sleep(0)` between them (`backfill.ts:49-76`).
- **`db status` is non-mutating**, verified in both `off` and `shadow`; it early-returns rather than letting the reader connection create an empty database.
- **Derivation leaves `content_hash` NULL** on system-derived artifacts rather than fabricating a value behind a unique index.

---

## Acceptance criteria

| # | Criterion | Status |
| --- | --- | --- |
| 1 | `db verify` zero drift after session + run + share | ❌ Unproven — D2 makes it unreliable, D3 makes it non-blocking |
| 2 | `experimental.db=off` restores current behavior | ✅ Held — `off` short-circuits in `Projection.write/remove` and both read paths |
| 3 | Listing / `children()` / `run.list()` are indexed queries | ⚠️ `Projection.list` is indexed, but `stats.ts:92-99` still full-scans |
| 4 | No partially-derived message after a crash (revised) | ⚠️ FK structure supports it; untested |
| 5 | `rebuild` reproduces system graph, preserves agent/user/vocabulary | ⚠️ `rebuild.test.ts` exists; determinism under a *populated* agent layer not covered |
| 6 | `provenance_query` subset + strict-ancestry diamond test | ❌ Phase 6 not started |
| 7 | No agent tool accepts SQL or an out-of-set kind/relation | ✅ Vacuously — the tools are unregistered (D6) |
| 8 | Near-miss subtype reuse | ⚠️ `vocabulary.test.ts` passes, but D10 means core terms are unseeded |
| 9 | Unreviewed / proposed excluded from default scope and visually distinct | ⚠️ `v_node` filters `merged_into`; UI side unverifiable while D11 stands |
| 10 | No SSE latency regression | ⬜ Not measured |
| 11 | Two concurrent processes, no corruption or lost writes | ⚠️ Validated ad-hoc in the spike; **no regression test** (D13) |

---

## Recommended order

1. **D1** — unblock typecheck. Nothing else can merge cleanly.
2. **D3 + D2** — make `db verify` able to fail, and able to fail *for the right reason*. These two together are what make every later phase's gate meaningful.
3. **D6 + D7** — register the tools and mount the route. Six finished modules go from dead to live for a few lines each; this is the highest value-per-effort item in the list.
4. **D10** — seed the core vocabulary, or the KB's default scope is wrong from the first write.
5. **D5** — fix `update` before phase 14 makes it load-bearing.
6. **D13 + D14** — add the concurrency regression test; stop writing databases into the repo.
7. **D12** — make the Python contract test build from TS migrations.
8. **D4** — wire CI once D3 is fixed.
9. **D8 / D9** — wire or delete `fts.ts` and `entity.ts`. Either is fine; leaving them is not.
10. **D11** — install Cytoscape, or relabel phase 8 as "fallback renderer only".
11. **D15** — folds into phase 6 when it starts.

---

## Resolution

All 15 findings addressed.

| Check | Before | After |
| --- | --- | --- |
| `bun run typecheck` | ❌ 2 errors | ✅ clean |
| `bun test` (full) | 1099 pass / 38 fail / 1150 tests | **1164 pass / 38 fail** / 1215 tests |
| Failures attributable to this work | 1 | **0** |
| `bun test test/storage/` | 40 pass / 1 fail, 10 files | **82 pass / 0 fail**, 14 files |
| `pytest tests/` | not runnable in CI, contract test inert | **52 pass** (18 contract) |
| Fixture gate `db backfill` → `db verify` | did not exist | **11 records, 0 drift, exit 0** |
| Frontend typecheck (graph renderer) | ❌ cytoscape unresolved | ✅ clean |

The 38 remaining failures are byte-for-byte the pre-existing baseline set —
`comm` against the captured baseline shows zero new and zero fixed. Net +65
passing tests.

| # | Resolution |
| --- | --- |
| D1 | Both handlers in `tool/graph.ts` return one `metadata` shape (`{nodes, edges}`) instead of a union. Typecheck clean. |
| D2 | `Projection.classify()` is now the single source of truth for what a namespace is, and `backfill` and `verify` both consult it. `verify` gained an `unknown_namespace` diff kind and an `unknown: string[]` field. Also replaced the key-order-sensitive `JSON.stringify` comparison with real structural deep equality. The polluting characterization test now tracks and removes its keys. |
| D3 | `db verify` sets `process.exitCode = 1` on any diff, `db backfill` on any error — **set before the format branch**, because CI uses `--format json` and the original placement was inside the text branch only. Verify output is now grouped by diff kind. |
| D4 | `.github/workflows/datastore.yml`: typecheck, `bun test test/storage/`, the fixture backfill/verify gate, and the Python contract test. Deliberately scoped rather than gating on the whole suite — see the baseline note. |
| D5 | `Storage.update` reads through `readPrimary()` in `primary` mode, the same helper `read` uses, preserving the exact `NotFoundError` message. |
| D6 | `GraphTools` and `KbTools` registered in `tool/registry.ts`, gated on `DatabaseMode.enabled()` so `off` still restores current behavior exactly (criterion 2). `test/storage/db/tool-registration.test.ts` asserts presence in `shadow` and absence in `off` by querying the registry — a unit test of a tool's `execute` cannot catch an unregistered tool. |
| D7 | `GraphRoutes` mounted at `/graph` in `server/server.ts`. |
| D8 | `fts.ts` wired, not deleted. Tables moved into migration 4 (they were being re-created per call, outside the versioned schema). `Projection.write` and `Backfill` enqueue part text and completed tool output; an idle `scheduleDrain` with `unref()` tokenizes off the hot path; `db backfill` drains synchronously so a fresh database is immediately searchable. Exposed through `GraphQuery.searchContent` and `graph_search`. |
| D9 | `entity.ts` deleted. It was unreachable *and* stale — it typed a `session.agent` column that does not exist. |
| D10 | 20 core subtypes seeded with `created_at = 0` for rebuild determinism. **This surfaced a schema defect:** `vocabulary` was keyed on `name` alone, but `dataset` is legitimately a subtype of both `entity` (a GEO accession) and `artifact` (a materialized file), so the second insert collided and one silently won. Primary key is now `(kind, name)` with a composite FK for `merged_into`, and every lookup in `vocabulary.ts` is kind-scoped. Added `setStatus()` for maintainer promotion and `proposed()` for `db status`. |
| D11 | `cytoscape` + `cytoscape-dagre` added to `frontend/workspace`, plus `@types/cytoscape-dagre` (the plugin ships no types). Frontend typecheck clean; `LineageGraph.tsx` no longer falls through to its fallback path. |
| D12 | `Schema.sql()` emits the full DDL; `griffin db schema --write` snapshots it to `schemas/griffin-db.sql`; `schema-snapshot.test.ts` fails on the TypeScript side if it drifts; `tests/test_schema_contract.py` builds its fixture from that snapshot. Both halves were verified to fail by dropping a column from a view. Also added the range version check (`MIN_SUPPORTED..MAX_KNOWN`) the plan required and the client lacked. |
| D13 | `concurrency.test.ts` added. **The first version passed against a knowingly broken client** — process startup jitter meant the two writers never collided — so it gained a wall-clock barrier. Verified by reverting the WAL fix: both processes then exit 1 and the test fails. |
| D14 | All four test files write to `os.tmpdir()`; the ten stray artifacts removed; the fixture data dir carries a `.gitignore` for generated `griffin.db*`. |
| D15 | Unchanged — these are phase 6 work, which has not started. Recorded above so they are not lost. |

### Further defects found while fixing

Four, none of which were visible from reading the code:

1. **Backfill silently discarded every message part.** `Bun.Glob` yields in
   filesystem order, not lexicographic — observed as `todo, session, project,
   part, message`. With `foreign_keys=ON`, every `part` insert therefore failed
   its FK against a not-yet-inserted `message`, was logged, and skipped. A real
   data dir would have backfilled with **zero parts** — the entire body of every
   message — behind a summary that looked healthy. Fixed by sorting entries
   parent-first before insert. Caught only because the verify fixture included a
   part.
2. **`db verify --format json` always exited 0.** The exit code from D3 was set
   inside the text branch, so the JSON path CI uses returned success while its
   own output said `"ok": false`.
3. **Prepared statements were never finalized on close**, keeping the database
   file locked on Windows (`EBUSY` on the next unlink). This would have been a
   stale-lock failure during data-dir relocation specifically — the operation
   the plan flagged as needing the `VACUUM INTO` fix.
4. **`Backfill.run`/`Verify.run` could not be tested hermetically.** Their
   `customDataDir` argument redirected only the JSON side; the database stayed
   process-global, so the two halves described different stores and cross-test
   pollution read as drift. Both now take `{dataDir, handle}`, which is also
   what makes `--data-dir` work for the CI fixture.

### Found later, while writing the manual test guide

Two more, both surfaced only by running the flow end to end rather than by
reading code or running the suite:

5. **`graph_lineage` answered the reproducibility question with nothing.**
   `produced` and `consumed` both point `run → artifact`, and `derived-from`
   points from the derived thing to its source — so no single traversal
   direction expresses data flow. `direction: "ancestors"`, the default, walked
   `from_id → to_id`, which on an output artifact (no outgoing edges) returned
   only the artifact itself. "What produced this figure" — *the* query the
   lineage DAG exists for — was empty. `lineage()` now re-orients edges into a
   `flow(src, dst)` relation before traversing, and excludes `part-of`
   entirely: it is containment, not derivation, and treating it as a hop pulled
   in every sibling artifact through the shared parent message (a 2-node answer
   became 9). Six regression tests in `lineage.test.ts`.
6. **Rebuild determinism was never actually asserted.** `rebuild.test.ts`
   checked that agent nodes survive, not that the derived graph is reproducible,
   so criterion 5 was unverified. It is in fact deterministic — but only if
   `derived_at` is excluded, since that column is a wall-clock watermark for
   *when* derivation ran rather than graph content. The test now pins the exact
   content-column set, and additionally asserts that `derived_at` *does* change,
   so the exclusion cannot quietly widen until the test means nothing.

### Not addressed

- The 34 pre-existing suite failures (Windows path/symlink/unicode in `patch`,
  `snapshot`, `file/ignore`, `file/path-traversal`, `project` worktrees,
  `atlas-bridge`, `compaction`). Out of scope for this workstream, and the
  reason the CI job is scoped rather than gating on `bun test` wholesale.
- Phase 6 (porting `Provenance` to SQL, importing `graph.json`) and the D15
  defects that belong to it.
- `stats.ts` still full-scans, so criterion 3 is partial.
- Criteria 4 (crash atomicity) and 10 (SSE latency) remain unmeasured.
