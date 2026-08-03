import { DatabaseClient } from "../client"
import { Beam } from "./beam"
import { Log } from "../../../util/log"

/**
 * Server-orchestrated Think-on-Graph.
 *
 * Runs the full beam search in one call: link the question to topic entities,
 * then per hop explore the relations leaving the frontier, prune them, expand,
 * prune the resulting entities, and check whether the evidence is sufficient.
 *
 * The pruning callback is injected rather than imported. Three reasons:
 * the search logic stays testable without a model or a network; the storage
 * layer does not acquire a dependency on the provider stack; and the same
 * engine backs both the orchestrated tool and any future caller that wants a
 * cheaper heuristic pruner.
 *
 * Cost is 1 + 2·depth model calls, which is why `depth` defaults to 2 rather
 * than the paper's 3.
 */
export namespace GraphReason {
  const log = Log.create({ service: "storage.db.graph.reason" })

  /** Chooses which relations to follow, given the question and the options. */
  export type RelationPruner = (input: {
    question: string
    hop: number
    options: Beam.RelationOption[]
  }) => Promise<string[]>

  /** Chooses which reached nodes stay in the beam, and whether to stop. */
  export type EntityPruner = (input: {
    question: string
    hop: number
    candidates: Beam.ExpandedNode[]
    width: number
  }) => Promise<{ keep: string[]; sufficient: boolean }>

  export interface Pruners {
    relations: RelationPruner
    entities: EntityPruner
  }

  export interface Options {
    question: string
    /** Topic entities extracted from the question. */
    terms: string[]
    depth?: number
    width?: number
    includeUnreviewed?: boolean
  }

  export interface Hop {
    hop: number
    relationsOffered: string[]
    relationsChosen: string[]
    reached: number
    kept: { id: string; label: string; kind: string }[]
  }

  export interface Result {
    /** Nodes the question linked to. Empty means the KB does not cover it. */
    seeds: { id: string; label: string; kind: string; exact: boolean }[]
    hops: Hop[]
    /** Every node visited, in visit order. */
    visited: string[]
    triples: Beam.Triple[]
    /** True when a pruner reported the evidence sufficient before the cap. */
    converged: boolean
    stopped: "sufficient" | "exhausted" | "depth"
  }

  export const MAX_DEPTH = 5
  export const MAX_WIDTH = 16

  export async function run(
    handle: DatabaseClient.Handle,
    opts: Options,
    pruners: Pruners,
  ): Promise<Result> {
    const depth = Math.max(1, Math.min(opts.depth ?? 2, MAX_DEPTH))
    const width = Math.max(1, Math.min(opts.width ?? 5, MAX_WIDTH))
    const includeUnreviewed = opts.includeUnreviewed ?? false

    const linked = Beam.link(handle, opts.terms, { includeUnreviewed })
    // Exact matches only when any exist — starting a beam search from a fuzzy
    // guess propagates that guess through every subsequent hop.
    const all = linked.flatMap((l) => l.matches)
    const exact = all.filter((m) => m.exact)
    const seeds = (exact.length > 0 ? exact : all).slice(0, width)

    if (seeds.length === 0) {
      return { seeds: [], hops: [], visited: [], triples: [], converged: false, stopped: "exhausted" }
    }

    let frontier = seeds.map((s) => s.id)
    const visited = new Set<string>(frontier)
    const hops: Hop[] = []
    let stopped: Result["stopped"] = "depth"

    for (let hop = 1; hop <= depth; hop++) {
      const options = Beam.exploreRelations(handle, frontier, { includeUnreviewed })
      if (options.length === 0) {
        stopped = "exhausted"
        break
      }

      const offered = [...new Set(options.map((o) => o.relation))]
      let chosen = await pruners.relations({ question: opts.question, hop, options })
      // A pruner that returns nothing, or names relations that were never on
      // offer, must not silently end the search — fall back to everything
      // available rather than reporting a dead end that isn't one.
      chosen = chosen.filter((r) => offered.includes(r))
      if (chosen.length === 0) chosen = offered

      // Exclude anything already seen.
      //
      // Without this the beam oscillates: A reaches B, then B reaches A again,
      // and a bidirectional walk spends its whole depth budget ping-ponging
      // across one edge while reporting "depth limit" as though more graph
      // existed. Not revisiting is also what lets a genuinely finished branch
      // report `exhausted` honestly.
      const candidates = Beam.expand(handle, frontier, {
        relations: chosen,
        limit: Math.max(width * 4, 20),
        includeUnreviewed,
      }).filter((c) => !visited.has(c.id))

      if (candidates.length === 0) {
        hops.push({ hop, relationsOffered: offered, relationsChosen: chosen, reached: 0, kept: [] })
        stopped = "exhausted"
        break
      }

      const { keep, sufficient } = await pruners.entities({
        question: opts.question,
        hop,
        candidates,
        width,
      })
      const valid = keep.filter((id) => candidates.some((c) => c.id === id))
      const next = (valid.length > 0 ? valid : candidates.slice(0, width).map((c) => c.id)).slice(0, width)

      hops.push({
        hop,
        relationsOffered: offered,
        relationsChosen: chosen,
        reached: candidates.length,
        kept: next.map((id) => {
          const c = candidates.find((x) => x.id === id)!
          return { id, label: c.label, kind: c.kind }
        }),
      })

      for (const id of next) visited.add(id)
      frontier = next

      if (sufficient) {
        stopped = "sufficient"
        break
      }
    }

    const visitedIds = [...visited]
    const triples = Beam.evidence(handle, visitedIds)
    log.info("graph reason complete", { hops: hops.length, visited: visitedIds.length, triples: triples.length })

    return {
      seeds,
      hops,
      visited: visitedIds,
      triples,
      converged: stopped === "sufficient",
      stopped,
    }
  }

  /**
   * Pruners that use no model at all: follow every relation, keep the widest
   * candidates by arrival order.
   *
   * Not Think-on-Graph — there is no reasoning in the loop — but it makes the
   * engine usable and testable offline, and it is a reasonable fallback when a
   * model call fails mid-search rather than aborting the whole traversal.
   */
  export const passthroughPruners: Pruners = {
    relations: async ({ options }) => [...new Set(options.map((o) => o.relation))],
    entities: async ({ candidates, width }) => ({
      keep: candidates.slice(0, width).map((c) => c.id),
      sufficient: false,
    }),
  }
}
