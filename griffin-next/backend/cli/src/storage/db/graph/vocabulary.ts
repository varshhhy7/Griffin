import { DatabaseClient } from "../client"
import { Log } from "../../../util/log"

export namespace Vocabulary {
  const log = Log.create({ service: "storage.db.graph.vocabulary" })

  /**
   * Case, camelCase and separators only — no singularization.
   *
   * Kept separate because singularizing is lossy and must never be applied to
   * a term that already exists: `same-as` becomes `same-a` and `supports`
   * becomes `support`, so a governor that always singularized would mangle its
   * own seeded relation names into new proposed ones — causing exactly the
   * drift it exists to prevent.
   */
  export function normalizeBase(term: string): string {
    return term
      .trim()
      // camelCase and PascalCase arrive from models constantly: hasGene,
      // isPartOf. Split before lowercasing or the boundary is lost.
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
  }

  /** English plural rules, applied to the final segment only. */
  function singularize(s: string): string {
    // entities -> entity, analyses -> analysis
    if (/[^aeiou]ies$/.test(s)) return `${s.slice(0, -3)}y`
    // suppresses -> suppress, boxes -> box, matches -> match
    if (/(ss|sh|ch|x|z)es$/.test(s)) return s.slice(0, -2)
    if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && s.length > 3) return s.slice(0, -1)
    return s
  }

  export function normalize(term: string): string {
    return singularize(normalizeBase(term))
  }

  /**
   * Candidate spellings for a term, most literal first.
   *
   * A lookup tries these in order, so an exact existing term always wins over
   * a singularized guess.
   */
  function candidates(term: string): string[] {
    const base = normalizeBase(term)
    const singular = singularize(base)
    return base === singular ? [base] : [base, singular]
  }

  /** First candidate that already exists in this namespace. */
  function findExisting(handle: DatabaseClient.Handle, kind: string, term: string): string | undefined {
    for (const candidate of candidates(term)) {
      if (handle.stmt(`SELECT 1 FROM vocabulary WHERE kind = ? AND name = ?`).get(kind, candidate)) return candidate
    }
    return undefined
  }

  /** Reserved namespaces inside `vocabulary`, so they cannot collide with a node kind. */
  export const RELATION = "@relation"
  export const NODE_KIND = "@node-kind"

  /** Edit distance, bounded — we only care whether two terms are near-identical. */
  function distance(a: string, b: string, max = 2): number {
    if (Math.abs(a.length - b.length) > max) return max + 1
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      const row = [i]
      let best = i
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
        best = Math.min(best, row[j])
      }
      if (best > max) return max + 1
      prev = row
    }
    return prev[b.length]
  }

  /**
   * Find an existing term close enough to reuse.
   *
   * Normalization already collapses case, separators, plurals and camelCase.
   * This catches what is left: typos and near-synonyms — `intracts-with` vs
   * `interacts-with`. Threshold scales with length so short terms are not
   * merged carelessly (`gene` and `genes` differ by one character but so do
   * `gene` and `gone`).
   */
  export function nearest(handle: DatabaseClient.Handle, kind: string, name: string): string | undefined {
    const max = name.length <= 5 ? 0 : name.length <= 10 ? 1 : 2
    if (max === 0) return undefined
    const rows = handle
      .stmt(`SELECT name FROM vocabulary WHERE kind = ? AND status != 'merged'`)
      .all(kind) as { name: string }[]
    let best: { name: string; d: number } | undefined
    for (const row of rows) {
      const d = distance(name, row.name, max)
      if (d <= max && (!best || d < best.d)) best = { name: row.name, d }
    }
    return best?.name
  }

  export function propose(
    handle: DatabaseClient.Handle,
    rawSubtype: string,
    kind: string,
    definition?: string,
    authority?: string,
    firstSeenNodeId?: string,
  ): { name: string; status: string; reused: boolean } {
    const normalized = normalize(rawSubtype)
    // An exact existing spelling wins; then a near-identical one; only then do
    // we mint. Without the fuzzy step the vocabulary fragments into typo
    // variants, which is the whole reason an open taxonomy needs governance.
    const name = findExisting(handle, kind, rawSubtype) ?? nearest(handle, kind, normalized) ?? normalized

    // Every lookup is scoped by kind: the table is keyed on (kind, name), and
    // 'dataset' legitimately exists under both 'entity' and 'artifact'.
    const existing = handle
      .stmt(`SELECT name, status, merged_into FROM vocabulary WHERE kind = ? AND name = ?`)
      .get(kind, name) as any

    if (existing) {
      const activeName = existing.merged_into ?? existing.name
      handle
        .stmt(`UPDATE vocabulary SET usage_count = usage_count + 1 WHERE kind = ? AND name = ?`)
        .run(kind, activeName)
      const status = existing.merged_into
        ? ((handle.stmt(`SELECT status FROM vocabulary WHERE kind = ? AND name = ?`).get(kind, activeName) as any)
            ?.status ?? existing.status)
        : existing.status
      checkAutoPromotion(handle, kind, activeName)
      return { name: activeName, status, reused: true }
    }

    handle
      .stmt(
        `INSERT INTO vocabulary (name, kind, status, definition, authority, first_seen_node, usage_count, created_at) ` +
          `VALUES (?, ?, 'proposed', ?, ?, ?, 1, ?)`,
      )
      .run(name, kind, definition ?? null, authority ?? null, firstSeenNodeId ?? null, Date.now())

    log.info("proposed new subtype", { name, kind })
    return { name, status: "proposed", reused: false }
  }

  /** Distinct nodes required before a proposed subtype is auto-accepted. */
  export const AUTO_PROMOTE_THRESHOLD = 10

  export function checkAutoPromotion(handle: DatabaseClient.Handle, kind: string, name: string): boolean {
    const row = handle
      .stmt(`SELECT status FROM vocabulary WHERE kind = ? AND name = ?`)
      .get(kind, name) as any
    if (!row || row.status !== "proposed") return false

    // Count nodes of this kind only — a subtype name shared across kinds must
    // not have one kind's usage promote another's.
    const distinctNodes =
      (
        handle
          .stmt(
            `SELECT count(DISTINCT id) AS n FROM node WHERE kind = ? AND subtype = ? AND review_state != 'rejected'`,
          )
          .get(kind, name) as any
      )?.n ?? 0

    if (distinctNodes < AUTO_PROMOTE_THRESHOLD) return false

    handle
      .stmt(
        `UPDATE vocabulary SET status = 'accepted', promoted_by = 'auto', promoted_at = ? WHERE kind = ? AND name = ?`,
      )
      .run(Date.now(), kind, name)
    log.info("auto-promoted vocabulary subtype", { kind, name, distinctNodes })
    return true
  }

  /** Maintainer promotion or rejection, recorded distinctly from the auto path. */
  export function setStatus(
    handle: DatabaseClient.Handle,
    kind: string,
    name: string,
    status: "accepted" | "rejected",
    by = "maintainer",
  ): void {
    handle
      .stmt(`UPDATE vocabulary SET status = ?, promoted_by = ?, promoted_at = ? WHERE kind = ? AND name = ?`)
      .run(status, by, Date.now(), kind, normalize(name))
  }

  export interface Resolution {
    name: string
    status: string
    /** An existing term was reused instead of minting the requested one. */
    reused: boolean
    /** Refused: the term is reserved for system-observed writes. */
    reserved?: boolean
  }

  /**
   * Resolve a relation an agent wants to use, minting it if genuinely new.
   *
   * Relations are open but governed. The three lineage relations stay
   * **reserved**: `part-of`, `produced` and `consumed` record what the
   * workspace actually did, and a model asserting one is fabricating
   * provenance — the single thing the trust columns exist to prevent. Refusing
   * is better than accepting-and-flagging, because a fabricated `produced`
   * edge would sit in `graph_lineage` output looking exactly like an observed
   * one.
   */
  export function resolveRelation(handle: DatabaseClient.Handle, raw: string, definition?: string): Resolution {
    // `same-as` and `supports` are seeded relation names that singularizing
    // would mangle, so an exact spelling is always tried first.
    const name = findExisting(handle, RELATION, raw) ?? normalize(raw)
    const row = handle
      .stmt(`SELECT name, status, merged_into FROM vocabulary WHERE kind = ? AND name = ?`)
      .get(RELATION, name) as any

    if (row?.status === "reserved") return { name, status: "reserved", reused: true, reserved: true }
    if (row) {
      const active = row.merged_into ?? row.name
      handle
        .stmt(`UPDATE vocabulary SET usage_count = usage_count + 1 WHERE kind = ? AND name = ?`)
        .run(RELATION, active)
      return { name: active, status: row.status, reused: true }
    }

    const near = nearest(handle, RELATION, name)
    if (near) {
      const reserved = handle.stmt(`SELECT status FROM vocabulary WHERE kind = ? AND name = ?`).get(RELATION, near) as any
      if (reserved?.status === "reserved") return { name: near, status: "reserved", reused: true, reserved: true }
      handle.stmt(`UPDATE vocabulary SET usage_count = usage_count + 1 WHERE kind = ? AND name = ?`).run(RELATION, near)
      return { name: near, status: reserved?.status ?? "proposed", reused: true }
    }

    handle
      .stmt(
        `INSERT INTO vocabulary (kind, name, status, definition, usage_count, created_at)
         VALUES (?, ?, 'proposed', ?, 1, ?)`,
      )
      .run(RELATION, name, definition ?? null, Date.now())
    log.info("proposed new relation", { name })
    return { name, status: "proposed", reused: false }
  }

  /** Resolve a node kind, minting it if genuinely new. No kind is reserved. */
  export function resolveNodeKind(handle: DatabaseClient.Handle, raw: string, definition?: string): Resolution {
    const res = propose(handle, raw, NODE_KIND, definition)
    return { name: res.name, status: res.status, reused: res.reused }
  }

  /** Relations available to an agent, for tool descriptions and error messages. */
  export function relations(handle: DatabaseClient.Handle): { name: string; status: string; definition?: string }[] {
    return handle
      .stmt(`SELECT name, status, definition FROM vocabulary WHERE kind = ? AND status != 'merged' ORDER BY status, name`)
      .all(RELATION) as any
  }

  export function nodeKinds(handle: DatabaseClient.Handle): { name: string; status: string }[] {
    return handle
      .stmt(`SELECT name, status FROM vocabulary WHERE kind = ? AND status != 'merged' ORDER BY name`)
      .all(NODE_KIND) as any
  }

  /** Proposed subtypes by usage, surfaced in `griffin db status` so drift is visible. */
  export function proposed(handle: DatabaseClient.Handle): { kind: string; name: string; usage_count: number }[] {
    return handle
      .stmt(`SELECT kind, name, usage_count FROM vocabulary WHERE status = 'proposed' ORDER BY usage_count DESC, name`)
      .all() as any
  }

  export function merge(handle: DatabaseClient.Handle, kind: string, fromName: string, intoName: string): void {
    handle.tx(() => {
      const normFrom = normalize(fromName)
      const normInto = normalize(intoName)
      handle
        .stmt(`UPDATE vocabulary SET status = 'merged', merged_into = ? WHERE kind = ? AND name = ?`)
        .run(normInto, kind, normFrom)
      handle.stmt(`UPDATE node SET subtype = ? WHERE kind = ? AND subtype = ?`).run(normInto, kind, normFrom)
    })
  }
}
