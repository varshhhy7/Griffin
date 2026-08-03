# Workstream 12 — manual test guide

How to check by hand that data is landing in SQLite and that the knowledge
graph works. Every command below was run before this guide was written.

All commands assume:

```bash
cd griffin-next/backend/cli
```

---

## Read this first — four things that will otherwise look broken

1. **The datastore is off by default.** Nothing is written to SQLite unless you
   set `experimental.db`. Use `GRIFFIN_DB=shadow` per-command, or put
   `{"experimental": {"db": "shadow"}}` in `~/.config/griffin/griffin.json`.
   In `shadow`, JSON stays authoritative and SQLite is populated alongside it —
   nothing you do can corrupt your existing data.

2. **The graph is not derived automatically.** Sessions and messages project
   into the entity tables on write, but nodes and edges are only built when you
   run `griffin db rebuild`. Run a session, *then* rebuild, *then* query. This
   is by design for now — derivation on the write path is phase 5 follow-up
   work.

3. **`provenance_record` does not feed the graph yet.** Phase 6 (porting
   `Provenance` onto SQL) has not started, so the three `provenance_*` tools
   still read and write `~/.local/share/griffin/provenance/graph.json`. There
   are two disconnected graphs right now. If you record provenance and then
   `graph_search` for it, you will correctly find nothing. Use `kb_entity` /
   `kb_assert` to write into the SQL graph.

4. **`primary` now refuses to read an un-backfilled database.** That is
   deliberate. Previously it returned a shorter list instead of an error, so
   records that had never been projected simply looked deleted. Run
   `griffin db backfill` before setting the mode, and check
   `griffin db status` for the `primary ready` line. `GRIFFIN_DB_SKIP_READINESS=1`
   overrides it if you genuinely want a partial database.

---

## 0. Baseline

```bash
GRIFFIN_DB=shadow bun run dev db status --format json
```

On a machine that has never had the datastore on, expect `"exists": false` and
`"schema_latest": 4`. `db status` never creates the database — that is
deliberate, so inspecting an `off` install cannot leave a schema behind.

---

## 1. Does a real session land in SQLite?

Start the app with the datastore on:

```bash
GRIFFIN_DB=shadow bun run dev
```

Have a short session that does real work — the point is to produce several part
types. Prompts that exercise the interesting paths:

```
Read package.json and tell me what the test script does.
```

```
Create a file called scratch/hello.txt containing the word "mitochondrial", then read it back.
```

```
Run: git log --oneline -3
```

Exit, then:

```bash
GRIFFIN_DB=shadow bun run dev db status --format json
```

**Expect:** non-zero `project`, `session`, `message`, `part` counts, `integrity:
"ok"`, `journal_mode: "wal"`, and `schema_version: 4`.

### The parity check that actually matters

```bash
GRIFFIN_DB=shadow bun run dev db verify --format json
```

**Expect `"ok": true`, `"diffs": []`, and exit code 0.** This deep-compares
every JSON record against its projected row. A non-zero exit means projection
missed something — that is the whole point of the command, so treat a failure
as a real defect. Check the exit code explicitly:

```bash
GRIFFIN_DB=shadow bun run dev db verify --format json > /dev/null; echo "exit=$?"
```

Diff kinds and what they mean:

| kind | meaning |
| --- | --- |
| `missing_in_db` | a JSON record never projected — a write path is bypassing projection |
| `missing_in_json` | a row with no file — usually a delete that only half-applied |
| `content_mismatch` | both exist and disagree |
| `unknown_namespace` | a namespace the projection layer was never taught about |

---

## 2. Does the graph build?

```bash
GRIFFIN_DB=shadow bun run dev db rebuild --format json
```

**Expect** non-zero `systemNodes` / `systemEdges`.

Then inspect. There is no `db query` command, so use this snippet (it opens the
same database read-only):

```bash
GRIFFIN_DB=shadow bun -e '
const {DatabaseClient}=await import("./src/storage/db/client");
const h=DatabaseClient.create(DatabaseClient.file(),{readonly:true});
const q=(s)=>JSON.stringify(h.db.query(s).all());
console.log("nodes:", q("SELECT kind, count(*) n FROM node GROUP BY kind ORDER BY kind"));
console.log("edges:", q("SELECT relation, count(*) n FROM edge WHERE revoked_at IS NULL GROUP BY relation"));
console.log("artifacts:", q("SELECT id,label FROM node WHERE kind=\"artifact\" LIMIT 10"));
h.close();'
```

**Expect** `kind` values drawn from `project | session | message | run |
artifact`, and relations from `part-of | produced | consumed`. Your
`scratch/hello.txt` should appear as an artifact.

### Rebuild determinism (acceptance criterion 5)

Run `db rebuild` twice — the graph content must be identical. `recorded_at`
comes from each message's own creation time, never `Date.now()`, which is what
makes this hold.

**Compare content columns, not `SELECT *`.** The `derived_at` column is a
wall-clock watermark recording *when* derivation ran; it necessarily changes on
every rebuild and is not part of the graph's content. A `SELECT *` hash will
differ every time and look like a failure when nothing is wrong.

```bash
GRIFFIN_DB=shadow bun -e '
const {DatabaseClient}=await import("./src/storage/db/client");
const h=DatabaseClient.create(DatabaseClient.file(),{readonly:true});
const cols="id,kind,subtype,label,recorded_at,entity_type,entity_id,content_hash,hash_algo,accession,authority,origin,confidence,source_node_id,review_state,merged_into,meta";
console.log(Bun.hash(JSON.stringify([
  h.db.query(`SELECT ${cols} FROM node ORDER BY id`).all(),
  h.db.query("SELECT from_id,to_id,relation,origin,confidence,revoked_at,meta FROM edge ORDER BY from_id,to_id,relation").all(),
])).toString());
h.close();'
```

Same hash before and after `db rebuild`.

---

## 3. Lineage — the reproducibility payoff

Take an artifact id from step 2 and ask what produced it:

```bash
GRIFFIN_DB=shadow bun -e '
const {DatabaseClient}=await import("./src/storage/db/client");
const {GraphQuery}=await import("./src/storage/db/graph/query");
const h=DatabaseClient.create(DatabaseClient.file(),{readonly:true});
const a=h.db.query("SELECT id,label FROM node WHERE kind=? LIMIT 1").get("artifact");
console.log("artifact:", a.label);
for (const dir of ["ancestors","descendants"]) {
  const r=GraphQuery.lineage(h,{nodeId:a.id,direction:dir,maxDepth:6});
  console.log(" "+dir+":", r.nodes.map(n=>n.kind+":"+n.label).join(", "));
}
h.close();'
```

**Expect** `ancestors` to name the run that produced the file (and any inputs it
derived from), and `descendants` to name whatever consumed it. If `ancestors`
returns only the artifact itself, that is the bug fixed in
`GraphQuery.lineage` — `produced` and `consumed` both point `run → artifact`,
so lineage re-orients edges into data-flow order rather than walking raw
direction. `part-of` is excluded from lineage on purpose; it is containment,
and treating it as a hop pulls in every sibling through the shared parent.

---

## 4. Agent tools — type these in a session

Start with the datastore on, then type these as prompts. All six tools are
registered **only** when `experimental.db` is not `off`.

### Full-text search over your own history

```
Use graph_search to find anything mentioning "mitochondrial".
```

**Expect** a `Message content` section quoting the snippet from the file you
created in step 1. This is FTS5 over part text and completed tool output,
indexed off the hot path.

> Indexing is deferred by ~750 ms after a write. If a search comes back empty
> immediately after a session, wait a moment and retry — that delay is the
> mechanism that keeps a multi-megabyte tool output from stalling the response
> stream.

### Neighbours and lineage

```
Use graph_neighbors on <paste an artifact id> to show me what it connects to.
```

```
Use graph_lineage on <paste an artifact id> to trace where it came from.
```

### Write to the knowledge base

```
Use kb_entity to record the gene TP53, then use kb_assert to record the claim
"TP53 is mutated in over half of human cancers" with a confidence of 0.9.
```

Then confirm it landed, and note the trust columns:

```bash
GRIFFIN_DB=shadow bun -e '
const {DatabaseClient}=await import("./src/storage/db/client");
const h=DatabaseClient.create(DatabaseClient.file(),{readonly:true});
console.log(JSON.stringify(h.db.query(
 "SELECT id,kind,subtype,label,origin,confidence,review_state FROM node WHERE origin=?").all("agent"),null,2));
h.close();'
```

**Expect** `origin: "agent"` and `review_state: "unreviewed"` — agent-asserted
knowledge is quarantined out of default query scope until reviewed. That
separation is the point of the trust columns; system-observed lineage from
step 2 carries `origin: "system"`.

### Think-on-Graph — multi-hop reasoning

The KB gets populated automatically now: every `science_search` hit is recorded
as a `source` or `entity` node keyed on its accession, linked to the message
that found it by a `mentions` edge. So run a couple of real searches first:

```
Search PubMed for TP53 mutations in cancer.
```

```
Search UniProt for TP53.
```

Then ask a question that needs more than one hop:

```
Use graph_reason to answer: which papers did this workspace look at while
researching TP53? Terms: TP53.
```

**Expect** a trace showing seeds, each hop's offered vs chosen relations, and
the evidence triples. The interesting part is hop 2 — the UniProt entity and
the PubMed papers are not directly connected; they are linked *through the
message that searched for both*. A single-hop query returns nothing useful
here.

To watch the model drive the search itself rather than using the orchestrator:

```
Using graph_link, graph_explore_relations, graph_expand and graph_evidence,
work out what this workspace knows about TP53. Show your pruning decisions.
```

**Expect** the model to link `TP53` → an entity id, ask what relations leave
it, pick `mentions` over `part-of`, expand, and cite triples. That pruning is
the whole idea of Think-on-Graph — the graph proposes candidates, the model
decides which are worth following. The orchestrated `graph_reason` does the
same thing internally at a cost of 2 model calls per hop.

> If `graph_reason` reports "could not link any terms", the KB is empty for
> that topic. Run a `science_search` first — the KB is populated from connector
> results, not from message prose.

### Obsidian visual graph

```bash
GRIFFIN_DB=shadow bun run dev db export-obsidian --format json
```

**Expect** `written` to equal the node count from step 2 exactly — one note per
node. Open the directory as an Obsidian vault and Graph View renders the same
graph the database holds. Node tags carry trust (`#origin-agent`,
`#review-unreviewed`), so you can colour by it.

Two flags worth knowing:

```bash
GRIFFIN_DB=shadow bun run dev db export-obsidian --redact
```

`--redact` titles message notes `role id`, so no conversation wording reaches
the body, heading, **or filename**. Worth it if the vault syncs to cloud
storage — note that without it, message note titles carry a 60-character prompt
snippet even though `--include-text` is off by default.

`griffin db rebuild` refreshes a vault that already exists. It will not create
one; that stays an explicit `export-obsidian`. Nothing syncs on its own.

### Vocabulary governance

```
Use kb_vocabulary_propose to propose a subtype called "HLA alleles" for entity nodes.
```

```bash
GRIFFIN_DB=shadow bun run dev db status --format json | grep -A6 proposed_vocabulary
```

**Expect** the normalized form `hla-allele` (lowercased, hyphenated,
singularized) with `status: proposed`. Propose `"HLA allele"` again and the
usage count increments rather than creating a duplicate — that is the near-miss
reuse that keeps the vocabulary from fragmenting.

Core subtypes ship seeded, so common terms are never `proposed`:

```
Use kb_entity to record the gene BRCA1.
```

Its subtype resolves to the seeded `entity/gene` (`status: core`), not a new
proposal.

---

## 5. Two processes at once

The in-process lock does not span processes; WAL plus `busy_timeout` is the
whole mechanism. Open two terminals and run a session in each against the same
data dir, then:

```bash
GRIFFIN_DB=shadow bun run dev db status --format json | grep integrity
GRIFFIN_DB=shadow bun run dev db verify --format json > /dev/null; echo "exit=$?"
```

**Expect** `"integrity": "ok"` and exit 0. Worth doing on a fresh data dir too —
two processes racing the *creation* of a new database is the case that
previously failed on Windows with `SQLITE_IOERR_TRUNCATE`, silently losing every
write from the losing process.

---

## 6. Turning it off

```bash
bun run dev db status --format json     # mode: "off"
```

With no `GRIFFIN_DB` set, behaviour is exactly as before: no projection, no
graph/KB tools offered to the model, JSON only. Your SQLite file stays on disk
untouched. Nothing in this workstream is irreversible until the JSON writer is
deleted, which has not happened.

---

## Known gaps — not bugs, just unfinished phases

| What | Why |
| --- | --- |
| `provenance_record` output never appears in `graph_search` | Phase 6 not started; provenance still lives in `graph.json` |
| Graph is stale until `db rebuild` | Derivation is not on the write path yet |
| `griffin stats` still reads every file | Not yet converted to `COUNT`/`GROUP BY` |
| No lineage UI to click through | `LineageGraph.tsx` exists and Cytoscape is installed, but no route renders it yet |
| KB density depends on `science_search` | Entities and sources come from connector results. There is no NER over message prose — deliberately: a connector hit is a resolved identity, an extracted string is a guess needing review |

---

## If something looks wrong

Fastest triage, in order:

```bash
GRIFFIN_DB=shadow bun run dev db status --format json     # mode, schema, integrity, counts
```

```bash
GRIFFIN_DB=shadow bun run dev db verify --format json     # exact drift, by kind
```

```bash
cd griffin-next/backend/cli && bun test test/storage/
```

88 tests should pass. If the suite is green but your data dir is not, the defect
is in a write path the fixture does not cover — which is exactly the signal
`db verify` exists to give, and worth reporting with the `diffs` output.
