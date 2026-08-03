import z from "zod"
import { Tool } from "./tool"
import { DatabaseClient } from "../storage/db/client"
import { GraphStore } from "../storage/db/graph/store"
import { Vocabulary } from "../storage/db/graph/vocabulary"
import { EntityResolver } from "../storage/db/graph/resolve"
import { Hash } from "../storage/db/hash"

export const KbAssertTool = Tool.define("kb_assert", {
  description: [
    "Assert a claim in the knowledge base.",
    "Requires a source_node_id (the paper or document you read) and a confidence score.",
    "Claims land unreviewed until audited.",
    "",
    "Pass `about` with the entities the claim concerns — otherwise the claim is only reachable",
    "from its source, and a later search starting from the gene or compound will never find it.",
  ].join("\n"),
  parameters: z.object({
    claim: z.string().describe("The assertion text"),
    source_node_id: z.string().describe("The ID of the source node read to assert this claim"),
    confidence: z.number().min(0).max(1).describe("Confidence score between 0.0 and 1.0"),
    about: z
      .array(z.string())
      .optional()
      .describe("Entity node ids this claim is about. Linked with `mentions` so traversal can reach it."),
    subtype: z.string().optional().default("assertion").describe("Subtype e.g. 'assertion' | 'hypothesis'"),
    meta: z.record(z.string(), z.any()).optional().describe("Additional structured metadata"),
  }),
  async execute(params, ctx) {
    const handle = DatabaseClient.writer()
    const payload = { claim: params.claim, source_node_id: params.source_node_id, sessionID: ctx.sessionID }
    const { hash } = Hash.contentIdV2(payload)
    const nodeId = `clm:${hash}`

    GraphStore.recordNode(handle, {
      id: nodeId,
      kind: "claim",
      subtype: params.subtype,
      label: params.claim,
      recorded_at: Date.now(),
      content_hash: hash,
      hash_algo: "sha256-16-json-v2",
      origin: "agent",
      confidence: params.confidence,
      source_node_id: params.source_node_id,
      review_state: "unreviewed",
      meta: params.meta ? JSON.stringify(params.meta) : null,
    })

    const exists = (id: string) => Boolean(handle.stmt(`SELECT 1 FROM node WHERE id = ?`).get(id))

    // Link to the source, if it is a node we know. A claim whose cited source
    // does not exist is still worth keeping — the citation lives in
    // `source_node_id` either way — but the edge would violate the FK.
    const linkedSource = exists(params.source_node_id)
    if (linkedSource) {
      GraphStore.linkEdge(handle, {
        from_id: nodeId,
        to_id: params.source_node_id,
        relation: "derived-from",
        origin: "agent",
        confidence: params.confidence,
        created_at: Date.now(),
      })
    }

    // Attach the claim to what it is about. Without this the claim hangs off
    // its source only, so a traversal that starts at the gene never reaches it
    // — the knowledge is stored but unreachable, which is the same as absent
    // for every question anyone actually asks.
    const about = params.about ?? []
    const linked = about.filter(exists)
    for (const entityId of linked) {
      GraphStore.linkEdge(handle, {
        from_id: nodeId,
        to_id: entityId,
        relation: "mentions",
        origin: "agent",
        confidence: params.confidence,
        created_at: Date.now(),
      })
    }
    const unknown = about.filter((id) => !linked.includes(id))

    const notes = [
      `Asserted \`${nodeId}\` at confidence ${params.confidence} (unreviewed).`,
      linkedSource
        ? `Linked derived-from → ${params.source_node_id}.`
        : `Source \`${params.source_node_id}\` is not a node, so no edge was made — record it with kb_entity to connect it.`,
      linked.length > 0 ? `Linked mentions → ${linked.join(", ")}.` : undefined,
      unknown.length > 0 ? `Unknown entity ids skipped: ${unknown.join(", ")}.` : undefined,
      about.length === 0
        ? "No `about` given — this claim is not reachable from any entity. Pass `about`, or use kb_link."
        : undefined,
    ].filter(Boolean)

    return {
      title: `Asserted claim: ${nodeId}`,
      output: notes.join("\n"),
      metadata: { id: nodeId, confidence: params.confidence, linked: linked.length + (linkedSource ? 1 : 0) },
    }
  },
})

export const KbEntityTool = Tool.define("kb_entity", {
  description: [
    "Resolve a biological entity to a canonical identity and record it in the knowledge base.",
    "The accession is VERIFIED against the source database (Ensembl, UniProt, ChEBI, PubMed, ...) before",
    "the entity is trusted. Give the accession if you know it, otherwise give the name and let it resolve.",
    "An entity that cannot be verified is still recorded, but stays unreviewed and out of default scope.",
  ].join("\n"),
  parameters: z.object({
    name: z.string().describe("Name or symbol of the entity, e.g. 'TP53'"),
    authority: z
      .string()
      .describe(`Accession namespace. One of: ${EntityResolver.authorities().join(", ")}`),
    accession: z
      .string()
      .optional()
      .describe("Accession in that namespace if known, e.g. 'ENSG00000141510'. Omit to resolve by name."),
    subtype: z.string().optional().describe("Entity subtype; inferred from the authority when omitted"),
  }),
  async execute(params, ctx) {
    const handle = DatabaseClient.writer()

    // Resolve rather than trust. Recording an unverified accession as
    // `accepted` puts it in default query scope looking authoritative, which
    // is the exact failure the trust columns exist to prevent — a wrong
    // identity silently merges two different things for every later query.
    const res = await EntityResolver.resolveAndRecord(handle, {
      authority: params.authority,
      query: params.accession ?? params.name,
      name: params.name,
      subtype: params.subtype,
      signal: ctx.abort,
    })

    const explain: Record<EntityResolver.Status, string> = {
      resolved: `Verified against ${params.authority} and accepted.`,
      "no-match": `${params.authority} returned no exact match. Recorded as unreviewed — check the spelling or the namespace.`,
      unavailable: `Could not reach ${params.authority}. Recorded as unreviewed and queued for retry; absence is NOT confirmed.`,
      "unknown-authority": `Unknown authority "${params.authority}". Recorded as unreviewed. Known authorities: ${EntityResolver.authorities().join(", ")}.`,
    }

    return {
      title: `Entity ${res.nodeId}`,
      output: [
        `**${params.name}** → \`${res.nodeId}\``,
        res.accession ? `accession: ${params.authority}:${res.accession}` : "accession: none",
        explain[res.status],
      ].join("\n"),
      metadata: { id: res.nodeId, status: res.status, accession: res.accession },
    }
  },
})

export const KbLinkTool = Tool.define("kb_link", {
  description: [
    "Connect two nodes in the knowledge base.",
    "Without this, entities you create are isolated and graph traversal can never reach them —",
    "so after recording an entity or a claim, link it to what it relates to.",
    "",
    "Common relations:",
    "  mentions      — this claim or source is about that entity",
    "  derived-from  — this came from that",
    "  supports      — evidence FOR a claim",
    "  refutes       — evidence AGAINST a claim",
    "  same-as       — these are the same thing (revocable)",
    "",
    "You may also name a relation of your own — 'inhibits', 'expressed-in', 'binds-to'. It is",
    "recorded as proposed and is immediately traversable. Reuse an existing name where one fits:",
    "near-identical names are merged automatically, but 'inhibits' and 'suppresses' will become two.",
    "",
    "Lineage relations (part-of, produced, consumed) are observed from what the workspace actually",
    "did and are refused — asserting one fabricates provenance. Note also that graph_lineage only",
    "follows produced/consumed/derived-from, so a semantic relation will not appear in lineage output.",
  ].join("\n"),
  parameters: z.object({
    from_id: z.string().describe("Source node id"),
    to_id: z.string().describe("Target node id"),
    relation: z
      .string()
      .describe(
        "Relation name. Reuse an existing one where it fits; a new name is accepted and recorded as proposed. " +
          "Lineage relations (part-of, produced, consumed) are reserved for observed workspace activity.",
      ),
    confidence: z.number().min(0).max(1).optional().describe("Confidence 0-1 where the link is an inference"),
    note: z.string().optional().describe("Why this link holds"),
  }),
  async execute(params) {
    const handle = DatabaseClient.writer()

    // Both endpoints must exist. A dangling edge violates the foreign key and
    // would abort the write with a raw SQL error; naming the missing node is
    // far more useful to a model that can then go create it.
    const missing = [params.from_id, params.to_id].filter(
      (id) => !handle.stmt(`SELECT 1 FROM node WHERE id = ?`).get(id),
    )
    if (missing.length > 0) {
      return {
        title: "Link failed",
        output: `No such node: ${missing.join(", ")}. Create it first with kb_entity, or check the id with graph_search.`,
        metadata: { linked: false, relation: params.relation, status: "n/a" },
      }
    }

    if (params.from_id === params.to_id) {
      return {
        title: "Link failed",
        output: "A node cannot link to itself.",
        metadata: { linked: false, relation: params.relation, status: "n/a" },
      }
    }

    // Governed, not closed: an unseen relation is minted as `proposed`, a
    // near-identical one is reused, and lineage relations are refused.
    const resolved = Vocabulary.resolveRelation(handle, params.relation, params.note)
    if (resolved.reserved) {
      return {
        title: "Link refused",
        output: [
          `\`${resolved.name}\` records what the workspace actually did and cannot be asserted —`,
          `stating it would fabricate provenance.`,
          `Use \`mentions\`, \`derived-from\`, \`supports\`, \`refutes\`, \`same-as\`, or a new relation of your own.`,
        ].join(" "),
        metadata: { linked: false, relation: resolved.name, status: "reserved" },
      }
    }

    GraphStore.linkEdge(handle, {
      from_id: params.from_id,
      to_id: params.to_id,
      relation: resolved.name,
      origin: "agent",
      confidence: params.confidence ?? null,
      created_at: Date.now(),
      meta: params.note ? JSON.stringify({ note: params.note }) : null,
    })

    const notes = [`${params.from_id} --${resolved.name}--> ${params.to_id}`]
    if (resolved.name !== Vocabulary.normalize(params.relation)) {
      notes.push(`Reused the existing relation \`${resolved.name}\` rather than creating "${params.relation}".`)
    } else if (!resolved.reused) {
      notes.push(
        `New relation \`${resolved.name}\` recorded as proposed. It is traversable now, but note that` +
          ` graph_lineage only follows produced/consumed/derived-from, so it will not appear there.`,
      )
    }

    return {
      title: `Linked ${resolved.name}`,
      output: notes.join("\n"),
      metadata: { linked: true, relation: resolved.name, status: resolved.status },
    }
  },
})

export const KbNodeTool = Tool.define("kb_node", {
  description: [
    "Create a node of any kind, for things the built-in kinds do not cover.",
    "",
    "Prefer `kb_entity` for anything with an accession (gene, protein, compound, paper) — it verifies",
    "the identity against the source database, which this cannot. Use this when you need to model",
    "something the schema has no kind for: a cohort, an experimental protocol, a hypothesis space.",
    "",
    "A new kind is accepted and recorded as proposed. Nodes land unreviewed and out of default scope",
    "until audited, so link them and give them a clear label.",
  ].join("\n"),
  parameters: z.object({
    kind: z.string().describe("Node kind. Reuse an existing one where it fits; a new name is accepted."),
    label: z.string().describe("Human-readable name for this node"),
    subtype: z.string().optional().describe("Finer classification within the kind"),
    definition: z.string().optional().describe("What this kind means, if you are introducing one"),
    meta: z.record(z.string(), z.any()).optional().describe("Additional structured fields"),
  }),
  async execute(params, ctx) {
    const handle = DatabaseClient.writer()
    const kind = Vocabulary.resolveNodeKind(handle, params.kind, params.definition)
    const subtype = params.subtype ? Vocabulary.propose(handle, params.subtype, kind.name) : undefined

    // Content-addressed on (kind, label) so re-recording the same thing in a
    // later turn converges on one node instead of accumulating duplicates.
    const { hash } = Hash.contentIdV2({ kind: kind.name, label: params.label.trim().toLowerCase() })
    const nodeId = `${kind.name.slice(0, 4)}:${hash}`

    GraphStore.recordNode(handle, {
      id: nodeId,
      kind: kind.name,
      subtype: subtype?.name ?? null,
      label: params.label,
      recorded_at: Date.now(),
      content_hash: hash,
      hash_algo: "sha256-16-json-v2",
      origin: "agent",
      review_state: "unreviewed",
      meta: params.meta ? JSON.stringify({ ...params.meta, sessionID: ctx.sessionID }) : null,
    })
    EntityResolver.recordAlias(handle, nodeId, params.label)

    const notes = [`**${params.label}** → \`${nodeId}\` [${kind.name}${subtype ? "/" + subtype.name : ""}]`]
    if (!kind.reused) notes.push(`New node kind \`${kind.name}\` recorded as proposed.`)
    else if (kind.name !== Vocabulary.normalize(params.kind))
      notes.push(`Reused the existing kind \`${kind.name}\` rather than creating "${params.kind}".`)
    notes.push("Unreviewed, so out of default query scope. Link it with kb_link so traversal can reach it.")

    return {
      title: `Node ${nodeId}`,
      output: notes.join("\n"),
      metadata: { id: nodeId, kind: kind.name, status: kind.status },
    }
  },
})

export const KbVocabularyProposeTool = Tool.define("kb_vocabulary_propose", {
  description: "Propose a new subtype classification in the knowledge base vocabulary.",
  parameters: z.object({
    subtype: z.string().describe("Proposed subtype token (e.g. 'tcr-clonotype')"),
    kind: z.enum(["entity", "source", "artifact", "claim"]).describe("Node kind this subtype applies to"),
    definition: z.string().optional().describe("Definition of the proposed subtype"),
    example_node_id: z.string().optional().describe("Optional example node id using this subtype"),
  }),
  async execute(params) {
    const handle = DatabaseClient.writer()
    const res = Vocabulary.propose(
      handle,
      params.subtype,
      params.kind,
      params.definition,
      undefined,
      params.example_node_id,
    )

    return {
      title: `Vocabulary Subtype: ${res.name}`,
      output: res.reused
        ? `Subtype "${params.subtype}" normalized and reused existing term "${res.name}" (status: ${res.status}).`
        : `Proposed new subtype "${res.name}" under kind "${params.kind}" (status: proposed).`,
      metadata: { name: res.name, status: res.status, reused: res.reused },
    }
  },
})

export const KbTools = [KbAssertTool, KbEntityTool, KbNodeTool, KbLinkTool, KbVocabularyProposeTool]
