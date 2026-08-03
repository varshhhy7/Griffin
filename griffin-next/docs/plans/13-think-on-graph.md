# 13 — Think-on-Graph over the knowledge graph

Adds LLM-guided multi-hop reasoning on top of the datastore built in
[12-sqlite-knowledge-graph.md](12-sqlite-knowledge-graph.md).

## Context

Workstream 12 built a **labeled property graph** and three stateless retrieval
tools — `graph_search`, `graph_neighbors`, `graph_lineage`. That is a store and
a lookup surface, not a reasoning method. Questions that need several hops
("which papers did we read while investigating the gene behind last week's
figure?") cannot be expressed as one lookup, and a fixed-policy recursive CTE
answers them badly: it either returns too little (one relation) or drags in the
whole component (all relations).

**Think-on-Graph** (Sun et al., ICLR 2024) is the missing layer. It is an
inference-time algorithm, not a data model: the LLM performs beam search over
the graph, alternating *relation exploration* and *entity exploration*, pruning
at each step, and stopping when the retrieved paths suffice. The graph proposes
candidates; the model decides which are worth following.

These are not competing choices. ToG needs a graph underneath, and an LPG is
the standard substrate for it — the original work runs against Freebase and
Wikidata, both LPG-shaped. Nothing from workstream 12 is displaced.

---

## What was missing

| ToG requires | Before |
| --- | --- |
| Entity linking from the question | Partial — `graph_search` did FTS + accession/alias |
| Relation exploration over a frontier | Missing — `graph_neighbors` returns nodes and edges mixed, one node at a time |
| Frontier expansion along chosen relations | Missing |
| LLM pruning at each hop | Missing |
| Beam state across hops | Missing — every tool call was stateless |
| Sufficiency check | Missing |
| Path → citable evidence | Missing |
| **Anything to traverse** | **The KB half was effectively empty** |

The last row mattered most. `entity`, `source`, and `claim` nodes were only
created by explicit `kb_*` calls, so on a real workspace the curated half of
the graph held almost nothing. Beam search over an empty KB is a correct
implementation of nothing.

---

## Change

### 1. Populate the KB from connector results

Every `science_search` hit is now recorded as a node keyed on its accession,
and linked to the message that surfaced it by a `mentions` edge
(`storage/db/graph/ingest.ts`, wired into `tool/science.ts`).

This is the cheapest honest way to get density. The alternative — NER over
message prose — guesses at identity and needs a reviewer for every guess. A
connector hit does not: **the accession came back from the authority itself**,
so identity is already resolved. The agent was doing these lookups anyway; the
only thing missing was recording them.

Nodes land `origin='system'` / `review_state='accepted'` because the identity
was *observed* from an authoritative source rather than asserted by the model.
What the model chose was the query, and that judgement is captured as the
`mentions` edge — which is also the bridge that makes "which of my sessions
touched BRAF" and "which paper backs this claim" the same query shape.

Accessions are persisted into the tool part's metadata so `db rebuild` can
re-derive these nodes offline. Without that, rebuild — which wipes and
re-derives the system half — would silently delete the entire connector-sourced
knowledge base.

### 2. Real entity resolution

`storage/db/graph/resolve.ts` was a stub that regex-matched the input string
and marked the result `accepted`. Its pattern `[A-Z0-9_-]+` matched anything,
so `BANANA` became an accepted HGNC gene, and unresolved terms got a
`Date.now()` + random id so ten mentions of one entity produced ten nodes.

It now calls the connectors, and distinguishes four outcomes:

| Status | Meaning |
| --- | --- |
| `resolved` | An **exact** accession or title match. Only this yields `accepted`. |
| `no-match` | The authority was reached and had nothing. |
| `unavailable` | The authority could not be reached. **Absence is unproven** — queued for retry. |
| `unknown-authority` | Not a namespace we can resolve. |

The `no-match` / `unavailable` split is load-bearing. Several connectors
swallow network errors and return `[]`, which makes "does not exist" and "the
network was down" indistinguishable at the connector boundary. Recording the
second as the first would mint a permanently-wrong node during any outage, and
it would never be retried because the graph would look settled.

Exactness matters too: connector search is relevance-ranked, so `hits[0]`
exists for almost any query. Accepting it unconditionally is precisely how
`BANANA` became a gene.

### 3. Beam primitives

`storage/db/graph/beam.ts` — the "propose" half of ToG, all bounded:

- `link(terms)` — entity linking. Exact accession/alias matches first; fuzzy
  matches returned but flagged, since ToG's answer quality depends heavily on
  its starting entities.
- `exploreRelations(frontier)` — which relations leave the frontier, their
  direction, reach, and target kinds. Returns *relations, not nodes*, so a
  branch can be pruned before paying to expand it. This is what keeps cost
  sublinear in graph size.
- `expand(frontier, relations)` — the next frontier, each node carrying `via`
  (which frontier node reached it, by which relation). Reconstructing the path
  afterwards is ambiguous when several exist.
- `evidence(nodeIds)` — relationships among a node set as citable triples, with
  `origin` and `confidence` attached.

Every function filters on trust by default: unreviewed agent assertions are
excluded unless explicitly requested, and rejected nodes always are.

### 4. Two ways to run the loop

**Model-driven** (`tool/graph-reason.ts`): `graph_link`,
`graph_explore_relations`, `graph_expand`, `graph_evidence`. The model prunes
in its own agent loop. No extra inference cost, and the reasoning is visible in
the transcript, so a wrong turn is something the user can see and correct.

**Orchestrated** (`storage/db/graph/reason.ts` + `tool/graph-reason-tool.ts`):
`graph_reason` runs the whole loop server-side, pruning with a small model.
Costs 2 model calls per hop, hence `depth` defaults to 2 rather than the
paper's 3.

The pruning callback is **injected**, not imported. That keeps the search logic
testable without a model or a network, keeps the storage layer free of a
dependency on the provider stack, and lets the same engine back a cheaper
heuristic pruner (`passthroughPruners`) as a fallback when a model call fails
mid-search — a partial traversal is still useful; an exception is not.

It returns **evidence, not an answer**. The calling model already has the
question and the conversation; making it write the answer from cited triples
keeps reasoning in one place and avoids paying twice for generation.

---

## Defences against a model in the loop

The pruner is an LLM, so its output is untrusted input:

- Relation names not in the offered set are **discarded**, never passed to SQL.
- Node ids not among the actual candidates are discarded.
- An empty or unparseable choice **falls back to everything available** rather
  than ending the search — a model returning nothing must not read as "no
  answer exists" when none was looked for.
- Visited nodes are excluded from expansion. Without this the beam oscillates:
  A reaches B, B reaches A, and a bidirectional walk burns its whole depth
  budget ping-ponging across one edge while reporting "depth limit" as though
  more graph existed.
- Depth ≤ 5, width ≤ 16, frontier ≤ 64, rows ≤ 200 — enforced in the engine,
  not the tool schema, so no caller can raise them.

---

## Verification

`bun test test/storage/db/{beam,reason,ingest,resolve}.test.ts` — 65 tests
covering entity linking precision, the no-match/unavailable split, trust
filtering, revoked-edge exclusion, hallucinated relations and node ids,
oscillation, cap enforcement, KB survival across `db rebuild`, and a full
question → link → explore → prune → expand → evidence traversal.

End-to-end on a fixture workspace that searched UniProt and PubMed:

```
seeds : Cellular tumor antigen p53
hop 1: offered [mentions] -> reached 1, kept assistant m1
hop 2: offered [mentions, part-of] -> reached 4,
       kept p53 mutations across human cancers | Restoring p53 function in tumours | …
```

The UniProt entity and the PubMed papers are not directly connected — they are
linked *through the message that searched for both*. That is the multi-hop
answer a single lookup cannot produce, and the reason this layer exists.

---

## Limits, stated plainly

- **ToG pays off on a dense KB.** Griffin's system half is a provenance DAG:
  shallow, three lineage relations, sparse by nature. The interesting
  traversals run through the KB half, whose density is proportional to how much
  the workspace actually searched. A workspace that has run no `science_search`
  has nothing to reason over.
- **No NER over message prose.** Deliberate — see above. It means an entity
  discussed but never looked up is invisible to the graph.
- **The orchestrator's cost is real.** 2 model calls per hop. Prefer the
  primitives, or `graph_search`/`graph_neighbors` for single-hop questions.
- **`same-as` merges are not followed transitively** during expansion. Nodes
  merged via `merged_into` are excluded, but a chain of `same-as` edges is
  traversed one hop at a time like any other relation.
