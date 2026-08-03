import { DatabaseClient } from "../client"
import { DatabaseMode } from "../mode"
import { GraphStore } from "./store"
import { EntityResolver } from "./resolve"
import { Log } from "../../../util/log"
import type { ConnectorHit, ConnectorDomain } from "../../../science/connectors/types"

/**
 * Turn connector results into knowledge-base nodes.
 *
 * This is where the KB half gets its density. The alternative — running NER
 * over message text — guesses at identity and needs a reviewer for every
 * guess. A connector hit does not: the accession came back from the authority
 * itself, so identity is already resolved. The agent is doing these lookups
 * anyway; the only thing missing was recording them.
 *
 * Nodes land `origin='system'` because the identity was *observed* from an
 * authoritative source rather than asserted by the model, and
 * `review_state='accepted'` for the same reason. What the model chose was the
 * query, not the identity — and the query is captured as the `mentions` edge
 * from the message, which is where its judgement is recorded.
 */
export namespace Ingest {
  const log = Log.create({ service: "storage.db.graph.ingest" })

  /** Literature sources become `source` nodes; everything else is an `entity`. */
  const SOURCE_DOMAINS: ReadonlySet<ConnectorDomain> = new Set<ConnectorDomain>(["literature"])

  /** Connector id → the accession namespace its ids belong to. */
  const AUTHORITY: Record<string, string> = {
    pubmed: "pubmed",
    europepmc: "pubmed",
    crossref: "doi",
    arxiv: "arxiv",
    biorxiv: "biorxiv",
    openalex: "openalex",
    "semantic-scholar": "openalex",
    ensembl: "ensembl",
    mygene: "hgnc",
    "ncbi-gene": "ncbi-gene",
    dbsnp: "dbsnp",
    clinvar: "clinvar",
    myvariant: "dbsnp",
    gnomad: "gnomad",
    uniprot: "uniprot",
    "rcsb-pdb": "pdb",
    pdbe: "pdb",
    alphafold: "alphafold",
    interpro: "interpro",
    pfam: "interpro",
    chebi: "chebi",
    chembl: "chembl",
    pubchem: "pubchem",
    reactome: "reactome",
    kegg: "kegg",
    wikipathways: "wikipathways",
    opentargets: "opentargets",
    gtex: "gtex",
    hpa: "hpa",
    depmap: "depmap",
    geo: "geo",
    arrayexpress: "arrayexpress",
  }

  /** Subtype for a hit from this connector, falling back to the authority's default. */
  function subtypeFor(connectorId: string, domain: ConnectorDomain, authority: string): string {
    if (SOURCE_DOMAINS.has(domain)) {
      if (connectorId === "arxiv" || connectorId === "biorxiv") return "preprint"
      return "paper"
    }
    return EntityResolver.subtypeFor(authority) ?? "entity"
  }

  export function authorityFor(connectorId: string): string | undefined {
    return AUTHORITY[connectorId]
  }

  export interface IngestInput {
    connectorId: string
    domain: ConnectorDomain
    hits: ConnectorHit[]
    query: string
    /** Message that ran the search, if known — becomes the `mentions` source. */
    messageId?: string
    sessionId?: string
  }

  export interface IngestResult {
    nodeIds: string[]
    created: number
  }

  /**
   * Record hits and link them to the message that surfaced them.
   *
   * The `mentions` edge is what the design calls load-bearing: it is the only
   * bridge between the system-observed half (sessions, messages, runs) and the
   * curated half (entities, sources). It is what makes "which of my sessions
   * touched BRAF" and "which paper backs this claim" the same query shape.
   */
  export function record(handle: DatabaseClient.Handle, input: IngestInput): IngestResult {
    const authority = AUTHORITY[input.connectorId]
    if (!authority) {
      // An unmapped connector is not an error — plenty return records with no
      // stable accession namespace. Skip rather than mint junk identities.
      log.info("connector has no accession authority; skipping ingest", { connector: input.connectorId })
      return { nodeIds: [], created: 0 }
    }

    const kind = SOURCE_DOMAINS.has(input.domain) ? "source" : "entity"
    const subtype = subtypeFor(input.connectorId, input.domain, authority)
    const nodeIds: string[] = []
    const now = Date.now()

    handle.tx(() => {
      for (const hit of input.hits) {
        const accession = String(hit.id ?? "").trim()
        if (!accession) continue
        const nodeId = `${kind === "source" ? "src" : "ent"}:${authority}:${accession}`

        GraphStore.recordNode(handle, {
          id: nodeId,
          kind,
          subtype,
          label: hit.title || accession,
          recorded_at: now,
          authority,
          accession,
          origin: "system",
          review_state: "accepted",
          meta: JSON.stringify({
            connector: input.connectorId,
            ...(hit.url ? { url: hit.url } : {}),
            ...(hit.summary ? { summary: hit.summary.slice(0, 2000) } : {}),
          }),
        })

        EntityResolver.recordAlias(handle, nodeId, accession, input.connectorId)
        if (hit.title) EntityResolver.recordAlias(handle, nodeId, hit.title, input.connectorId)

        // Only link if the message node exists — derivation may not have run
        // yet, and a dangling edge violates the FK.
        if (input.messageId && nodeExists(handle, `msg:${input.messageId}`)) {
          GraphStore.linkEdge(handle, {
            from_id: `msg:${input.messageId}`,
            to_id: nodeId,
            relation: "mentions",
            origin: "system",
            created_at: now,
            meta: JSON.stringify({ query: input.query, connector: input.connectorId }),
          })
        }

        nodeIds.push(nodeId)
      }
    })

    return { nodeIds, created: nodeIds.length }
  }

  function nodeExists(handle: DatabaseClient.Handle, id: string): boolean {
    return handle.stmt(`SELECT 1 FROM node WHERE id = ?`).get(id) !== null
  }

  /**
   * Fire-and-forget entry point for tools.
   *
   * Never throws and never blocks the tool's own result: a knowledge-base
   * side effect must not be able to fail a search the user asked for.
   */
  export function recordSafely(input: IngestInput): IngestResult {
    if (!DatabaseMode.enabled()) return { nodeIds: [], created: 0 }
    try {
      return record(DatabaseClient.writer(), input)
    } catch (e) {
      log.error("kb ingest failed", { connector: input.connectorId, error: e })
      return { nodeIds: [], created: 0 }
    }
  }
}
