---
name: think-on-graph
description: Multi-hop reasoning over the local knowledge graph. Links a question to entities, explores and prunes relations hop by hop, asserts verified knowledge into the SQLite knowledge base, and can export the graph to an Obsidian vault.
category: Research & Knowledge Graph
tags:
  - knowledge-graph
  - reasoning
  - literature
  - obsidian
---

# Think-on-Graph

Use this when a question needs **more than one hop** through the knowledge
graph: connections between genes, proteins, papers and prior sessions, or
"what do we already know about X".

For a single lookup, don't use this — `graph_search` (nodes plus full-text over
message content) or `graph_neighbors` (one hop) are cheaper and enough.

Requires `experimental.db` to be `shadow` or `primary`. When it is `off` none
of these tools exist.

## Loop

The graph proposes candidates; **you prune them**. That pruning is the whole
method — following every relation is just a graph walk and returns noise.

### 1. Link

Pull the concrete entities out of the question — gene symbols, accessions,
file paths, paper titles — and call `graph_link`.

Prefer matches flagged `exact` (an accession or a known alias) as your starting
frontier. A fuzzy match is a guess, and a guess at hop 0 propagates through
every later hop.

If nothing links, the knowledge base does not cover the topic yet. Run a
`science_search` first — the KB is populated from connector results, and every
hit is recorded automatically as a `source` or `entity` node.

### 2. Explore relations

Call `graph_explore_relations` with the frontier. It reports each relation, its
direction, how many nodes it reaches and the kinds on the far side — **without
expanding them**, so you can discard a whole branch before paying for it.

Relations currently in the graph:

| relation | meaning |
| --- | --- |
| `mentions` | a message referenced an entity or source — the bridge between session history and the knowledge base |
| `produced` | a tool run created an artifact |
| `consumed` | a tool run read an artifact |
| `derived-from` | lineage; also links a claim to its source |
| `part-of` | containment (run → message → session → project) |

`part-of` is containment, not knowledge. Following it usually drags in every
sibling of a shared parent. Prune it unless the question is about workspace
history.

### 3. Expand

Call `graph_expand` with the relations worth following. Each result carries
`via` — which frontier node reached it, by which relation — so the path is
already recorded.

Keep the useful ids as your next frontier and repeat. Two hops answers most
questions; three is usually the point of diminishing returns.

### 4. Assert what you learned — and connect it

- `kb_entity` — record an entity. The accession is **verified against the
  source database** before it is trusted. Give the accession if you know it,
  otherwise the name and let it resolve. An entity that cannot be verified is
  still recorded, but stays unreviewed and out of default scope.
- `kb_assert` — record a claim. Requires a `source_node_id` and a confidence.
  **Pass `about` with the entity ids the claim concerns.** Claims always land
  `unreviewed`.
- `kb_link` — connect two nodes.
- `kb_node` — create a node of a kind the schema does not have (a cohort, a
  protocol, an assay). Prefer `kb_entity` for anything with an accession, since
  only that verifies identity.
- `kb_vocabulary_propose` — only when no existing subtype fits.

**You can extend the schema.** Relations, node kinds and subtypes are all open:
name one that does not exist and it is recorded as `proposed` and is usable
immediately. `inhibits`, `expressed-in`, `binds-to`, a `cohort` kind — all fine.

Reuse an existing name where one fits. Near-identical spellings are merged for
you (`Inhibits`, `inhibit`, `inhibts` all become `inhibit`), but `inhibits` and
`suppresses` will become two separate relations and nothing will notice. Check
what exists with `graph_explore_relations` before inventing.

Two limits:

- **Lineage relations are refused.** `part-of`, `produced` and `consumed`
  record what the workspace actually did. Asserting one fabricates provenance,
  and it would appear in lineage output indistinguishable from an observed
  edge.
- **A new relation will not appear in `graph_lineage`**, which follows data
  flow only. It is fully traversable by `graph_explore_relations` and
  `graph_expand`.

**A node you do not link is a node nobody will find.** Traversal is the only
way anything reaches a claim or an entity, so an unlinked node is stored but
invisible to every later question — the same as not storing it. After recording
an entity, link it to the claims, sources and other entities it relates to.

The lineage relations (`part-of`, `produced`, `consumed`) are observed from what
the workspace actually did and cannot be asserted — a model writing those would
be fabricating provenance.

If you need a relationship the five above cannot express — "TP53 expression
correlates with response in this cohort" — record it as a **claim** with
`kb_assert`, and link the claim to the entities involved. A claim carries its
source, its confidence and its review state; an edge is structural and
implicitly trusted. Making the assertion justify itself is the point.

### 5. Cite

Call `graph_evidence` with everything you gathered. It returns triples with
`origin` and `confidence`.

**Cite observed facts and agent assertions differently.** A triple marked
`observed` came from the workspace or an authority. One marked `agent` is
something a model previously asserted, possibly this one. Never present the
second as established fact.

## Shortcut

`graph_reason` runs this whole loop server-side and returns the evidence. It
costs 2 model calls per hop, so prefer driving the loop yourself unless you
want a single call. It returns evidence, not a conclusion — you still write the
answer.

## Obsidian export

`griffin db export-obsidian` writes the graph as a Markdown vault for Obsidian's
Graph View.

This is **not automatic** — it is a command someone runs. Offer it when the user
asks to see the graph; do not claim the vault updates on its own.

Useful flags: `--redact` keeps conversation wording out of the vault entirely
(notes are titled `role id`), `--include-text` inlines full message bodies (off
by default, since vaults get synced to cloud storage).
