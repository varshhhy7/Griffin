# 12 — SQLite datastore + knowledge graph

Workstream: move all griffin-next persistence into a single local SQLite database, and build a knowledge graph over it that serves **both** as an index of what the workspace actually did (projects, sessions, messages, runs, artifacts) and as a **curated research knowledge base** (sources, claims, biological entities) the agent reads and writes.

**TL;DR:** Griffin already has a graph — `science/provenance/store.ts` defines nodes, typed edges (`produced`/`consumed`/`derived-from`/`supports`/`refutes`), content-addressed ids, and ancestry traversal. Two things make it unusable at scale: the entire graph is one JSON file loaded and rewritten on **every single write**, and it lives in a different store from sessions/messages/runs, so a graph node cannot reference the session that produced it. Meanwhile `Storage` (`src/storage/storage.ts`) is a JSON-file-per-key store whose `list()` globs the whole directory tree, offers no queries, no cross-key atomicity, and no cross-process safety. One SQLite database fixes both, and turns the provenance DAG from a notebook appendix into the substrate the agent reasons over.

Rollout is **dual-write**: JSON under the app data dir stays authoritative and untouched, SQLite is populated in shadow, and a `griffin db verify` command proves parity on real usage before anything flips. The JSON writer is removed only after that gate passes.

Two structural commitments run through the whole design:

- **Trust is a column, not a convention.** System-observed lineage and agent-asserted knowledge share one graph, separated by `origin` / `confidence` / `source_node_id` / `review_state`. Every query and every pixel filters on it.
- **Structure is closed, taxonomy is open.** Node kinds and relations are fixed in code because every query and traversal is written against them. Subtypes are rows in a `vocabulary` table the agent can extend, because no enum we write today will cover the domain.

> **Path convention.** Every `src/…` path below is relative to `griffin-next/backend/cli/`. There is no `griffin-next/src/`.
>
> **Status.** Phase 0 (build spike) and phase 1 (characterization tests) are complete. Findings that change the design are marked **[corrected]** inline and summarized under [Implementation findings](#implementation-findings).

---

## Current state

### Storage is JSON-file-per-key

`Storage` (`src/storage/storage.ts`) exposes `read` / `write` / `update` / `remove` / `list` over a key array, persisting one `.json` file per key under `Global.Path.data/storage` (`src/global/index.ts`, `Global.Path.data`, relocatable via the `config/data-location` pointer). Writes serialize behind `Lock.read` / `Lock.write`; schema evolution is a numeric `MIGRATIONS` array with the index persisted to a `migration` file.

Key namespaces in use across 16 modules:

| Key                                     | Written at                                                      |
| --------------------------------------- | --------------------------------------------------------------- |
| `["project", id]`                        | `project/project.ts:222,229,259`                                  |
| `["session", projectID, sessionID]`      | `session/index.ts:227,296,304,326`, `project/project.ts:234,245`   |
| `["message", sessionID, messageID]`      | `session/index.ts:320,336,349`, `cli/cmd/import.ts:48`             |
| `["part", messageID, partID]`            | `session/index.ts:321,366,389`, `cli/cmd/import.ts:51`             |
| `["research_run", projectID, runID]`     | `science/runs/run.ts:115,120`                                     |
| `["session_diff", sessionID]`            | `session/revert.ts:63`, `session/summary.ts:113,185`              |
| `["todo", sessionID]`                    | `session/todo.ts:28`                                              |
| `["session_share", sessionID]`           | `share/share-next.ts:80,166`                                      |
| `["permission", projectID]`              | **[corrected]** never written — read at `permission/next.ts:110`, its write at `:225` is commented out |
| `["share", id]`                          | **[corrected]** never written — read at `session/index.ts:250`, no writer anywhere; dead/legacy |

**[corrected]** Ten namespaces, not eight. The last two get no table: projection ignores both prefixes, and their existing `NotFoundError` behavior is preserved unchanged. Two further full-scan readers the table omits: `cli/cmd/stats.ts:92-99` (reads every project, then every session) and `cli/cmd/import.ts:45,48,51` — a second writer that bypasses `Session.*` entirely, which is why graph derivation must hook the projection layer rather than `session/processor.ts`.

Two further stores sit outside `Storage`: `util/jsonstore.ts` (credential files — atomic temp+rename, corruption-refusing; **out of scope**, credentials stay in files) and `science/provenance/store.ts`.

### The provenance graph is a single JSON blob

`science/provenance/store.ts` persists `{version, nodes: Record<id, Node>, edges: Edge[]}` to one file at `Global.Path.data/provenance/graph.json`. Node kinds are `artifact | run | source | claim`; relations are `produced | consumed | derived-from | supports | refutes`; ids are a 16-char sha256 prefix over the canonical node payload, so identical content dedupes.

Every mutation is `load()` → mutate → `save()`, i.e. parse and re-serialize the **whole graph** per `record()` and per `link()`. `query(id)` loads the whole graph and walks edges with an in-memory stack. `list()` returns every node.

**[corrected]** Three latent defects in this file that the port must decide about rather than inherit blindly:

- **`query()` does not do what its docstring says.** The loop at `store.ts:143-148` matches `e.to === cur || e.from === cur` across *all* relations in *both* directions, so it returns the whole weakly-connected component, not ancestry — with no depth cap and duplicate edges in the output. Decision: **fix it.** `graph_lineage` takes an explicit `direction` (`ancestors` default) and a depth cap; legacy `provenance_query` calls it with `direction:"both", depth:3`.
- **`contentId` is only shallowly canonical.** `store.ts:83` passes an array replacer to `JSON.stringify`, which orders top-level keys only — nested `meta` stays in insertion order, so "identical content dedupes" does not hold for nodes differing only in `meta` key order. Decision: **fix forward.** Add a recursive canonicalizer as `contentIdV2` and record `hash_algo` per node; do not re-hash on import, since existing ids are already in user transcripts.
- **`load()` swallows parse errors** (`:92-94`) and returns an empty graph, which the next `save()` then overwrites — silent total data loss on a corrupt file. The importer must read `graph.json` raw and hard-fail instead.

Note also that `link()` never verifies its endpoints exist, so real graphs contain dangling edges that `foreign_keys=ON` will reject on import. Drop them and report the count.

Agent access already exists: `tool/provenance.ts` defines `provenance_record` (used by all artifact agents), `provenance_query`, and `provenance_review`. `science/provenance/review.ts` models a reviewer finding as a content-addressed `claim` node carrying `{claim, issue, severity, evidence}`, linked to its target by `refutes` (defect) or `supports` (verified) — an append-only annotation that never mutates the reviewed artifact. See [11-reviewer-agent.md](11-reviewer-agent.md).

### Connectors already define the accession authorities

`science/connectors/` ships resolvers across genomics (`ensembl`, `mygene`, `ncbi-gene`, `dbsnp`, `clinvar`, `myvariant`, `gnomad`, `ucsc`), proteins (`uniprot`, `rcsb-pdb`, `pdbe`, `alphafold`, `interpro`, `sifts`), chemistry (`chebi`, `chembl`, `pubchem`, `bindingdb`, `gtopdb`, `surechembl`), pathways (`reactome`, `kegg`, `wikipathways`, `string-db`, `biogrid`, `intact`, `opentargets`), omics (`geo`, `arrayexpress`, `gtex`, `hpa`, `depmap`, `expression-atlas`, `single-cell-atlas`), and literature (`pubmed`, `crossref`, `arxiv`, `biorxiv`, `europepmc`, `openalex`, `semantic-scholar`).

This matters: entity resolution is the hardest part of a knowledge base, and Griffin already has the resolvers. The KB does not need to invent identity — it needs to key on the accessions these connectors already return.

### Message shape

`session/message-v2.ts` defines 14 part types: `text`, `reasoning`, `tool`, `file`, `patch`, `snapshot`, `agent`, `subtask`, `symbol`, `resource`, `retry`, `compaction`, `step-start`, `step-finish`.

**[corrected]** Parts are **not** written individually. `session/index.ts:388-391` wraps the part write in `createCoalescer` (`storage/coalescer.ts`) with a 250 ms debounce: only streaming `text`/`reasoning` deltas ride the timer, and every other part calls `await partWriter.flushNow(key)` at `:403`. This is good news for the port — the coalescer's flush callback *is* `Storage.write`, so a projection hook inside `Storage.write` already fires on flush rather than on push. **No coalescer changes are needed**, and the write-amplification argument for SQLite is weaker than first stated.

Two further shape facts that constrain graph derivation:

- **`FilePart` has no `path` field.** The path lives in `source: FilePartSource` (`:132-134`), a union of `FileSource`/`SymbolSource` (both have `path`) and `ResourceSource` (has only `clientName` + `uri`). Any path extractor must switch over the union.
- **No part carries a per-file content hash.** `PatchPart.hash` is a patch-level ref covering `files[]`, and `SnapshotPart.snapshot` is a snapshot ref, not a digest. Consequence: `content_hash` stays NULL on every system-derived artifact in v1 and artifact identity is path-addressed. Populating it from anything else would be a fabricated value sitting behind a unique index.

### There is no graph UI

Nothing in `frontend/` renders a graph today, and there are no graph or layout dependencies in any workspace package. The frontend is SolidJS and already mounts heavy imperative scientific viewers (`molstar`, `3dmol`, `igv`, `@rdkit/rdkit`, `pdfjs-dist`), so the pattern for embedding a canvas/WebGL library is established.

---

## What's broken / missing

1. **`list()` is a filesystem walk.** `Storage.list` globs `**/*` under the prefix directory, then string-splits every path. Session listing (`session/index.ts:296`) and `children()` (`:304`) read *every* session file to filter on one field. `research_run.list()` (`run.ts:120`) reads every run to sort by time. There is no pagination, ordering, or predicate pushdown anywhere.
2. **No queries.** "Which sessions touched file X", "which runs consumed this dataset", "find the message that produced this claim", "what do we know about TP53" — all require reading the entire store. None are expressible today.
3. **No cross-key atomicity.** Persisting one assistant turn is N separate writes (message + each part + session summary + diffs). A crash mid-turn leaves a message with half its parts and a stale summary. For a product whose stated value is reproducibility records, torn provenance is the worst failure mode available.
4. **Locks are in-process only.** `Lock` guards concurrent writes within one process. Two `griffin` processes against the same data dir — easily reachable, since the data dir is user-relocatable and shared across projects — can interleave and clobber.
5. **The provenance graph does not scale and does not join.** Whole-file rewrite per edge is O(graph) per write. Worse, a `run` node carries `sessionID` only as an untyped string inside `meta`, so there is no way to join a graph node to the session, message, or `research_run` record it refers to. The DAG can only describe what the agent explicitly narrated, never what the system observed.
6. **No knowledge base.** `source` and `claim` exist in the type union, but there is no entity model, no external accession, no aliasing, no dedupe beyond exact content hash, and no way to ask a question of accumulated research across sessions.
7. **No trust separation.** `provenance_record` lets the model write nodes with no record of who asserted them, from what source, or with what confidence. Once agent-extracted claims share a store with system-observed lineage, the audit trail is only as trustworthy as the least reliable extraction — directly at odds with the "do not fabricate" principle in the README.
8. **No vocabulary.** Node classification is a hardcoded TypeScript union. Any biological category not anticipated in code is either dropped or forced into a wrong bucket, silently.
9. **Nothing is visible.** Even today's DAG has no UI. Provenance that cannot be inspected is a claim about rigour rather than a demonstration of it.

---

## Proposed change

### One database, dual-written

A single SQLite database at `Global.Path.data/griffin.db`, following the relocatable data dir so the settings ▸ Storage pointer keeps working. `bun:sqlite` — built into the runtime, no native dependency, survives the single-binary compile. WAL mode, `foreign_keys=ON`, one long-lived writer connection.

`Storage` keeps its exact public API and gains a shadow projection. Reads continue to come from JSON, so **no downstream behavior changes during rollout**. Mode is config-gated:

| `experimental.db` | Behavior                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `off`             | Today's behavior exactly. JSON only.                                      |
| `shadow` (first)  | Write JSON **and** project into SQLite. Read from JSON. DB write failures are logged, never thrown. |
| `primary`         | Read and write SQLite. JSON writes continue as a rollback safety net.     |
| (after gate)      | JSON writer deleted; `Storage` becomes a thin façade over SQL.            |

Every entity table keeps the **full JSON payload** in a `json` column alongside extracted columns. The payload is what makes `Storage.read` byte-identical in `primary` mode and makes shadow verification a literal deep-equality check rather than a schema-mapping argument. Extracted columns exist only for indexing and joins.

### Schema — entity layer

Mechanical translation of the existing key namespaces, which are already `[type, parent, id]`.

```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY, vcs TEXT, worktree TEXT,
  created_at INTEGER, initialized_at INTEGER, json TEXT NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES session(id),
  title TEXT, agent TEXT,
  created_at INTEGER, updated_at INTEGER, json TEXT NOT NULL
);
CREATE INDEX session_project ON session(project_id, updated_at DESC);
CREATE INDEX session_parent  ON session(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL, agent TEXT, model TEXT,
  created_at INTEGER, json TEXT NOT NULL
);
CREATE INDEX message_session ON message(session_id, created_at);

CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL, tool TEXT, path TEXT,
  created_at INTEGER, json TEXT NOT NULL
);
CREATE INDEX part_message ON part(message_id, created_at);
CREATE INDEX part_tool    ON part(tool) WHERE tool IS NOT NULL;

CREATE TABLE research_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  session_id TEXT REFERENCES session(id),
  workflow_id TEXT, workflow_version TEXT, status TEXT,
  created_at INTEGER, updated_at INTEGER, json TEXT NOT NULL
);
CREATE INDEX run_project ON research_run(project_id, updated_at DESC);

CREATE TABLE session_diff  (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE todo          (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE session_share (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
```

`ON DELETE CASCADE` on message/part replaces the manual three-level delete loop at `session/index.ts:320-326`.

### Schema — graph layer

One node table serving both halves of the graph.

```sql
CREATE TABLE node (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- CLOSED: project|session|message|run|artifact|source|claim|entity
  subtype TEXT,                  -- OPEN: FK to vocabulary(name); gene, figure, review, preprint, ...
  label TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,

  entity_type TEXT,              -- pointer into the entity layer
  entity_id   TEXT,
  content_hash TEXT,             -- content-addressed dedupe (artifacts, claims)
  accession TEXT,                -- entity/source nodes: HGNC, UniProt, ChEBI, DOI, PMID, ...
  authority TEXT,                -- which namespace the accession belongs to

  origin TEXT NOT NULL,          -- 'system' | 'agent' | 'user'
  confidence REAL,               -- agent-asserted only
  source_node_id TEXT REFERENCES node(id),          -- what was read to assert this
  review_state TEXT NOT NULL DEFAULT 'unreviewed',  -- unreviewed|accepted|rejected
  merged_into TEXT REFERENCES node(id),             -- non-destructive dedupe

  meta TEXT
);
CREATE UNIQUE INDEX node_entity    ON node(entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE UNIQUE INDEX node_accession ON node(authority, accession)   WHERE accession IS NOT NULL;
CREATE INDEX node_kind    ON node(kind, subtype, recorded_at DESC);
CREATE INDEX node_origin  ON node(origin, review_state);
CREATE INDEX node_subtype ON node(subtype) WHERE subtype IS NOT NULL;

CREATE TABLE edge (
  id INTEGER PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES node(id),
  to_id   TEXT NOT NULL REFERENCES node(id),
  relation TEXT NOT NULL,        -- CLOSED, see relation catalogue
  origin TEXT NOT NULL,
  confidence REAL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  meta TEXT
);
CREATE UNIQUE INDEX edge_unique ON edge(from_id, to_id, relation) WHERE revoked_at IS NULL;
CREATE INDEX edge_out ON edge(from_id, relation) WHERE revoked_at IS NULL;
CREATE INDEX edge_in  ON edge(to_id, relation)   WHERE revoked_at IS NULL;

CREATE TABLE alias (
  node_id TEXT NOT NULL REFERENCES node(id),
  alias TEXT NOT NULL,
  normalized TEXT NOT NULL,
  source TEXT,
  PRIMARY KEY (node_id, alias)
);
CREATE INDEX alias_lookup ON alias(normalized);

CREATE TABLE vocabulary (
  name TEXT PRIMARY KEY,         -- normalized subtype token
  kind TEXT NOT NULL,            -- which node kind this subtype applies to
  status TEXT NOT NULL,          -- core | proposed | accepted | merged
  definition TEXT,               -- the agent's or maintainer's definition
  authority TEXT,                -- expected accession namespace, if any
  first_seen_node TEXT REFERENCES node(id),
  usage_count INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT REFERENCES vocabulary(name),
  created_at INTEGER NOT NULL
);
```

**`origin` / `confidence` / `source_node_id` / `review_state` are how index and curated KB share one table.** System-observed lineage ("this run produced this file") and agent-extracted assertions ("this paper claims BRAF V600E predicts response") coexist, and every query filters by trust. Without that split the KB half silently contaminates the provenance record — the single thing Griffin can least afford.

Edges are **append-only**: correction sets `revoked_at`, never `DELETE`, so the audit trail survives its own revisions. Node dedupe is `merged_into`, likewise non-destructive.

### Node kind catalogue — CLOSED

Eight kinds, fixed in code. Everything a query, traversal, trust filter, or rebuild is written against.

**Index half — `origin='system'`, derived from what the workspace did. Rebuildable from the entity layer.**

| kind | backed by | id | notable columns |
| --- | --- | --- | --- |
| `project` | `project` row | project id | worktree, vcs |
| `session` | `session` row | session ULID | title, agent, parent |
| `message` | `message` row | message ULID | role (`user` / `assistant`), agent, model |
| `run` | `part` where `type='tool'`, **or** a `research_run` row | part id / `run_…` id | tool, status, parameters |
| `artifact` | `part` of `file`/`patch`/`snapshot`, or run inputs/outputs | sha256[:16] of content | path, size, content_hash |

**Knowledge-base half — `origin='agent'` or `'user'`. Not rebuildable. Always carries provenance columns.**

| kind | id | notable columns |
| --- | --- | --- |
| `source` | accession, else content hash | title, authors, year, venue, url, accession, authority |
| `claim` | content hash | text, confidence, source_node_id, review_state; reviewer findings are `subtype='review'` |
| `entity` | accession | canonical name, accession, authority, subtype, aliases |

Per the owner decision, **every user message and every assistant message is a node**. `tool` parts become `run` nodes; `file`/`patch`/`snapshot` parts become `artifact` nodes.

**Deliberately not nodes:** `text` and `reasoning` parts, and the remaining part types (`agent`, `subtask`, `symbol`, `resource`, `retry`, `compaction`, `step-start`, `step-finish`), plus todos, session diffs, shares, permissions, and credentials. They stay as entity rows — queryable, joinable, full-text searchable — but nothing traverses them. This is what keeps a session in the low thousands of nodes rather than the hundreds of thousands, and no query we want is lost by it. If that judgment turns out wrong, `db rebuild` re-derives the index half under a different policy.

### Relation catalogue — CLOSED

The five relations already in `provenance/store.ts`, plus three.

| relation | from → to | origin | meaning |
| --- | --- | --- | --- |
| `part-of` | session→project, message→session, run→message, run→session | system | containment; scopes every traversal |
| `produced` | run → artifact | system | this execution emitted this artifact |
| `consumed` | run → artifact, run → source | system | this execution read this input |
| `derived-from` | artifact→artifact, message→message, claim→source | mixed | lineage |
| `mentions` | message/source/claim → entity | agent | entity occurrence |
| `supports` | source/artifact/claim → claim | agent | evidence for |
| `refutes` | source/artifact/claim → claim | agent | evidence against |
| `same-as` | entity→entity, source→source | agent/user | dedupe merge; revocable |

`mentions` is load-bearing: it is the bridge between the index half and the KB half, and the reason "which of my sessions touched BRAF" and "which paper backs this claim" are the same query shape.

Reviewer findings need no new machinery. `review.ts` already records a finding as a content-addressed `claim` linked by `refutes` or `supports`; under this schema it gains `subtype='review'`, `origin='agent'`, and a `source_node_id`.

### Open vocabulary — how the agent extends the taxonomy

No enum written today will cover life sciences. Epitope, HLA allele, TCR clonotype, assay, antibody clone, cell-surface marker — the list is open by nature, and a closed enum means the agent either drops the information or forces it into a wrong bucket. So **`subtype` is a row in `vocabulary`, not a TypeScript union**, and the agent can propose new ones.

The line is drawn deliberately:

| Layer | Agent may create? | Rationale |
| --- | --- | --- |
| Entity **instances** | Yes (already) | That is what `kb_entity` does |
| **Subtypes** | **Yes, governed** | The domain is open; a closed enum is silently lossy |
| Node **kinds** | **No** | Every query, traversal, rebuild, and trust filter is written against them |
| **Relations** | **No** | An invented relation is invisible to every existing query: the graph looks fine and quietly under-returns |

**The escape hatch for relations already exists in the schema — it is the `claim` node.** When the agent wants to express something the relation vocabulary cannot ("TP53 expression correlates with response in this cohort"), it records a claim with a source, a confidence, and a review state, linked by `supports`/`refutes`. That is strictly better than minting an edge: an edge is structural and implicitly trusted, a claim is an assertion that carries its own evidence and can be reviewed or refuted. Letting the model create relations lets it create structure it never has to justify. Claims make it justify.

Governance for proposed subtypes, so the vocabulary does not drift into `gene` / `Gene` / `genes` / `gene-symbol`:

1. **Normalize before insert** — lowercase, singularize, hyphenate. Then fuzzy-match against existing `vocabulary` rows; above threshold, reuse the existing subtype and tell the model what it actually got. This alone removes most drift, mechanically, with no human in the loop.
2. **New subtypes land as `status='proposed'`**, and every node using one inherits `review_state='unreviewed'` — captured, never lost, but excluded from default query scope and dimmed in the UI until accepted.
3. **Promotion to `accepted`** on maintainer review, or automatically once N distinct nodes use it without rejection.
4. **Merging is `merged_into`**, never `DELETE` — the same non-destructive rule as `same-as` edges and `revoked_at`.
5. **`griffin db status` lists proposed subtypes by usage count**, so drift is visible rather than silent. A proposed subtype with 200 nodes and no review means either accept it or fix the resolver.

Seed vocabulary (`status='core'`), with the connector that resolves each:

| kind | subtype | authority | connector |
| --- | --- | --- | --- |
| entity | `gene` | HGNC, Ensembl `ENSG…`, NCBI Gene | `ensembl`, `mygene`, `ncbi-gene` |
| entity | `variant` | dbSNP `rs…`, ClinVar `VCV…`, HGVS | `dbsnp`, `clinvar`, `myvariant`, `gnomad` |
| entity | `protein` | UniProt | `uniprot`, `interpro`, `sifts` |
| entity | `structure` | PDB ID, AlphaFold model | `rcsb-pdb`, `pdbe`, `alphafold` |
| entity | `compound` | ChEBI, ChEMBL, PubChem CID | `chebi`, `chembl`, `pubchem`, `bindingdb` |
| entity | `pathway` | Reactome `R-HSA-…`, KEGG, WikiPathways | `reactome`, `kegg`, `wikipathways` |
| entity | `disease` | MeSH, MONDO, EFO | `opentargets`, `eutils` |
| entity | `tissue` / `cell-line` | GTEx, HPA, DepMap | `gtex`, `hpa`, `depmap` |
| entity | `dataset` | GEO `GSE…`, ArrayExpress `E-MTAB-…` | `geo`, `arrayexpress` |
| source | `paper`, `preprint`, `dataset-record` | PMID, DOI, arXiv, OpenAlex `W…` | `pubmed`, `crossref`, `biorxiv`, `arxiv`, `openalex`, `semantic-scholar` |
| artifact | `dataset`, `figure`, `model`, `report` | — | today's `artifactType` |
| claim | `assertion`, `review`, `hypothesis` | — | `review` is `review.ts`'s finding |

An external dataset and its local copy are distinct: the GEO record is a `source` with a `GSE…` accession; the materialized file is an `artifact` with a content hash, linked `derived-from`.

### Retrieval

FTS5 (built in, no dependency) over `part` text content, `claim` text, `source` titles/abstracts, and `alias`. External-content tables so text is not duplicated.

Embeddings are **deliberately deferred**. `sqlite-vec` is a loadable extension and loading extensions from a compiled Bun binary is a real deployment problem. When needed: store vectors as `BLOB` and brute-force cosine in TypeScript, which is fine to roughly 50k vectors at zero deployment cost, and revisit only if that ceiling is hit.

### Agent surface

Existing tools keep their signatures and are re-backed by SQL: `provenance_record`, `provenance_query`, `provenance_review` (`tool/provenance.ts`). `Provenance.query(id)`'s in-memory stack walk becomes a `WITH RECURSIVE` CTE with a depth cap.

New read-only tools: `graph_search` (FTS + accession/alias resolution), `graph_neighbors` (one hop, filtered by relation and kind), `graph_lineage` (recursive ancestry, depth-capped).

New write tools: `kb_assert` (a claim, requiring `source_node_id` and confidence), `kb_entity` (resolve-or-create against an accession), `kb_vocabulary_propose` (a new subtype with a definition and an example node).

**The model never gets raw SQL.** Message and document content are untrusted input; a SQL surface over the user's entire research record is a prompt-injection target with the whole knowledge base behind it. Fixed, parameterized tools only, all reads scoped to the current project unless explicitly widened.

### Entity resolution

The genuinely hard part, and the reason the KB half is riskier than the index half. `TP53` / `p53` / `ENSG00000141510` must collapse to one node or the KB degrades into noise within a few sessions.

Canonical `entity` nodes are keyed on `(authority, accession)`, enforced by `node_accession`. The `alias` table carries normalized surface forms; `same-as` edges record merges. The agent never mints an entity freely — `kb_entity` resolves against the connectors under `science/connectors/`, and on failure creates the node with `accession=NULL`, `review_state='unreviewed'`, queued for the review gate in `science/provenance/review.ts` and excluded from default query scope.

### Migration and verification

DB schema evolution gets its **own** `schema_migrations` table — do not overload the numeric counter in `Storage`, which tracks JSON directory layout and has different semantics.

New commands:

- `griffin db status` — mode, schema version, row counts, size, WAL state, **proposed vocabulary by usage count**, unreviewed node count.
- `griffin db backfill` — idempotent import of the existing JSON tree and `provenance/graph.json`.
- `griffin db verify` — deep-compare every JSON key against its row; report drift by namespace.
- `griffin db rebuild` — drop and re-derive the graph layer from the entity layer. **System-origin nodes only**; agent- and user-origin nodes and the vocabulary are preserved, since they are not derivable.

`rebuild` being possible for the index half and impossible for the curated half is the clearest statement of the difference between the two.

---

## Visualization

Obsidian-style force-directed graph is the wrong **primary** view. It is ambient decoration: it photographs well and collapses into a hairball past a few hundred nodes. With message-level nodes a project reaches tens of thousands, and a spring simulation over that answers no question a researcher actually has.

Views in order of value:

1. **Lineage DAG — layered, left to right.** Provenance is a DAG: inputs → run → outputs. A Sugiyama/dagre layout renders that as a readable pipeline; force-directed renders the same data as spaghetti. Click any figure, see every input, checksum, parameter, and run that produced it. **This is the reproducibility payoff. If only one view ships, this is it.**
2. **Entity page — not a drawing at all.** Canonical name, accession, aliases, every session that mentioned it, claims for and against with confidence and review state, sources. The highest-value KB surface, and it is a wiki page backed by four queries.
3. **Ego expansion — focus + context.** Start at one node, show N hops, expand on click. Maps exactly onto the depth-capped recursive CTE, so the backend is already the right shape.
4. **Session timeline.** Messages and runs are temporal; a time axis beats a spring layout for "what happened here".
5. **Global force view — last, heavily filtered.** If the Obsidian-style overview is wanted, restrict it to `entity` and `source` nodes. That is a few hundred nodes, exactly the range where force layout is pleasant.

**Trust must be visually unmistakable.** A `claim` with `confidence=0.6` and `review_state='unreviewed'` must not render like a system-observed `produced` edge. Distinct stroke, distinct fill, explicit badge; unreviewed nodes dimmed or hidden by default behind a toggle; proposed-vocabulary subtypes marked. This is the UI expression of the "do not fabricate" principle — getting it wrong produces a prettier graph that quietly launders speculation into fact.

Library, given SolidJS and the existing `molstar`/`igv`/`3dmol` precedent for mounting imperative viewers: **Cytoscape.js + cytoscape-dagre**, framework-agnostic, canvas, strong layered and force layouts, comfortable to ~5k nodes; it covers views 1 and 3. Views 2 and 4 are plain Solid components with no graph library. Sigma.js v3 + graphology is the upgrade path for view 5 (WebGL, 100k+ nodes, weak DAG layouts); ELK.js is the upgrade path if dagre's layered output is not clean enough (layout-only, run in a worker). React Flow and Reaflow are React-only and do not fit.

**Animation:** spend the frame budget on motion that means something — children easing out from their parent on expand, a path highlight animating along edges when tracing lineage, a layout morph when switching views. Skip ambient force-settling jiggle: highest cost, lowest information. Respect `prefers-reduced-motion`; disable animation entirely above ~1k rendered nodes.

**The architectural constraint that makes all of this cheap:** traversal happens in SQL and the server returns a **bounded subgraph**. The browser never receives the whole graph. Every view stays fast regardless of database size, and the UI decision does not block phases 1–4.

---

## Phasing

| Phase | Scope | Gate |
| --- | --- | --- |
| 1 | DB bootstrap: connection, WAL, `schema_migrations`, entity-layer DDL, `griffin db status` | Schema reviewed |
| 2 | Shadow writes from `Storage`, `db backfill`, `db verify` | `verify` clean on real usage |
| 3 | Graph layer DDL + seed `vocabulary`; system-origin nodes/edges derived from sessions, messages, runs, artifacts; port `Provenance` onto SQL; migrate `graph.json` | `db rebuild` reproduces the index graph deterministically |
| 4 | Read path: recursive CTE traversal, FTS5, read-only agent tools | Traversal correctness tests |
| 5 | Lineage DAG view (Cytoscape + dagre) | Trust encoding visible and tested |
| 6 | Curated KB: `kb_assert`, `kb_entity`, `kb_vocabulary_propose`, entity resolution, review gate | Review gate blocks unresolved entities and proposed subtypes from default scope |
| 7 | Entity page + ego expansion | — |
| 8 | Flip `primary`; soak; then delete the JSON writer | Owner sign-off |

Phases 1–7 are reversible at any point by setting `experimental.db=off`. Phase 8 is the only irreversible step.

---

## Risks

**Streaming-write regression.** `Storage.write(["part", ...])` (`session/index.ts:389`) fires continuously during a response, and `bun:sqlite` is synchronous — a fat transaction blocks the event loop and stalls SSE to the browser. Mitigation: WAL, one writer connection, batch part flushes into a single short transaction per step, keep every transaction well under a frame. This is the most likely performance regression and it is designed for in phase 2, not discovered in phase 8.

**Dual-write divergence.** Shadow mode drifts silently if a write path is missed. Mitigation: shadow writes go through the single `Storage` chokepoint, never around it; `db verify` is the acceptance gate and runs in CI against a fixture data dir.

**Graph bloat from message-level nodes.** Every user and assistant message becoming a node multiplies node count against the old artifact-only DAG. Mitigation: parts stay out except `tool`/`file`/`patch`/`snapshot`; traversal is depth-capped and relation-filtered; `db rebuild` re-derives under a different policy if the granularity proves wrong.

**Vocabulary drift.** An open subtype vocabulary grows without bound and fragments into near-duplicates. Mitigation: normalization plus fuzzy-match-and-reuse on insert; `proposed` status excluded from default scope; `merged_into` for non-destructive collapse; `db status` surfaces high-usage unreviewed subtypes so drift is visible rather than silent. Accepted residual cost: the vocabulary needs periodic maintainer attention, and this design makes that a visible chore rather than an invisible one.

**Poisoned provenance from agent extraction.** Wrong auto-extracted claims are worse than wrong chat messages because they look like a record. Mitigation: `origin`/`confidence`/`source_node_id` mandatory on agent writes; `review_state` defaults to `unreviewed`; `provenance_review` and the reviewer gate from [11](11-reviewer-agent.md) operate on the same rows; default query scope excludes unreviewed agent claims.

**Entity-resolution errors compound.** A bad `same-as` merge corrupts every downstream query. Mitigation: merges are edges and `merged_into` pointers, not destructive rewrites, so they are revocable.

**Trust laundering in the UI.** A graph that renders agent speculation identically to system-observed lineage is actively worse than no graph, because it lends unearned authority. Mitigation: trust encoding is an acceptance criterion for phase 5, not a polish item.

**Single database as a single point of failure.** One corrupt file replaces many independently-corruptible small ones. Mitigation: WAL plus `PRAGMA integrity_check` on boot; JSON retained as a rebuild source through phase 8; `db backfill` remains available afterward as a recovery path from an export.

**Data-dir relocation.** Settings ▸ Storage can move `Global.Path.data` at runtime. Mitigation: the DB path derives from `Global.Path.data`, and relocation must close, move, and reopen the connection — an explicit test case, since a half-moved WAL set is unrecoverable.

---

## Acceptance criteria

1. `griffin db verify` reports zero drift across every key namespace after a full session, a research run, and a share, on a data dir that began as JSON-only.
2. `experimental.db=off` restores current behavior exactly; no code path outside `storage/` and `science/provenance/` is aware SQLite exists.
3. Session listing, `children()`, and `research_run.list()` are single indexed queries — no full-store reads.
4. **[corrected]** After a crash the DB never contains a partially-derived message: no message node without its part nodes, no edge with a missing endpoint, no `derived_at` watermark ahead of the rows it describes. Enforced structurally by `foreign_keys=ON` plus `edge.from_id/to_id REFERENCES node(id)`.
   *Was: "one assistant turn commits in one transaction". Turn-level atomicity is not achievable without restructuring `session/processor.ts` and is explicitly out of scope — writes at `:177`–`:562` interleave with awaits on the model stream (a write transaction held across a multi-minute turn pins the WAL and blocks every other writer), `SessionSummary.summarize` at `:388-391` is deliberately fire-and-forget, and the coalescer flushes from `setTimeout` outside any turn call stack. `griffin db verify` reconciles.*
5. `griffin db rebuild` reproduces the system-origin graph byte-identically and preserves every agent-origin node, user-origin node, and vocabulary row.
6. **[corrected]** For a fixture graph, `provenance_query(id)` returns a subset of the legacy output with no duplicate edges, and the tool description matches its behavior. A separate test asserts `graph_lineage(direction:'ancestors')` returns strict ancestry on a diamond fixture.
   *Was: "returns the same lineage as the JSON implementation". Preserving a function whose docstring and behavior disagree — see the `query()` defect above — would defeat the point of the migration.*
7. No agent tool accepts SQL, a node `kind`, or a `relation` outside the closed sets. Every graph write from a model carries `origin='agent'`, a `source_node_id`, and a confidence.
8. A subtype proposed by the agent that normalizes to an existing vocabulary row reuses it rather than creating a duplicate, verified by a fixture test over known near-miss pairs.
9. Nodes with `review_state='unreviewed'` and subtypes with `status='proposed'` are excluded from default query scope and visually distinct in every view that renders them.
10. Streaming a long response shows no measurable SSE latency regression against `experimental.db=off`.
11. Two concurrent `griffin` processes against one data dir do not corrupt the DB or lose writes.

---

## Decisions — resolved

1. **Which view ships first** — the **lineage DAG**. It carries the reproducibility payoff and needs nothing from the KB half. The entity page follows; it is a plain Solid component over four queries with no graph library, so it is cheap once the read path exists.
2. **Auto-promotion for proposed subtypes** — **hybrid.** Auto-promote `proposed` → `accepted` once **10 distinct nodes** use a subtype with zero rejections, *and* allow maintainer promote/reject at any time from `griffin db status`. Auto-promotion writes `promoted_by='auto'` + `promoted_at` so a wrong resolver promoted by sheer repetition stays traceable and is reversible via `merged_into`.
3. **`db verify` in CI** — **yes**, against a committed fixture data dir: `db backfill` → `db verify` → assert zero drift. This is the only mechanism that catches a new `Storage` write path silently skipping projection, which is the most likely way shadow mode rots.
4. **Python CLI shares the database** — **yes**, reversing this doc's original recommendation. Contained by a strict contract: **read-only** (`mode=rw` + `PRAGMA query_only=1`, *not* `mode=ro`, which cannot create the `-shm` file and fails `SQLITE_CANTOPEN` against a WAL DB with no live writer); never creates the file; a **range** version check (`MIN_SUPPORTED <= actual <= MAX_KNOWN`, not equality, or every TS migration breaks Python instantly); and the contract is a set of **versioned views** (`v_session`, `v_message`, `v_research_run`, `v_node`, `v_edge_active`) rather than physical tables, so tables can be refactored freely. TypeScript owns every migration. If Python ever needs to write, it shells out to the `griffin` binary or POSTs the local server.

---

## Implementation findings

Recorded as phases complete. These supersede the design text above where they conflict.

### Phase 0 — build spike: **passed**

Bun 1.3.14, win32 x64, against a minimal reproduction of `script/build.ts:158-181`.

- `bun:sqlite` survives `Bun.build({conditions:["browser"], compile:{target:"bun-windows-x64"}})` with **both** a static and a dynamic import; both binaries compile clean and run. **The planned lazy dynamic import is unnecessary** — `bun:` builtins bypass export-condition resolution under a `bun-*` compile target. Use a plain static import in `client.ts`; the one-match `guard.test.ts` remains the real protection against the frontend ever reaching it via `"exports": {"./*": "./src/*.ts"}`.
- WAL, transactions, and prepared statements all work in the compiled binary.
- **FTS5 is compiled into `bun:sqlite`** — `CREATE VIRTUAL TABLE … USING fts5` plus `MATCH` both work. Phase 9 needs no extension loading, which also confirms the decision to defer `sqlite-vec` (a *loadable* extension, and therefore a genuine deployment problem) was drawing the line in the right place.
- **WAL setup order matters, and getting it wrong loses writes.** Two processes racing `PRAGMA journal_mode = WAL` fail on Windows with `SQLITE_IOERR_TRUNCATE` (errno 1546): the pragma takes a momentary exclusive lock and a `busy_timeout` issued *after* it does not cover it. Observed directly — one process exited 1 and lost all 500 of its writes. Required open sequence in `client.ts`: (1) `busy_timeout` **first**; (2) **read** `journal_mode` and only write `= WAL` when it is not already `wal`, since the setting is persistent in the file header and steady state must never contend; (3) on failure re-read (a peer may have just set it) and retry with backoff; (4) then `synchronous`, `foreign_keys`, and the rest. With that sequence: cold start with two processes racing creation → 1000/1000 rows, both exit 0, `integrity_check` ok; warm start with three processes × 500 writes × three rounds → 1500/1500 every round. **This validates acceptance criterion 11 ahead of schedule**, and `db/concurrency.test.ts` must cover the *cold-start* race specifically, since only that path exposed the bug.

### Phase 1 — characterization tests: **done**

`test/storage/storage.test.ts` (14 tests) pins current `Storage` behavior before the projection lands. There was no `test/storage/` and no coverage of `storage.ts` at all. Contracts now locked:

- `read` of a missing key throws `NotFoundError` with the exact message `Resource not found: <absolute .json path>`; `primary` mode must reproduce the message even though it touches no file.
- `update` of a missing key throws and does **not** upsert.
- `write` persists `JSON.stringify(value, null, 2)` and creates intermediate directories.
- `remove` of a missing key is a silent no-op.
- `list` returns full key arrays, recurses the whole subtree, and returns `[]` for a nonexistent prefix.
- **`list` ordering is comma-joined array sort, not path-separator sort.** `result.sort()` coerces each key array via `toString()`, joining on `,` (0x2C); joining on `path.sep` instead (`\` 0x5C, `/` 0x2F) reorders the results, because `,` sorts below `-` (0x2D) while both separators sort above it. `MessageV2.lastID` (`message-v2.ts:926-937`) takes `list[length-1]` as the maximum message id and caches it, so a reordering here silently corrupts new-message id generation. **A `primary` implementation must reproduce this sort in JS and must not push `ORDER BY` into SQL**, whose BINARY collation would order by the raw joined string. The test asserts both the correct order and that the path-sep order differs.
- Generated identifiers contain no comma (base62 + `_` + hex), which is what makes the comma-join order well-defined in the first place.

**Baseline recorded before any source change:** the suite is *not* green on this branch — 34 failures across 7 files (`patch`, `snapshot`, `file/ignore`, `file/path-traversal`, `project` worktrees, `server/atlas-bridge`, `session/compaction`), all in Windows path/symlink/unicode territory and none touching `storage/`. Pre-existing and out of scope for this workstream, but it means "the suite passes" is not a usable gate here; every phase compares against this list instead.

### Phase 2 — DB bootstrap: **done**

New modules under `src/storage/db/`: `mode.ts`, `client.ts`, `schema.ts`, `migrations/index.ts`; plus `src/cli/cmd/db.ts` (registered at `src/index.ts`) and `experimental.db` in `config/config.ts`. 20 new tests. Mode stays `off` — nothing projects yet.

- **`mode.ts` resolves the flag without importing Config.** `config/config.ts:22` imports `Instance`, which reaches `Project`, which imports `Storage`, so a `Storage -> Config` edge would close a cycle. It reads `GRIFFIN_DB`, then `experimental.db` from the config file directly, then defaults to `off`. Config still declares the flag, because the top-level schema is `.strict()` and an undeclared key is a validation error.
- **Two connections, not one.** A slow lineage CTE from a server route must not block the streaming part writer; WAL gives concurrent readers for free. Read-only is `PRAGMA query_only = 1` on a read-write connection, *not* `mode=ro` — the latter cannot create the `-shm` file and fails `SQLITE_CANTOPEN` against a WAL database with no live writer. The Python client must do the same.
- **Prepared statements must be finalized before close.** Found by a failing test: leaving cached statements outstanding keeps the file locked on Windows and surfaces as `EBUSY` on the next unlink. This would have been a stale-lock bug in data-dir relocation specifically, which is the phase 3 fix — worth noting as a case where the cheap test paid for itself.
- **Foreign keys are deliberately partial.** `message -> session` and `part -> message` take `ON DELETE CASCADE` (write order is guaranteed, and the cascade is what replaces the silent-partial-failure delete loop at `session/index.ts:312-333`). `session -> project` does **not**: `project/project.ts:229` removes a project row while its sessions may still exist, so a `NO ACTION` constraint would make projection throw on a normal operation. `session.parent_id` likewise. SQLite cannot `ALTER TABLE ADD CONSTRAINT`, so this constrains only what is demonstrably true today; the graph layer takes full referential integrity in phase 5, which is where criterion 4 actually lives.
- **The migration runner writes its version row inside the same transaction as the DDL.** SQLite has transactional DDL, so a failure rolls back and retries on next boot. Tested directly, because the equivalent code at `storage.ts:153-154` bumps its counter even when the migration throws and therefore skips it permanently. There is also a contiguity guard, so a renumbered or dropped migration fails loudly instead of silently skipping schema.
- **`griffin db status` is non-mutating**, verified in both `off` and `shadow`: it early-returns when the file is absent rather than letting the reader connection create an empty database that the migration runner would later find schema-less.
