/**
 * Database schema migrations.
 *
 * Deliberately separate from the `MIGRATIONS` array in `storage/storage.ts`,
 * which versions the JSON *directory layout* and has different semantics — and
 * a bug worth not copying: `storage.ts:153-154` bumps its counter even when a
 * migration throws, so a failed migration is permanently skipped. Here the
 * version row is written inside the same transaction as the DDL, so a failure
 * rolls back and retries on next boot.
 *
 * Rules:
 *  - Append only. Never edit or renumber a shipped migration.
 *  - `id` is the ordering key and must be contiguous from 1.
 *  - SQLite has transactional DDL; rely on it rather than writing down grades.
 */
export type Migration = {
  id: number
  name: string
  sql: string
}

/**
 * Entity layer. A mechanical translation of the existing key namespaces, which
 * are already shaped `[type, parent, id]`.
 *
 * Every table keeps the FULL JSON payload in a `json` column alongside the
 * extracted columns. The payload is what makes `Storage.read` byte-identical in
 * `primary` mode and makes `db verify` a literal deep-equality check rather
 * than an argument about schema mapping. Extracted columns exist only for
 * indexing and joins — they are never the source of truth.
 *
 * Note: `["permission", projectID]` and `["share", id]` get no table. The
 * former is never written (its writer at permission/next.ts:225 is commented
 * out); the latter has no writer anywhere. Projection ignores both prefixes.
 *
 * On foreign keys — deliberately partial, and this is a judgement call:
 *
 *  - `message -> session` and `part -> message` DO get FKs with ON DELETE
 *    CASCADE. Write order is guaranteed (a session row exists before any of its
 *    messages, in `Session.create`, in `cli/cmd/import.ts:45-51`, and in
 *    backfill), and the cascade is what replaces the manual three-level delete
 *    loop at `session/index.ts:312-333`.
 *  - `session -> project` does NOT. `project/project.ts:229` removes a project
 *    row while its sessions may still exist, so a NO ACTION constraint would
 *    make projection throw on a perfectly normal operation. Adding it would
 *    encode an invariant the application does not actually hold.
 *  - `session.parent_id` does NOT, for the same reason in reverse: a child
 *    session can outlive its parent.
 *
 * SQLite cannot ALTER TABLE ADD CONSTRAINT, so getting this wrong means a table
 * rebuild later — hence constraining only what is demonstrably true today. The
 * graph layer (phase 5) takes full referential integrity, which is where
 * acceptance criterion 4 actually lives.
 */
const entity: Migration = {
  id: 1,
  name: "entity_layer",
  sql: /* sql */ `
    CREATE TABLE project (
      id             TEXT PRIMARY KEY,
      vcs            TEXT,
      worktree       TEXT,
      created_at     INTEGER,
      initialized_at INTEGER,
      json           TEXT NOT NULL
    );

    -- No 'agent' column: Session.Info (session/index.ts:51-88) has no such
    -- field, contrary to the DDL sketch in the design doc. Its real shape is
    -- slug / directory / version, and 'agent' lives on messages.
    CREATE TABLE session (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      parent_id   TEXT,
      title       TEXT,
      slug        TEXT,
      directory   TEXT,
      version     TEXT,
      created_at  INTEGER,
      updated_at  INTEGER,
      archived_at INTEGER,
      json        TEXT NOT NULL
    );
    CREATE INDEX session_project ON session(project_id, updated_at DESC);
    CREATE INDEX session_parent  ON session(parent_id) WHERE parent_id IS NOT NULL;

    CREATE TABLE message (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      role       TEXT,
      agent      TEXT,
      model      TEXT,
      created_at INTEGER,
      json       TEXT NOT NULL
    );
    CREATE INDEX message_session ON message(session_id, created_at);

    CREATE TABLE part (
      id         TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT,
      type       TEXT,
      tool       TEXT,
      path       TEXT,
      created_at INTEGER,
      json       TEXT NOT NULL
    );
    CREATE INDEX part_message ON part(message_id);
    CREATE INDEX part_tool    ON part(tool) WHERE tool IS NOT NULL;
    CREATE INDEX part_path    ON part(path) WHERE path IS NOT NULL;

    CREATE TABLE research_run (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL,
      session_id       TEXT,
      workflow_id      TEXT,
      workflow_version TEXT,
      status           TEXT,
      created_at       INTEGER,
      updated_at       INTEGER,
      json             TEXT NOT NULL
    );
    CREATE INDEX run_project ON research_run(project_id, updated_at DESC);
    CREATE INDEX run_session ON research_run(session_id) WHERE session_id IS NOT NULL;

    CREATE TABLE session_diff  (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE todo          (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE session_share (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
  `,
}

/**
 * Versioned read contract.
 *
 * These views — not the physical tables — are what the Python CLI
 * (`griffin/storage/`) is allowed to depend on. Views are free, live in
 * TypeScript-owned schema, and let the tables above be refactored without
 * touching Python. `v_edge_active` arrives with the graph layer.
 */
const views: Migration = {
  id: 2,
  name: "contract_views",
  sql: /* sql */ `
    CREATE VIEW v_project AS
      SELECT id, vcs, worktree, created_at, initialized_at FROM project;

    CREATE VIEW v_session AS
      SELECT id, project_id, parent_id, title, slug, directory, version,
             created_at, updated_at, archived_at
      FROM session;

    CREATE VIEW v_message AS
      SELECT id, session_id, role, agent, model, created_at FROM message;

    CREATE VIEW v_research_run AS
      SELECT id, project_id, session_id, workflow_id, workflow_version, status,
             created_at, updated_at
      FROM research_run;
  `,
}

const graph: Migration = {
  id: 3,
  name: "graph_layer",
  sql: /* sql */ `
    CREATE TABLE node (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      subtype         TEXT,
      label           TEXT NOT NULL,
      recorded_at     INTEGER NOT NULL,

      entity_type     TEXT,
      entity_id       TEXT,
      content_hash    TEXT,
      hash_algo       TEXT,
      accession       TEXT,
      authority       TEXT,

      origin          TEXT NOT NULL,
      confidence      REAL,
      source_node_id  TEXT REFERENCES node(id),
      review_state    TEXT NOT NULL DEFAULT 'unreviewed',
      merged_into     TEXT REFERENCES node(id),
      derived_at      INTEGER,

      meta            TEXT
    );
    CREATE UNIQUE INDEX node_entity    ON node(entity_type, entity_id) WHERE entity_id IS NOT NULL;
    CREATE UNIQUE INDEX node_accession ON node(authority, accession)   WHERE accession IS NOT NULL;
    CREATE INDEX node_kind    ON node(kind, subtype, recorded_at DESC);
    CREATE INDEX node_origin  ON node(origin, review_state);
    CREATE INDEX node_subtype ON node(subtype) WHERE subtype IS NOT NULL;

    CREATE TABLE edge (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id    TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
      to_id      TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
      relation   TEXT NOT NULL,
      origin     TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      meta       TEXT
    );
    CREATE UNIQUE INDEX edge_unique ON edge(from_id, to_id, relation) WHERE revoked_at IS NULL;
    CREATE INDEX edge_out ON edge(from_id, relation) WHERE revoked_at IS NULL;
    CREATE INDEX edge_in  ON edge(to_id, relation)   WHERE revoked_at IS NULL;

    CREATE TABLE alias (
      node_id    TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
      alias      TEXT NOT NULL,
      normalized TEXT NOT NULL,
      source     TEXT,
      PRIMARY KEY (node_id, alias)
    );
    CREATE INDEX alias_lookup ON alias(normalized);

    -- Keyed on (kind, name), not name alone.
    --
    -- A subtype belongs to a node kind — that is what the 'kind' column means.
    -- The seed set below has 'dataset' under both 'entity' (a GEO accession)
    -- and 'artifact' (a materialized local file), and the design doc is
    -- explicit that those are different things. With 'name' as the sole primary
    -- key the second insert collides with the first and one of the two
    -- silently wins, mis-typing every node that uses it.
    CREATE TABLE vocabulary (
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL,
      definition      TEXT,
      authority       TEXT,
      first_seen_node TEXT REFERENCES node(id),
      usage_count     INTEGER NOT NULL DEFAULT 0,
      promoted_by     TEXT,
      promoted_at     INTEGER,
      merged_into     TEXT,
      created_at      INTEGER NOT NULL,
      PRIMARY KEY (kind, name),
      -- Merges only ever happen within a kind.
      FOREIGN KEY (kind, merged_into) REFERENCES vocabulary(kind, name)
    );
    CREATE INDEX vocabulary_status ON vocabulary(status, usage_count DESC);

    -- Core vocabulary, shipped with the schema.
    --
    -- created_at is 0 rather than a runtime timestamp so a rebuilt database is
    -- byte-identical (acceptance criterion 5). Every authority named here is
    -- resolved by a connector that already exists under science/connectors/.
    INSERT INTO vocabulary (kind, name, status, definition, authority, created_at) VALUES
      ('entity','gene','core','A gene locus.','HGNC',0),
      ('entity','variant','core','A sequence variant.','dbSNP',0),
      ('entity','protein','core','A protein product.','UniProt',0),
      ('entity','structure','core','An experimental or predicted 3D structure.','PDB',0),
      ('entity','compound','core','A chemical compound.','ChEBI',0),
      ('entity','pathway','core','A biological pathway.','Reactome',0),
      ('entity','disease','core','A disease or phenotype.','MONDO',0),
      ('entity','tissue','core','A tissue or anatomical structure.','GTEx',0),
      ('entity','cell-line','core','An immortalized cell line.','DepMap',0),
      ('entity','dataset','core','An external dataset accession.','GEO',0),
      ('source','paper','core','A peer-reviewed publication.','PMID',0),
      ('source','preprint','core','A preprint.','DOI',0),
      ('source','dataset-record','core','An external dataset record.','GEO',0),
      ('artifact','dataset','core','A materialized local dataset file.',NULL,0),
      ('artifact','figure','core','A generated figure or plot.',NULL,0),
      ('artifact','model','core','A trained or fitted model.',NULL,0),
      ('artifact','report','core','A generated report or document.',NULL,0),
      ('claim','assertion','core','A factual assertion with evidence.',NULL,0),
      ('claim','review','core','A reviewer finding. See science/provenance/review.ts.',NULL,0),
      ('claim','hypothesis','core','A proposed but untested explanation.',NULL,0);

    CREATE VIEW v_node AS
      SELECT id, kind, subtype, label, recorded_at, accession, authority, origin, review_state
      FROM node WHERE merged_into IS NULL;

    CREATE VIEW v_edge_active AS
      SELECT id, from_id, to_id, relation, origin, confidence, created_at
      FROM edge WHERE revoked_at IS NULL;
  `,
}

/**
 * Full-text search.
 *
 * FTS5 is compiled into `bun:sqlite` (verified in the phase 0 build spike), so
 * this needs no loadable extension — which is exactly why `sqlite-vec` and
 * embeddings stay deferred: those *are* loadable extensions, and loading one
 * from a compiled single-file binary is a real deployment problem.
 *
 * Population is deferred through `fts_queue` rather than written inline. A
 * large tool output (a multi-megabyte `bash` result) tokenizes synchronously,
 * and bun:sqlite is synchronous, so indexing on the hot path would block the
 * event loop mid-stream and stall SSE to the browser. The writer enqueues a
 * row; an idle drain does the tokenizing in bounded slices.
 */
const fts: Migration = {
  id: 4,
  name: "fts",
  sql: /* sql */ `
    CREATE TABLE fts_queue (
      id        TEXT PRIMARY KEY,
      kind      TEXT NOT NULL,
      text      TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX fts_queue_order ON fts_queue(queued_at);

    -- 'id' and 'kind' are UNINDEXED: stored, but not tokenized, so the index
    -- holds only genuinely searchable text.
    CREATE VIRTUAL TABLE fts_part USING fts5(id UNINDEXED, kind UNINDEXED, text);
  `,
}

/**
 * Governed relations and node kinds.
 *
 * The original design closed both: an invented relation was said to be
 * invisible to every query, so the graph would look fine and quietly
 * under-return. That is no longer true. `Beam.exploreRelations` and
 * `Beam.expand` group by `edge.relation` generically, so a new relation is
 * traversable the moment it exists; only `graph_lineage` is relation-specific,
 * and that is deliberate — lineage means data flow, and a semantic relation
 * has no business in it.
 *
 * What remains is drift: left alone a model will mint `gene_of`, `hasGene` and
 * `relates-to` for one idea. That is the same problem the subtype vocabulary
 * already solves, so relations and kinds move into the same table and inherit
 * the same governance — normalize, fuzzy-match-and-reuse, land as `proposed`,
 * auto-promote on use, merge non-destructively, surface in `db status`.
 *
 * They live under reserved pseudo-kinds so no real node kind can collide with
 * them. `status='core'` marks the ones shipped in code.
 */
const taxonomy: Migration = {
  id: 5,
  name: "governed_taxonomy",
  sql: /* sql */ `
    INSERT INTO vocabulary (kind, name, status, definition, created_at) VALUES
      -- Node kinds. Closed in practice for the system half (derivation writes
      -- exactly these), open for anything the agent needs to model.
      ('@node-kind','project','core','A workspace project.',0),
      ('@node-kind','session','core','A conversation session.',0),
      ('@node-kind','message','core','A single user or assistant message.',0),
      ('@node-kind','run','core','A tool execution.',0),
      ('@node-kind','artifact','core','A file produced or consumed by a run.',0),
      ('@node-kind','source','core','An external record: paper, preprint, dataset.',0),
      ('@node-kind','entity','core','A real-world thing with an accession.',0),
      ('@node-kind','claim','core','An assertion carrying evidence and a confidence.',0),

      -- Relations. 'reserved' means system-observed: derivation may write them,
      -- an agent may not, because asserting them fabricates provenance.
      ('@relation','part-of','reserved','Containment: run -> message -> session -> project.',0),
      ('@relation','produced','reserved','A run created this artifact.',0),
      ('@relation','consumed','reserved','A run read this artifact.',0),
      ('@relation','derived-from','core','Lineage: this came from that.',0),
      ('@relation','mentions','core','This references that entity or source.',0),
      ('@relation','supports','core','Evidence for a claim.',0),
      ('@relation','refutes','core','Evidence against a claim.',0),
      ('@relation','same-as','core','These are the same thing. Revocable.',0);
  `,
}

export const MIGRATIONS: Migration[] = [entity, views, graph, fts, taxonomy]
