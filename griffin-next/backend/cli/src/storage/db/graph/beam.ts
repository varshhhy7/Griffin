import { DatabaseClient } from "../client"

/**
 * Frontier-based traversal, the substrate for Think-on-Graph style reasoning.
 *
 * Think-on-Graph (Sun et al., ICLR 2024) alternates two steps at every hop:
 * explore the *relations* leaving the current frontier, prune them, then
 * explore the *entities* those relations reach, and prune again. What makes it
 * work is that an LLM does the pruning — the graph proposes, the model
 * disposes.
 *
 * These functions are the "propose" half. The pruning half deliberately lives
 * outside: Griffin's agent already runs a tool loop with a model in it, so the
 * model can be the pruner directly, at no extra inference cost and with its
 * reasoning visible in the transcript. `graph_reason` wraps the same
 * primitives in a server-side loop for callers that want one shot.
 *
 * Everything here is bounded — frontier width, hop budget, per-call limits —
 * because an unbounded traversal over a real workspace graph will happily
 * return the whole database.
 */
export namespace Beam {
  /** Hard ceiling on frontier size, whatever a caller asks for. */
  export const MAX_FRONTIER = 64

  /** Hard ceiling on rows returned by one exploration step. */
  export const MAX_ROWS = 200

  const clamp = (n: number | undefined, fallback: number, max: number) =>
    Math.max(1, Math.min(n ?? fallback, max))

  /** Only surface nodes the workspace actually trusts, unless asked otherwise. */
  function trustFilter(includeUnreviewed: boolean, alias = "n") {
    return includeUnreviewed
      ? `${alias}.merged_into IS NULL`
      : `${alias}.merged_into IS NULL AND ${alias}.review_state != 'rejected'
         AND (${alias}.origin = 'system' OR ${alias}.review_state = 'accepted')`
  }

  export interface RelationOption {
    relation: string
    /** How many distinct nodes this relation reaches from the frontier. */
    reaches: number
    direction: "out" | "in"
    /** Node kinds on the far side, for the model to judge relevance cheaply. */
    kinds: string[]
  }

  /**
   * Step 1 of a hop: what relations leave this frontier, and where do they go?
   *
   * Returns relations rather than nodes so the model can prune a whole branch
   * before paying to expand it — the property that keeps ToG's cost sublinear
   * in graph size.
   */
  export function exploreRelations(
    handle: DatabaseClient.Handle,
    frontier: string[],
    opts: { includeUnreviewed?: boolean } = {},
  ): RelationOption[] {
    const ids = frontier.slice(0, MAX_FRONTIER)
    if (ids.length === 0) return []
    const holes = ids.map(() => "?").join(",")
    const trust = trustFilter(opts.includeUnreviewed ?? false)

    const rows = handle
      .stmt(
        `SELECT e.relation AS relation, 'out' AS direction, n.kind AS kind, count(DISTINCT n.id) AS reaches
           FROM edge e JOIN node n ON n.id = e.to_id
          WHERE e.from_id IN (${holes}) AND e.revoked_at IS NULL AND ${trust}
          GROUP BY e.relation, n.kind
         UNION ALL
         SELECT e.relation, 'in', n.kind, count(DISTINCT n.id)
           FROM edge e JOIN node n ON n.id = e.from_id
          WHERE e.to_id IN (${holes}) AND e.revoked_at IS NULL AND ${trust}
          GROUP BY e.relation, n.kind`,
      )
      .all(...ids, ...ids) as { relation: string; direction: "out" | "in"; kind: string; reaches: number }[]

    const merged = new Map<string, RelationOption>()
    for (const r of rows) {
      const key = `${r.direction}:${r.relation}`
      const existing = merged.get(key)
      if (existing) {
        existing.reaches += r.reaches
        if (!existing.kinds.includes(r.kind)) existing.kinds.push(r.kind)
        continue
      }
      merged.set(key, { relation: r.relation, direction: r.direction, reaches: r.reaches, kinds: [r.kind] })
    }
    return [...merged.values()].sort((a, b) => b.reaches - a.reaches)
  }

  export interface ExpandedNode {
    id: string
    kind: string
    subtype: string | null
    label: string
    origin: string
    review_state: string
    accession: string | null
    authority: string | null
    /** Which frontier node reached it, and how. */
    via: { from: string; relation: string; direction: "out" | "in" }
  }

  /**
   * Step 2 of a hop: expand the frontier along chosen relations.
   *
   * `via` is carried on every result so the caller can reconstruct the path
   * afterwards — a ToG answer is only trustworthy if the evidence path can be
   * shown, and reconstructing it from the graph after the fact is both slower
   * and ambiguous when several paths exist.
   */
  export function expand(
    handle: DatabaseClient.Handle,
    frontier: string[],
    opts: {
      relations?: string[]
      direction?: "out" | "in" | "both"
      kinds?: string[]
      limit?: number
      includeUnreviewed?: boolean
    } = {},
  ): ExpandedNode[] {
    const ids = frontier.slice(0, MAX_FRONTIER)
    if (ids.length === 0) return []

    const limit = clamp(opts.limit, 50, MAX_ROWS)
    const direction = opts.direction ?? "both"
    const holes = ids.map(() => "?").join(",")
    const trust = trustFilter(opts.includeUnreviewed ?? false)

    const relFilter = opts.relations?.length ? ` AND e.relation IN (${opts.relations.map(() => "?").join(",")})` : ""
    const kindFilter = opts.kinds?.length ? ` AND n.kind IN (${opts.kinds.map(() => "?").join(",")})` : ""

    const select = (side: "out" | "in") => {
      const [anchor, target] = side === "out" ? ["e.from_id", "e.to_id"] : ["e.to_id", "e.from_id"]
      return `SELECT n.id, n.kind, n.subtype, n.label, n.origin, n.review_state, n.accession, n.authority,
                     ${anchor} AS via_from, e.relation AS via_relation, '${side}' AS via_direction
                FROM edge e JOIN node n ON n.id = ${target}
               WHERE ${anchor} IN (${holes}) AND e.revoked_at IS NULL AND ${trust}${relFilter}${kindFilter}`
    }

    const parts: string[] = []
    const params: any[] = []
    const push = (side: "out" | "in") => {
      parts.push(select(side))
      params.push(...ids, ...(opts.relations ?? []), ...(opts.kinds ?? []))
    }
    if (direction === "out" || direction === "both") push("out")
    if (direction === "in" || direction === "both") push("in")

    const rows = handle.stmt(`${parts.join(" UNION ALL ")} LIMIT ?`).all(...params, limit) as any[]

    // Deduplicate on node id, keeping the first path that reached it.
    const seen = new Map<string, ExpandedNode>()
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.set(r.id, {
        id: r.id,
        kind: r.kind,
        subtype: r.subtype,
        label: r.label,
        origin: r.origin,
        review_state: r.review_state,
        accession: r.accession,
        authority: r.authority,
        via: { from: r.via_from, relation: r.via_relation, direction: r.via_direction },
      })
    }
    return [...seen.values()]
  }

  export interface Triple {
    subject: string
    relation: string
    object: string
    origin: string
    confidence: number | null
  }

  /**
   * Serialize the edges among a node set as readable triples.
   *
   * This is what the model cites in its answer. Labels rather than ids,
   * because an id is not evidence a reader can check; `origin` and
   * `confidence` ride along so an agent-asserted claim is never quoted as if
   * it were observed fact.
   */
  export function evidence(handle: DatabaseClient.Handle, nodeIds: string[], limit = MAX_ROWS): Triple[] {
    const ids = [...new Set(nodeIds)].slice(0, MAX_FRONTIER)
    if (ids.length < 1) return []
    const holes = ids.map(() => "?").join(",")

    return handle
      .stmt(
        `SELECT s.label AS subject, e.relation AS relation, o.label AS object,
                e.origin AS origin, e.confidence AS confidence
           FROM edge e
           JOIN node s ON s.id = e.from_id
           JOIN node o ON o.id = e.to_id
          WHERE e.from_id IN (${holes}) AND e.to_id IN (${holes}) AND e.revoked_at IS NULL
          ORDER BY e.relation, s.label
          LIMIT ?`,
      )
      .all(...ids, ...ids, Math.min(limit, MAX_ROWS)) as Triple[]
  }

  /**
   * Entity linking: map a natural-language question to starting nodes.
   *
   * Exact accession and alias matches first — those are identities, not
   * guesses — then fall back to label matching. ToG's quality depends heavily
   * on the topic entities it starts from, so precision matters more than
   * recall here.
   */
  export function link(
    handle: DatabaseClient.Handle,
    terms: string[],
    opts: { limit?: number; includeUnreviewed?: boolean } = {},
  ): { term: string; matches: { id: string; label: string; kind: string; exact: boolean }[] }[] {
    const limit = clamp(opts.limit, 5, 20)
    const trust = trustFilter(opts.includeUnreviewed ?? false)

    return terms.map((term) => {
      const normalized = term.toLowerCase().trim().replace(/[\s_-]+/g, " ")
      const exact = handle
        .stmt(
          `SELECT DISTINCT n.id, n.label, n.kind FROM node n
             LEFT JOIN alias a ON a.node_id = n.id
            WHERE (lower(n.accession) = lower(?) OR a.normalized = ? OR lower(n.label) = lower(?))
              AND ${trust}
            LIMIT ?`,
        )
        .all(term.trim(), normalized, term.trim(), limit) as any[]

      if (exact.length > 0) {
        return { term, matches: exact.map((m) => ({ ...m, exact: true })) }
      }

      const fuzzy = handle
        .stmt(
          `SELECT DISTINCT n.id, n.label, n.kind FROM node n
             LEFT JOIN alias a ON a.node_id = n.id
            WHERE (n.label LIKE ? OR a.normalized LIKE ?) AND ${trust}
            LIMIT ?`,
        )
        .all(`%${term.trim()}%`, `%${normalized}%`, limit) as any[]

      return { term, matches: fuzzy.map((m) => ({ ...m, exact: false })) }
    })
  }
}
