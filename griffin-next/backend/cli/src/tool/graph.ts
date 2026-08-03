import z from "zod"
import { Tool } from "./tool"
import { DatabaseClient } from "../storage/db/client"
import { GraphQuery } from "../storage/db/graph/query"
import { GraphReasoningTools } from "./graph-reason"
import { GraphReasonTool } from "./graph-reason-tool"

export const GraphSearchTool = Tool.define("graph_search", {
  description: [
    "Search the knowledge graph and the workspace's own message history.",
    "Matches graph nodes by label, accession, or alias, and full-text-searches",
    "message and tool-output content. Use it to answer 'what do we know about X'",
    "and 'where did we see X before'.",
  ].join(" "),
  parameters: z.object({
    query: z.string().describe("Search term or accession"),
    limit: z.number().optional().default(20).describe("Max results"),
    include_content: z
      .boolean()
      .optional()
      .default(true)
      .describe("Also full-text-search message and tool-output text, not just graph nodes"),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const nodes = GraphQuery.search(handle, params.query, params.limit)
    const content = params.include_content ? GraphQuery.searchContent(handle, params.query, params.limit) : []

    if (!nodes.length && !content.length) {
      return {
        title: "Graph Search",
        output: `No nodes or message content matching "${params.query}".`,
        metadata: { nodes: 0, content: 0 },
      }
    }

    const sections: string[] = []
    if (nodes.length) {
      sections.push(
        `**Nodes** (${nodes.length}):`,
        ...nodes.map(
          (n) =>
            `- **${n.id}** [${n.kind}${n.subtype ? "/" + n.subtype : ""}] ${n.label}` +
            ` (origin: ${n.origin}, review: ${n.review_state})`,
        ),
      )
    }
    if (content.length) {
      if (sections.length) sections.push("")
      sections.push(
        `**Message content** (${content.length}):`,
        ...content.map((c) => `- ${c.type}${c.tool ? `/${c.tool}` : ""} in ${c.message_id}: ${c.snippet}`),
      )
    }

    return {
      title: `Graph Search ("${params.query}")`,
      output: sections.join("\n"),
      metadata: { nodes: nodes.length, content: content.length },
    }
  },
})

export const GraphNeighborsTool = Tool.define("graph_neighbors", {
  description: "Get 1-hop outgoing and incoming neighbor nodes and edges for a graph node.",
  parameters: z.object({
    id: z.string().describe("Target node id"),
    relation: z.string().optional().describe("Filter by edge relation"),
    kind: z.string().optional().describe("Filter neighbor node kind"),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const { nodes, edges } = GraphQuery.neighbors(handle, params.id, params.relation, params.kind)
    if (!nodes.length) {
      // Same metadata shape as the success branch — a union of shapes here is
      // what made this handler untypeable against Tool.define.
      return {
        title: "Graph Neighbors",
        output: `No neighbors for node "${params.id}".`,
        metadata: { nodes: 0, edges: 0 },
      }
    }
    const nodeRows = nodes.map((n) => `- **${n.id}** [${n.kind}] ${n.label}`)
    const edgeRows = edges.map((e) => `- ${e.from_id} --${e.relation}--> ${e.to_id}`)
    return {
      title: `Neighbors: ${params.id}`,
      output: [
        `**Nodes** (${nodes.length}):`,
        nodeRows.join("\n"),
        "",
        `**Edges** (${edges.length}):`,
        edgeRows.join("\n"),
      ].join("\n"),
      metadata: { nodes: nodes.length, edges: edges.length },
    }
  },
})

export const GraphLineageTool = Tool.define("graph_lineage", {
  description: "Retrieve strict recursive DAG ancestry or descendants for a node with depth cap.",
  parameters: z.object({
    id: z.string().describe("Node id to trace lineage for"),
    direction: z.enum(["ancestors", "descendants", "both"]).default("ancestors").describe("Lineage direction"),
    max_depth: z.number().optional().default(6).describe("Maximum recursion depth"),
  }),
  async execute(params) {
    const handle = DatabaseClient.reader()
    const { nodes, edges } = GraphQuery.lineage(handle, {
      nodeId: params.id,
      direction: params.direction,
      maxDepth: params.max_depth,
    })
    if (!nodes.length) {
      return {
        title: "Graph Lineage",
        output: `No lineage found for node "${params.id}".`,
        metadata: { nodes: 0, edges: 0 },
      }
    }
    const nodeRows = nodes.map((n) => `- **${n.id}** [${n.kind}] ${n.label}`)
    const edgeRows = edges.map((e) => `- ${e.from_id} --${e.relation}--> ${e.to_id}`)
    return {
      title: `Lineage (${params.direction}): ${params.id}`,
      output: [
        `**Nodes** (${nodes.length}):`,
        nodeRows.join("\n"),
        "",
        `**Edges** (${edges.length}):`,
        edgeRows.join("\n"),
      ].join("\n"),
      metadata: { nodes: nodes.length, edges: edges.length },
    }
  },
})

/** Stateless retrieval. The Think-on-Graph loop lives in `graph-reason.ts`. */
export const GraphRetrievalTools = [GraphSearchTool, GraphNeighborsTool, GraphLineageTool]

export const GraphTools = [...GraphRetrievalTools, ...GraphReasoningTools, GraphReasonTool]
