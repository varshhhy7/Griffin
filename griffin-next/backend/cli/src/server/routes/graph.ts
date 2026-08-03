import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { DatabaseClient } from "@/storage/db/client"
import { GraphQuery } from "@/storage/db/graph/query"
import { lazy } from "@/util/lazy"

const SubgraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      subtype: z.string().nullable().optional(),
      label: z.string(),
      recorded_at: z.number(),
      origin: z.string(),
      review_state: z.string(),
      accession: z.string().nullable().optional(),
      authority: z.string().nullable().optional(),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.number(),
      from_id: z.string(),
      to_id: z.string(),
      relation: z.string(),
      origin: z.string(),
      confidence: z.number().nullable().optional(),
      created_at: z.number(),
    }),
  ),
})

export const GraphRoutes = lazy(() =>
  new Hono()
    .get(
      "/lineage/:id",
      describeRoute({
        summary: "Get lineage subgraph for a node",
        description: "Returns recursive ancestry or descendants subgraph bounded by max depth.",
        operationId: "graph.lineage",
        responses: {
          200: {
            description: "Subgraph",
            content: { "application/json": { schema: resolver(SubgraphSchema) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().min(1) })),
      validator("query", z.object({ direction: z.enum(["ancestors", "descendants", "both"]).optional(), depth: z.string().optional() })),
      async (c) => {
        const id = c.req.valid("param").id
        const direction = c.req.valid("query").direction ?? "ancestors"
        const maxDepth = parseInt(c.req.valid("query").depth ?? "6", 10)
        const handle = DatabaseClient.reader()
        const res = GraphQuery.lineage(handle, { nodeId: id, direction, maxDepth })
        return c.json(res)
      },
    )
    .get(
      "/neighbors/:id",
      describeRoute({
        summary: "Get 1-hop neighbors for a node",
        description: "Returns 1-hop connected nodes and edges bounded by relation or kind.",
        operationId: "graph.neighbors",
        responses: {
          200: {
            description: "Subgraph",
            content: { "application/json": { schema: resolver(SubgraphSchema) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string().min(1) })),
      validator("query", z.object({ relation: z.string().optional(), kind: z.string().optional() })),
      async (c) => {
        const id = c.req.valid("param").id
        const { relation, kind } = c.req.valid("query")
        const handle = DatabaseClient.reader()
        const res = GraphQuery.neighbors(handle, id, relation, kind)
        return c.json(res)
      },
    )
    .get(
      "/search",
      describeRoute({
        summary: "Search nodes",
        description: "Search nodes by keyword, accession, or label.",
        operationId: "graph.search",
        responses: {
          200: {
            description: "Matched nodes",
            content: { "application/json": { schema: resolver(z.object({ nodes: z.array(z.any()) })) } },
          },
        },
      }),
      validator("query", z.object({ q: z.string().min(1) })),
      async (c) => {
        const q = c.req.valid("query").q
        const handle = DatabaseClient.reader()
        const nodes = GraphQuery.search(handle, q)
        return c.json({ nodes })
      },
    ),
)
