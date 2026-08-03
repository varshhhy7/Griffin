---
name: think-on-graph
description: Autonomous Think-on-Graph (ToG) reasoning engine. Performs multi-hop entity discovery, extracts new relationships from literature, asserts verified knowledge into the SQLite Knowledge Base, and auto-syncs with the Obsidian visual graph.
---

# Think-on-Graph (ToG) Skill

Use this skill whenever a user asks multi-hop reasoning questions, seeks connections between scientific entities, genes, papers, or wants to explore or expand their local Knowledge Graph.

## Workflow

### 1. Entity Resolution & Linking
- Identify the key entities, genes, proteins, or papers in the user's prompt.
- Use `graph_link` or connector searches (`science_search`) to resolve accessions (e.g. UniProt, dbSNP, PubMed IDs).
- Record exact matches into the graph database.

### 2. Multi-Hop Relation Exploration & Frontier Expansion
- Starting from the seed entity nodes, use `graph_explore_relations` to view available edge relations (`mentions`, `part-of`, `consumed`, `produced`, `supports`, `same-as`).
- Select the relevant relations and expand the frontier using `graph_expand`.
- Repeat for hop 2 and hop 3, pruning irrelevant or noisy project/session container branches.

### 3. Knowledge Extraction & Assertions
- Analyze literature results and tool outputs to identify novel factual claims, disease associations, or protein interactions.
- Record new entities using `kb_entity` (e.g. genes, compounds, pathways, phenotypes).
- Record novel assertions and claims using `kb_assert` with confidence scores and evidence citations.

### 4. Evidence Triples & Obsidian Visual Auto-Sync
- Gather citable evidence triples using `graph_evidence`.
- Format the final synthesis with clear citations.
- Execute `griffin db export-obsidian` or trigger Obsidian sync so the newly discovered entities and edges instantly render in the Obsidian Graph View.
