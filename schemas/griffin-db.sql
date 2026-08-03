-- GENERATED FILE — DO NOT EDIT.
-- Source: backend/cli/src/storage/db/migrations/index.ts
-- Regenerate: cd griffin-next/backend/cli && bun run src/index.ts db schema --write
-- schema_version: 5

-- migration 1: entity_layer
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

-- migration 2: contract_views
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

-- migration 3: graph_layer
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

-- migration 4: fts
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

-- migration 5: governed_taxonomy
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
