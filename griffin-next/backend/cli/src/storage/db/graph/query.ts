import { FTS } from "../fts"
import { DatabaseClient } from "../client"

export namespace GraphQuery {
  export interface LineageOptions {
    nodeId: string
    direction?: "ancestors" | "descendants" | "both"
    maxDepth?: number
    limit?: number
  }

  export interface LineageResult {
    nodes: any[]
    edges: any[]
  }

  /**
   * Edges re-oriented as data flow: `src` produced or informed `dst`.
   *
   * Raw edge direction cannot be traversed uniformly, because the relations do
   * not agree on what "forward" means:
   *
   *   run --produced-->     artifact    data flows run -> artifact
   *   run --consumed-->     artifact    data flows artifact -> run  (INVERTED)
   *   x   --derived-from--> y           data flows y -> x           (INVERTED)
   *
   * Walking `from_id -> to_id` for all three — which is what "ancestors" used
   * to do — answers no real question. On an output artifact it returned only
   * the artifact itself, because an output has no outgoing edges. "What
   * produced this figure" is *the* reproducibility query, and it was returning
   * nothing by default.
   *
   * `part-of` is deliberately excluded: it is containment, not derivation.
   * Including it made a two-hop lineage query drag in the whole project
   * (session, sibling messages, every unrelated artifact) via shared parents.
   * Containment is what `neighbors()` is for.
   */
  const FLOW = /* sql */ `
    SELECT from_id AS src, to_id AS dst FROM edge WHERE relation = 'produced'      AND revoked_at IS NULL
    UNION ALL
    SELECT to_id   AS src, from_id AS dst FROM edge WHERE relation = 'consumed'    AND revoked_at IS NULL
    UNION ALL
    SELECT to_id   AS src, from_id AS dst FROM edge WHERE relation = 'derived-from' AND revoked_at IS NULL
  `

  export function lineage(handle: DatabaseClient.Handle, opts: LineageOptions): LineageResult {
    const direction = opts.direction ?? "ancestors"
    const maxDepth = opts.maxDepth ?? 6
    const limit = opts.limit ?? 500

    // ancestors: walk flow backwards (what fed into this).
    // descendants: walk it forwards (what this went on to feed).
    const step =
      direction === "ancestors"
        ? `SELECT f.src, w.depth + 1 FROM flow f JOIN walk w ON f.dst = w.id`
        : direction === "descendants"
          ? `SELECT f.dst, w.depth + 1 FROM flow f JOIN walk w ON f.src = w.id`
          : `SELECT CASE WHEN f.src = w.id THEN f.dst ELSE f.src END, w.depth + 1
             FROM flow f JOIN walk w ON (f.src = w.id OR f.dst = w.id)`

    const nodeSql = /* sql */ `
      WITH RECURSIVE
        flow(src, dst) AS (${FLOW}),
        walk(id, depth) AS (
          SELECT ?, 0
          UNION
          ${step} WHERE w.depth < ?
        )
      SELECT DISTINCT n.* FROM node n JOIN walk w ON n.id = w.id LIMIT ?
    `

    const nodes = handle.stmt(nodeSql).all(opts.nodeId, maxDepth, limit) as any[]
    if (nodes.length === 0) return { nodes: [], edges: [] }

    const nodeIds = new Set(nodes.map((n) => n.id))
    const placeholders = Array.from(nodeIds).map(() => "?").join(",")
    const edgesSql = `SELECT * FROM edge WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders}) AND revoked_at IS NULL`
    const edges = handle.stmt(edgesSql).all(...Array.from(nodeIds), ...Array.from(nodeIds)) as any[]

    return { nodes, edges }
  }

  export function neighbors(
    handle: DatabaseClient.Handle,
    nodeId: string,
    relation?: string,
    kind?: string,
    limit = 100,
  ): LineageResult {
    let edgeSql = `SELECT * FROM edge WHERE (from_id = ? OR to_id = ?) AND revoked_at IS NULL`
    const params: any[] = [nodeId, nodeId]
    if (relation) {
      edgeSql += ` AND relation = ?`
      params.push(relation)
    }
    edgeSql += ` LIMIT ?`
    params.push(limit)

    const edges = handle.stmt(edgeSql).all(...params) as any[]
    const nodeIds = new Set<string>([nodeId])
    for (const e of edges) {
      nodeIds.add(e.from_id)
      nodeIds.add(e.to_id)
    }

    const placeholders = Array.from(nodeIds).map(() => "?").join(",")
    let nodeSql = `SELECT * FROM node WHERE id IN (${placeholders})`
    if (kind) {
      nodeSql += ` AND kind = '${kind}'`
    }

    const nodes = handle.stmt(nodeSql).all(...Array.from(nodeIds)) as any[]
    return { nodes, edges }
  }

  export function search(handle: DatabaseClient.Handle, queryStr: string, limit = 50): any[] {
    const q = `%${queryStr.trim()}%`
    const sql = `
      SELECT DISTINCT n.* FROM node n
      LEFT JOIN alias a ON n.id = a.node_id
      WHERE n.label LIKE ? OR n.accession LIKE ? OR a.normalized LIKE ? OR a.alias LIKE ?
      LIMIT ?
    `
    return handle.stmt(sql).all(q, q, q.toLowerCase(), q, limit) as any[]
  }

  export interface ContentHit {
    part_id: string
    session_id: string | null
    message_id: string
    type: string | null
    tool: string | null
    snippet: string
  }

  /**
   * Full-text search over message content.
   *
   * Complements `search()`, which matches node labels, accessions and aliases —
   * i.e. things already promoted into the graph. This reaches the prose the
   * workspace actually produced, which is where most "where did I see that"
   * questions live.
   */
  export function searchContent(handle: DatabaseClient.Handle, queryStr: string, limit = 25): ContentHit[] {
    const hits = FTS.search(handle, queryStr, limit)
    if (hits.length === 0) return []

    const byId = new Map(hits.map((h) => [h.id, h.snippet]))
    const placeholders = hits.map(() => "?").join(", ")
    const rows = handle
      .stmt(`SELECT id, session_id, message_id, type, tool FROM part WHERE id IN (${placeholders})`)
      .all(...hits.map((h) => h.id)) as any[]

    // Preserve FTS rank order; the IN-clause lookup does not guarantee it.
    const order = new Map(hits.map((h, i) => [h.id, i]))
    return rows
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((r) => ({
        part_id: r.id,
        session_id: r.session_id,
        message_id: r.message_id,
        type: r.type,
        tool: r.tool,
        snippet: byId.get(r.id) ?? "",
      }))
  }
}
