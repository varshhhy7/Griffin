import z from "zod"
import { Tool } from "./tool"
import { DatabaseClient } from "../storage/db/client"
import { Beam } from "../storage/db/graph/beam"

/**
 * Think-on-Graph primitives.
 *
 * Think-on-Graph (Sun et al., ICLR 2024) alternates two steps per hop: explore
 * the relations leaving the current frontier, prune them, expand along the
 * survivors, prune again — with an LLM doing both prunings. The graph
 * proposes; the model disposes.
 *
 * Here the model prunes directly in its own agent loop rather than being
 * called recursively by a server-side orchestrator. That costs no extra
 * inference, keeps the reasoning visible in the transcript, and means a wrong
 * turn is something the user can see and correct. `graph_reason` wraps the
 * same primitives for callers who want a single call.
 */

export const GraphLinkTool = Tool.define("graph_link", {
  description: [
    "Step 1 of graph reasoning: map terms from a question to starting nodes in the graph.",
    "Pass the key entities you spotted in the question (gene symbols, accessions, file names, paper titles).",
    "Returns candidates flagged `exact` when the match is an accession or a known alias.",
    "Prefer exact matches as your starting frontier — a fuzzy match is a guess.",
  ].join("\n"),
  parameters: z.object({
    terms: z.array(z.string()).min(1).max(10).describe("Entity terms extracted from the question"),
    include_unreviewed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include unreviewed agent-asserted nodes. Default false — they are not trusted yet."),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const linked = Beam.link(handle, params.terms, { includeUnreviewed: params.include_unreviewed })
    const total = linked.reduce((n, l) => n + l.matches.length, 0)

    if (total === 0) {
      return {
        title: "Graph link",
        output: `No graph nodes match: ${params.terms.join(", ")}. The knowledge base may not cover this yet — try graph_search for message content instead.`,
        metadata: { terms: params.terms.length, matches: 0 },
      }
    }

    const lines = linked.map((l) =>
      l.matches.length === 0
        ? `- **${l.term}**: no match`
        : `- **${l.term}**:\n` +
          l.matches.map((m) => `    - \`${m.id}\` [${m.kind}] ${m.label}${m.exact ? " (exact)" : ""}`).join("\n"),
    )

    return {
      title: `Graph link (${total} candidates)`,
      output: [...lines, "", "Next: graph_explore_relations with the ids you want as your frontier."].join("\n"),
      metadata: { terms: params.terms.length, matches: total },
    }
  },
})

export const GraphExploreRelationsTool = Tool.define("graph_explore_relations", {
  description: [
    "Step 2 of graph reasoning: see which relations leave the current frontier, without expanding them.",
    "Returns each relation, its direction, how many nodes it reaches, and the kinds on the far side.",
    "Use this to PRUNE: pick only the relations that could answer the question, then call graph_expand.",
    "Looking at relations before expanding them is what keeps this cheap on a large graph.",
  ].join("\n"),
  parameters: z.object({
    frontier: z.array(z.string()).min(1).max(64).describe("Node ids currently in the beam"),
    include_unreviewed: z.boolean().optional().default(false).describe("Include unreviewed agent-asserted nodes"),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const options = Beam.exploreRelations(handle, params.frontier, {
      includeUnreviewed: params.include_unreviewed,
    })

    if (options.length === 0) {
      return {
        title: "Graph relations",
        output: "The frontier has no outgoing or incoming relations. This branch is exhausted.",
        metadata: { relations: 0 },
      }
    }

    const rows = options.map(
      (o) => `- **${o.relation}** (${o.direction}) reaches ${o.reaches} node(s) of kind: ${o.kinds.join(", ")}`,
    )
    return {
      title: `Relations from ${params.frontier.length} node(s)`,
      output: [...rows, "", "Next: graph_expand with the relations worth following."].join("\n"),
      metadata: { relations: options.length },
    }
  },
})

export const GraphExpandTool = Tool.define("graph_expand", {
  description: [
    "Step 3 of graph reasoning: expand the frontier along the relations you chose.",
    "Returns the nodes reached and, for each, which frontier node reached it and via which relation.",
    "Keep the useful ids as your next frontier and repeat, or stop and call graph_evidence to cite what you found.",
  ].join("\n"),
  parameters: z.object({
    frontier: z.array(z.string()).min(1).max(64).describe("Node ids currently in the beam"),
    relations: z.array(z.string()).optional().describe("Relations to follow. Omit to follow all."),
    direction: z.enum(["out", "in", "both"]).optional().default("both").describe("Edge direction to traverse"),
    kinds: z.array(z.string()).optional().describe("Restrict results to these node kinds"),
    limit: z.number().optional().default(25).describe("Max nodes to return (capped at 200)"),
    include_unreviewed: z.boolean().optional().default(false).describe("Include unreviewed agent-asserted nodes"),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const nodes = Beam.expand(handle, params.frontier, {
      relations: params.relations,
      direction: params.direction,
      kinds: params.kinds,
      limit: params.limit,
      includeUnreviewed: params.include_unreviewed,
    })

    if (nodes.length === 0) {
      return {
        title: "Graph expand",
        output: "No nodes reached with those relations. Try different relations, or stop here.",
        metadata: { nodes: 0 },
      }
    }

    const rows = nodes.map((n) => {
      // Trust is spelled out per row: an unreviewed agent assertion must never
      // read like an observed fact once it is in the model's context.
      const trust = n.origin === "system" ? "observed" : `${n.origin}/${n.review_state}`
      const acc = n.accession ? ` {${n.authority}:${n.accession}}` : ""
      return (
        `- \`${n.id}\` [${n.kind}${n.subtype ? "/" + n.subtype : ""}] ${n.label}${acc} — ${trust}\n` +
        `    via ${n.via.from} --${n.via.relation}(${n.via.direction})-->`
      )
    })

    return {
      title: `Expanded to ${nodes.length} node(s)`,
      output: [...rows, "", "Next: repeat with a narrowed frontier, or graph_evidence to cite."].join("\n"),
      metadata: { nodes: nodes.length },
    }
  },
})

export const GraphEvidenceTool = Tool.define("graph_evidence", {
  description: [
    "Final step of graph reasoning: serialize the relationships among the nodes you gathered, as citable triples.",
    "Each triple carries its origin and confidence — cite observed facts and agent assertions differently.",
    "Use this before answering so the answer rests on shown evidence rather than recalled context.",
  ].join("\n"),
  parameters: z.object({
    node_ids: z.array(z.string()).min(1).max(64).describe("Nodes gathered during traversal"),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const triples = Beam.evidence(handle, params.node_ids)

    if (triples.length === 0) {
      return {
        title: "Graph evidence",
        output: "No relationships exist among those nodes — they are not connected to each other.",
        metadata: { triples: 0 },
      }
    }

    const rows = triples.map((t) => {
      const trust =
        t.origin === "system"
          ? "observed"
          : `${t.origin}${t.confidence !== null && t.confidence !== undefined ? ` @${t.confidence.toFixed(2)}` : ""}`
      return `- (${t.subject}) --${t.relation}--> (${t.object})  [${trust}]`
    })

    return {
      title: `Evidence (${triples.length} triples)`,
      output: rows.join("\n"),
      metadata: { triples: triples.length },
    }
  },
})

export const GraphReasoningTools = [GraphLinkTool, GraphExploreRelationsTool, GraphExpandTool, GraphEvidenceTool]
