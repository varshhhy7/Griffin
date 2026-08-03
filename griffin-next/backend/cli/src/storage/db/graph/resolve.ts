import { DatabaseClient } from "../client"
import { GraphStore } from "./store"
import { Hash } from "../hash"
import { Log } from "../../../util/log"
import { registry } from "../../../science/connectors"
import type { ConnectorHit } from "../../../science/connectors/types"

/**
 * Resolve entity mentions to canonical `(authority, accession)` identities
 * using the connectors under `science/connectors/`.
 *
 * Entity resolution is the hardest part of a knowledge base, and the failure
 * mode is asymmetric: a missed resolution costs a duplicate node, but a WRONG
 * resolution silently merges two different things and corrupts every query
 * downstream. So this errs toward "unresolved" everywhere it is not certain.
 */
export namespace EntityResolver {
  const log = Log.create({ service: "storage.db.graph.resolve" })

  /**
   * Authority → connectors that can resolve it, in preference order.
   *
   * Keyed on authority rather than connector id so callers name the namespace
   * they mean ("uniprot", "hgnc") and the resolver picks the source.
   */
  const AUTHORITIES: Record<string, { connectors: string[]; subtype: string }> = {
    hgnc: { connectors: ["mygene", "ncbi-gene", "ensembl"], subtype: "gene" },
    ensembl: { connectors: ["ensembl", "mygene"], subtype: "gene" },
    "ncbi-gene": { connectors: ["ncbi-gene", "mygene"], subtype: "gene" },
    uniprot: { connectors: ["uniprot"], subtype: "protein" },
    pdb: { connectors: ["rcsb-pdb", "pdbe"], subtype: "structure" },
    alphafold: { connectors: ["alphafold"], subtype: "structure" },
    interpro: { connectors: ["interpro"], subtype: "protein" },
    chebi: { connectors: ["chebi"], subtype: "compound" },
    chembl: { connectors: ["chembl"], subtype: "compound" },
    pubchem: { connectors: ["pubchem"], subtype: "compound" },
    dbsnp: { connectors: ["dbsnp", "myvariant"], subtype: "variant" },
    clinvar: { connectors: ["clinvar", "myvariant"], subtype: "variant" },
    gnomad: { connectors: ["gnomad"], subtype: "variant" },
    reactome: { connectors: ["reactome"], subtype: "pathway" },
    kegg: { connectors: ["kegg"], subtype: "pathway" },
    wikipathways: { connectors: ["wikipathways"], subtype: "pathway" },
    opentargets: { connectors: ["opentargets"], subtype: "disease" },
    gtex: { connectors: ["gtex"], subtype: "tissue" },
    hpa: { connectors: ["hpa"], subtype: "tissue" },
    depmap: { connectors: ["depmap"], subtype: "cell-line" },
    geo: { connectors: ["geo"], subtype: "dataset" },
    arrayexpress: { connectors: ["arrayexpress"], subtype: "dataset" },
    pubmed: { connectors: ["pubmed"], subtype: "paper" },
    doi: { connectors: ["crossref"], subtype: "paper" },
    arxiv: { connectors: ["arxiv"], subtype: "preprint" },
    biorxiv: { connectors: ["biorxiv"], subtype: "preprint" },
    openalex: { connectors: ["openalex"], subtype: "paper" },
  }

  export function authorities(): string[] {
    return Object.keys(AUTHORITIES).sort()
  }

  /** Connectors backing an authority, in preference order. */
  export function connectorsFor(authority: string): string[] {
    return AUTHORITIES[authority.toLowerCase().trim()]?.connectors ?? []
  }

  export function subtypeFor(authority: string): string | undefined {
    return AUTHORITIES[authority.toLowerCase().trim()]?.subtype
  }

  /**
   * Outcome of a lookup.
   *
   * `no-match` and `unavailable` are kept apart on purpose. Several connectors
   * swallow network errors and return `[]` (`genomics/ensembl.ts:59,83`,
   * `proteins/uniprot.ts` via `orFallback`, …), which makes "this accession
   * does not exist" indistinguishable from "the network was down" at the
   * connector boundary. Treating the second as the first would mint a
   * permanently-wrong unresolved node during any outage, and it would never be
   * retried because the graph would look settled. `unavailable` is therefore
   * always retryable and never records an authoritative absence.
   */
  export type Status = "resolved" | "no-match" | "unavailable" | "unknown-authority"

  export interface Lookup {
    status: Status
    accession?: string
    label?: string
    url?: string
    connector?: string
    error?: string
  }

  /** Wrap a connector search so a thrown error is distinguishable from no hits. */
  async function search(connectorId: string, query: string, signal?: AbortSignal) {
    const connector = registry.get(connectorId)
    if (!connector) return { hits: [] as ConnectorHit[], error: `no connector "${connectorId}"` }
    try {
      return { hits: await connector.search(query, { limit: 5, signal }), error: undefined as string | undefined }
    } catch (e) {
      return { hits: [] as ConnectorHit[], error: String(e) }
    }
  }

  /**
   * Is this hit the thing we asked for, or merely the top of a fuzzy list?
   *
   * Connector search is relevance-ranked, so hit[0] always exists for almost
   * any query. Accepting it unconditionally is how "BANANA" becomes an
   * accepted gene. Require the query to match the accession or the title
   * exactly (case- and punctuation-insensitive) before treating it as identity.
   */
  function isExact(query: string, hit: ConnectorHit): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "")
    const q = norm(query)
    if (norm(hit.id) === q) return true
    if (hit.title && norm(hit.title) === q) return true
    // Accession embedded in a compound title, e.g. "TP53 - Homo sapiens".
    if (hit.title && norm(hit.title.split(/[-–|(]/)[0] ?? "") === q) return true
    return false
  }

  /** Look up one term without writing anything. */
  export async function lookup(authority: string, query: string, signal?: AbortSignal): Promise<Lookup> {
    const key = authority.toLowerCase().trim()
    const spec = AUTHORITIES[key]
    if (!spec) return { status: "unknown-authority" }

    const term = query.trim()
    if (!term) return { status: "no-match" }

    let sawError: string | undefined
    for (const connectorId of spec.connectors) {
      const { hits, error } = await search(connectorId, term, signal)
      if (error) {
        sawError = error
        log.warn("connector unavailable during resolution", { authority: key, connectorId, error })
        continue
      }
      const exact = hits.find((h) => isExact(term, h))
      if (exact) {
        return {
          status: "resolved",
          accession: exact.id,
          label: exact.title || term,
          url: exact.url,
          connector: connectorId,
        }
      }
    }

    // Every connector for this authority errored — absence is unproven.
    if (sawError && spec.connectors.length > 0) return { status: "unavailable", error: sawError }
    return { status: "no-match" }
  }

  /** Deterministic id for a term we could not resolve, so repeats collapse. */
  export function unresolvedId(authority: string, name: string): string {
    const key = `${authority.toLowerCase().trim()}::${name.toLowerCase().trim()}`
    return `ent:unresolved:${Hash.contentIdV2({ key }).hash}`
  }

  export interface ResolveOptions {
    authority: string
    /** Term to resolve — an accession or a name. */
    query: string
    /** Display label; defaults to the query. */
    name?: string
    subtype?: string
    /** Skip the network entirely and record as unresolved. */
    offline?: boolean
    signal?: AbortSignal
  }

  export interface ResolveResult {
    nodeId: string
    status: Status
    accession: string | null
  }

  /**
   * Resolve a term and record the entity node.
   *
   * Only a genuine exact connector hit yields `review_state='accepted'`;
   * everything else lands `unreviewed` and out of default query scope, queued
   * for the review gate. `resolution_attempted_at` and `resolution_status` go
   * into `meta` so an `unavailable` result can be retried later rather than
   * being mistaken for a settled answer.
   */
  export async function resolveAndRecord(
    handle: DatabaseClient.Handle,
    opts: ResolveOptions,
  ): Promise<ResolveResult> {
    const authority = opts.authority.toLowerCase().trim()
    const term = opts.query.trim()
    const label = (opts.name ?? term).trim()

    const result: Lookup = opts.offline ? { status: "unavailable", error: "offline" } : await lookup(authority, term, opts.signal)

    const resolved = result.status === "resolved"
    const nodeId = resolved ? `ent:${authority}:${result.accession}` : unresolvedId(authority, label)

    GraphStore.recordNode(handle, {
      id: nodeId,
      kind: "entity",
      subtype: opts.subtype ?? subtypeFor(authority) ?? "entity",
      label: resolved ? (result.label ?? label) : label,
      recorded_at: Date.now(),
      authority: resolved ? authority : null,
      accession: resolved ? (result.accession ?? null) : null,
      origin: "agent",
      // Never 'accepted' without a verified exact hit — an unverified string
      // marked accepted is worse than no entity at all, because it enters
      // default query scope and looks authoritative.
      review_state: resolved ? "accepted" : "unreviewed",
      meta: JSON.stringify({
        resolution_status: result.status,
        resolution_attempted_at: Date.now(),
        ...(result.connector ? { resolved_by: result.connector } : {}),
        ...(result.url ? { url: result.url } : {}),
        ...(result.error ? { resolution_error: result.error } : {}),
        query: term,
      }),
    })

    // Record the surface form so a later mention of the same string resolves
    // by alias without another network round trip.
    recordAlias(handle, nodeId, label)
    if (term !== label) recordAlias(handle, nodeId, term)

    return { nodeId, status: result.status, accession: resolved ? (result.accession ?? null) : null }
  }

  export function normalizeAlias(alias: string): string {
    return alias.toLowerCase().trim().replace(/[\s_-]+/g, " ")
  }

  export function recordAlias(handle: DatabaseClient.Handle, nodeId: string, alias: string, source?: string): void {
    const trimmed = alias.trim()
    if (!trimmed) return
    handle
      .stmt(
        `INSERT INTO alias (node_id, alias, normalized, source) VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id, alias) DO NOTHING`,
      )
      .run(nodeId, trimmed, normalizeAlias(trimmed), source ?? null)
  }

  /** Find an already-known entity by surface form, avoiding a network call. */
  export function byAlias(handle: DatabaseClient.Handle, alias: string): { id: string; label: string } | undefined {
    return handle
      .stmt(
        `SELECT n.id, n.label FROM alias a JOIN node n ON n.id = a.node_id
         WHERE a.normalized = ? AND n.merged_into IS NULL LIMIT 1`,
      )
      .get(normalizeAlias(alias)) as any
  }

  /** Entities whose resolution failed and should be retried. */
  export function retryable(handle: DatabaseClient.Handle, limit = 100): { id: string; label: string }[] {
    return handle
      .stmt(
        `SELECT id, label FROM node
         WHERE kind = 'entity' AND accession IS NULL AND merged_into IS NULL
           AND json_extract(meta, '$.resolution_status') = 'unavailable'
         ORDER BY recorded_at LIMIT ?`,
      )
      .all(limit) as any
  }
}
