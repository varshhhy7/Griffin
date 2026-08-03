import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { EntityResolver } from "../../../src/storage/db/graph/resolve"
import { registry } from "../../../src/science/connectors"

const dirs: string[] = []

async function db() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-resolve-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)
  return h
}

/**
 * Swap a connector's `search` for the duration of one test.
 *
 * No network in tests — the point is to exercise the three outcomes the
 * resolver must tell apart (exact hit, fuzzy-only, transport failure), and a
 * live connector cannot be made to produce them on demand.
 */
function stub(id: string, impl: (q: string) => Promise<any[]>) {
  const connector = registry.get(id)
  if (!connector) throw new Error(`connector ${id} not registered`)
  const original = connector.search
  ;(connector as any).search = (q: string) => impl(q)
  return () => {
    ;(connector as any).search = original
  }
}

const restores: (() => void)[] = []

afterEach(async () => {
  restores.splice(0).forEach((r) => r())
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

function stubAll(ids: string[], impl: (q: string) => Promise<any[]>) {
  for (const id of ids) restores.push(stub(id, impl))
}

describe("authority map", () => {
  test("every connector it names is actually registered", () => {
    // Connector ids are kebab-case (`ncbi-gene`, `rcsb-pdb`). A camelCase typo
    // here degrades silently to "unavailable" forever, which reads as a network
    // problem rather than the config error it is.
    const known = new Set(registry.all().map((c) => c.id))
    const missing = EntityResolver.authorities().flatMap((a) =>
      EntityResolver.connectorsFor(a)
        .filter((c) => !known.has(c))
        .map((c) => `${a} -> ${c}`),
    )

    expect(missing).toEqual([])
  })

  test("every authority declares a subtype, and it is a seeded core term", async () => {
    const h = await db()
    const core = new Set(
      (h.db.query("SELECT name FROM vocabulary WHERE status = 'core'").all() as any[]).map((r) => r.name),
    )
    const unseeded = EntityResolver.authorities()
      .map((a) => EntityResolver.subtypeFor(a)!)
      .filter((s) => !core.has(s))

    // Otherwise the first resolved entity of that kind lands as a `proposed`
    // subtype and is excluded from default query scope.
    expect([...new Set(unseeded)]).toEqual([])
    h.close()
  })

  test("an unrecognized authority is reported, not guessed at", async () => {
    expect((await EntityResolver.lookup("not-a-real-authority", "TP53")).status).toBe("unknown-authority")
  })
})

describe("lookup", () => {
  test("an exact accession match resolves", async () => {
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [
      { id: "ENSG00000141510", title: "TP53", url: "https://example.invalid/TP53" },
    ])
    const r = await EntityResolver.lookup("hgnc", "ENSG00000141510")

    expect(r.status).toBe("resolved")
    expect(r.accession).toBe("ENSG00000141510")
  })

  test("an exact title match resolves", async () => {
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [{ id: "ENSG00000141510", title: "TP53" }])
    expect((await EntityResolver.lookup("hgnc", "tp53")).status).toBe("resolved")
  })

  test("a merely-relevant hit does NOT resolve", async () => {
    // Connector search is relevance-ranked, so hits[0] exists for almost any
    // query. Accepting it unconditionally is how "BANANA" became an accepted
    // gene in the previous implementation.
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [
      { id: "ENSG00000141510", title: "TP53" },
      { id: "ENSG00000012048", title: "BRCA1" },
    ])
    expect((await EntityResolver.lookup("hgnc", "BANANA")).status).toBe("no-match")
  })

  test("an empty result set is a genuine no-match", async () => {
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [])
    expect((await EntityResolver.lookup("hgnc", "NOSUCHGENE")).status).toBe("no-match")
  })

  test("a transport failure is 'unavailable', never 'no-match'", async () => {
    // THE distinction that matters. Connectors swallow network errors and
    // return [], so a failure is indistinguishable from absence at the
    // connector boundary. Recording absence during an outage would mint a
    // permanently-wrong node that is never retried.
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => {
      throw new Error("ECONNREFUSED")
    })
    const r = await EntityResolver.lookup("hgnc", "TP53")

    expect(r.status).toBe("unavailable")
    expect(r.error).toContain("ECONNREFUSED")
  })

  test("falls through to the next connector when the first fails", async () => {
    restores.push(
      stub("mygene", async () => {
        throw new Error("down")
      }),
    )
    restores.push(stub("ncbi-gene", async () => [{ id: "7157", title: "TP53" }]))
    const r = await EntityResolver.lookup("hgnc", "TP53")

    expect(r.status).toBe("resolved")
    expect(r.connector).toBe("ncbi-gene")
  })
})

describe("resolveAndRecord", () => {
  test("a resolved entity is accepted and keyed on (authority, accession)", async () => {
    const h = await db()
    stubAll(["uniprot"], async () => [{ id: "P04637", title: "TP53" }])

    const r = await EntityResolver.resolveAndRecord(h, { authority: "uniprot", query: "P04637" })
    expect(r.status).toBe("resolved")
    expect(r.nodeId).toBe("ent:uniprot:P04637")

    const node = h.db.query("SELECT * FROM node WHERE id = ?").get(r.nodeId) as any
    expect(node.review_state).toBe("accepted")
    expect(node.authority).toBe("uniprot")
    expect(node.subtype).toBe("protein")
    h.close()
  })

  test("an unresolved entity is quarantined as unreviewed with no accession", async () => {
    const h = await db()
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [])

    const r = await EntityResolver.resolveAndRecord(h, { authority: "hgnc", query: "BANANA" })
    const node = h.db.query("SELECT * FROM node WHERE id = ?").get(r.nodeId) as any

    expect(node.review_state).toBe("unreviewed")
    expect(node.accession).toBeNull()
    expect(node.authority).toBeNull()
    h.close()
  })

  test("unresolved ids are deterministic, so repeats collapse to one node", async () => {
    // The previous implementation used `Date.now()` + a random suffix, so ten
    // mentions of one unknown entity produced ten nodes.
    const h = await db()
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [])

    const a = await EntityResolver.resolveAndRecord(h, { authority: "hgnc", query: "Unknownase" })
    const b = await EntityResolver.resolveAndRecord(h, { authority: "hgnc", query: "unknownase " })

    expect(b.nodeId).toBe(a.nodeId)
    expect((h.db.query("SELECT count(*) AS n FROM node WHERE kind='entity'").get() as any).n).toBe(1)
    h.close()
  })

  test("an outage records status 'unavailable' and stays retryable", async () => {
    const h = await db()
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => {
      throw new Error("ETIMEDOUT")
    })

    const r = await EntityResolver.resolveAndRecord(h, { authority: "hgnc", query: "TP53" })
    const node = h.db.query("SELECT meta FROM node WHERE id = ?").get(r.nodeId) as any
    const meta = JSON.parse(node.meta)

    expect(r.status).toBe("unavailable")
    expect(meta.resolution_status).toBe("unavailable")
    expect(meta.resolution_attempted_at).toBeGreaterThan(0)
    expect(EntityResolver.retryable(h).map((x) => x.id)).toContain(r.nodeId)
    h.close()
  })

  test("a genuine no-match is NOT queued for retry", async () => {
    const h = await db()
    stubAll(["mygene", "ncbi-gene", "ensembl"], async () => [])
    const r = await EntityResolver.resolveAndRecord(h, { authority: "hgnc", query: "Nonexistentase" })

    expect(EntityResolver.retryable(h).map((x) => x.id)).not.toContain(r.nodeId)
    h.close()
  })

  test("surface forms are recorded as aliases and resolve offline afterwards", async () => {
    const h = await db()
    stubAll(["uniprot"], async () => [{ id: "P04637", title: "Cellular tumor antigen p53" }])

    await EntityResolver.resolveAndRecord(h, { authority: "uniprot", query: "P04637", name: "p53" })

    const hit = EntityResolver.byAlias(h, "P53")
    expect(hit?.id).toBe("ent:uniprot:P04637")
    h.close()
  })

  test("offline mode never touches the network and never marks accepted", async () => {
    const h = await db()
    stubAll(["uniprot"], async () => {
      throw new Error("network should not be called in offline mode")
    })

    const r = await EntityResolver.resolveAndRecord(h, { authority: "uniprot", query: "P04637", offline: true })
    expect(r.status).toBe("unavailable")
    expect((h.db.query("SELECT review_state FROM node WHERE id = ?").get(r.nodeId) as any).review_state).toBe(
      "unreviewed",
    )
    h.close()
  })
})
