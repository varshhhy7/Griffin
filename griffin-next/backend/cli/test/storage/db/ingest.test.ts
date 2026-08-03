import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { Ingest } from "../../../src/storage/db/graph/ingest"
import { GraphStore } from "../../../src/storage/db/graph/store"
import { GraphQuery } from "../../../src/storage/db/graph/query"

const dirs: string[] = []

async function db() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-ingest-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)
  return h
}

/** A session with one assistant message that ran a science_search tool call. */
function session(h: DatabaseClient.Handle, opts: { kbNodes?: string[]; db?: string } = {}) {
  h.db.query(`INSERT INTO project (id, worktree, json) VALUES ('p1','/repo','{}')`).run()
  h.db.query(`INSERT INTO session (id, project_id, json) VALUES ('s1','p1','{}')`).run()
  h.db
    .query(`INSERT INTO message (id, session_id, role, created_at, json) VALUES ('m1','s1','assistant',1000,'{}')`)
    .run()
  const part = {
    id: "pt1",
    messageID: "m1",
    sessionID: "s1",
    type: "tool",
    tool: "science_search",
    state: {
      status: "completed",
      input: { db: opts.db ?? "pubmed", query: "TP53" },
      output: "…",
      title: "science_search",
      metadata: { db: opts.db ?? "pubmed", count: 1, kb_nodes: opts.kbNodes ?? [] },
    },
  }
  h.db
    .query(`INSERT INTO part (id, message_id, session_id, type, tool, created_at, json) VALUES (?,?,?,?,?,?,?)`)
    .run("pt1", "m1", "s1", "tool", "science_search", 1000, JSON.stringify(part))
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("record", () => {
  test("literature hits become source nodes keyed on the accession", async () => {
    const h = await db()
    session(h)
    GraphStore.rebuild(h)

    const res = Ingest.record(h, {
      connectorId: "pubmed",
      domain: "literature",
      query: "TP53",
      messageId: "m1",
      hits: [{ id: "12345678", title: "p53 and cancer", url: "https://pubmed.invalid/12345678" }],
    })

    expect(res.nodeIds).toEqual(["src:pubmed:12345678"])
    const node = h.db.query("SELECT * FROM node WHERE id = ?").get("src:pubmed:12345678") as any
    expect(node.kind).toBe("source")
    expect(node.subtype).toBe("paper")
    expect(node.accession).toBe("12345678")
    // The accession came from the authority, not the model, so it is observed
    // rather than asserted — and therefore trusted and rebuildable.
    expect(node.origin).toBe("system")
    expect(node.review_state).toBe("accepted")
    h.close()
  })

  test("non-literature hits become entity nodes with the authority's subtype", async () => {
    const h = await db()
    session(h)
    GraphStore.rebuild(h)

    Ingest.record(h, {
      connectorId: "uniprot",
      domain: "proteomics",
      query: "TP53",
      messageId: "m1",
      hits: [{ id: "P04637", title: "Cellular tumor antigen p53" }],
    })

    const node = h.db.query("SELECT * FROM node WHERE id = ?").get("ent:uniprot:P04637") as any
    expect(node.kind).toBe("entity")
    expect(node.subtype).toBe("protein")
    h.close()
  })

  test("preprint servers get the preprint subtype, not paper", async () => {
    const h = await db()
    session(h)
    GraphStore.rebuild(h)
    Ingest.record(h, {
      connectorId: "arxiv",
      domain: "literature",
      query: "attention",
      messageId: "m1",
      hits: [{ id: "1706.03762", title: "Attention Is All You Need" }],
    })
    expect((h.db.query("SELECT subtype FROM node WHERE id='src:arxiv:1706.03762'").get() as any).subtype).toBe(
      "preprint",
    )
    h.close()
  })

  test("a `mentions` edge bridges the message to the source", async () => {
    // The load-bearing edge: it is the only link between the system-observed
    // half and the curated half, and what makes "which session touched BRAF"
    // answerable at all.
    const h = await db()
    session(h)
    GraphStore.rebuild(h)

    Ingest.record(h, {
      connectorId: "pubmed",
      domain: "literature",
      query: "BRAF V600E",
      messageId: "m1",
      hits: [{ id: "999", title: "BRAF inhibitors" }],
    })

    const edge = h.db
      .query("SELECT * FROM edge WHERE relation = 'mentions' AND from_id = 'msg:m1'")
      .get() as any
    expect(edge.to_id).toBe("src:pubmed:999")
    expect(JSON.parse(edge.meta).query).toBe("BRAF V600E")
    h.close()
  })

  test("no mentions edge is emitted when the message node does not exist yet", async () => {
    // Derivation may not have run. A dangling edge would violate the FK and
    // abort the whole ingest transaction.
    const h = await db()
    const res = Ingest.record(h, {
      connectorId: "pubmed",
      domain: "literature",
      query: "x",
      messageId: "never-derived",
      hits: [{ id: "111", title: "t" }],
    })

    expect(res.created).toBe(1)
    expect((h.db.query("SELECT count(*) AS n FROM edge WHERE relation='mentions'").get() as any).n).toBe(0)
    h.close()
  })

  test("a connector with no accession authority is skipped rather than minting junk ids", async () => {
    const h = await db()
    const res = Ingest.record(h, {
      connectorId: "some-unmapped-connector",
      domain: "general",
      query: "x",
      hits: [{ id: "abc", title: "t" }],
    })
    expect(res).toEqual({ nodeIds: [], created: 0 })
    h.close()
  })

  test("hits with a blank id are skipped", async () => {
    const h = await db()
    const res = Ingest.record(h, {
      connectorId: "pubmed",
      domain: "literature",
      query: "x",
      hits: [{ id: "", title: "no id" }, { id: "222", title: "ok" }],
    })
    expect(res.nodeIds).toEqual(["src:pubmed:222"])
    h.close()
  })

  test("re-ingesting the same hit is idempotent", async () => {
    const h = await db()
    session(h)
    GraphStore.rebuild(h)
    const hit = { id: "333", title: "repeat" }
    Ingest.record(h, { connectorId: "pubmed", domain: "literature", query: "q", messageId: "m1", hits: [hit] })
    Ingest.record(h, { connectorId: "pubmed", domain: "literature", query: "q", messageId: "m1", hits: [hit] })

    expect((h.db.query("SELECT count(*) AS n FROM node WHERE kind='source'").get() as any).n).toBe(1)
    expect((h.db.query("SELECT count(*) AS n FROM edge WHERE relation='mentions'").get() as any).n).toBe(1)
    h.close()
  })

  test("accession and title are both recorded as aliases", async () => {
    const h = await db()
    Ingest.record(h, {
      connectorId: "uniprot",
      domain: "proteomics",
      query: "p53",
      hits: [{ id: "P04637", title: "Cellular tumor antigen p53" }],
    })
    const aliases = (h.db.query("SELECT alias FROM alias WHERE node_id = 'ent:uniprot:P04637'").all() as any[]).map(
      (r) => r.alias,
    )
    expect(aliases).toContain("P04637")
    expect(aliases).toContain("Cellular tumor antigen p53")
    h.close()
  })
})

describe("rebuild", () => {
  test("KB nodes and mentions survive db rebuild, re-derived from the stored part", async () => {
    // Without this, `db rebuild` — which wipes and re-derives the system half —
    // would silently delete the entire connector-sourced knowledge base.
    const h = await db()
    session(h, { kbNodes: ["src:pubmed:12345678"], db: "pubmed" })

    GraphStore.rebuild(h)

    const node = h.db.query("SELECT * FROM node WHERE id = 'src:pubmed:12345678'").get() as any
    expect(node).toBeDefined()
    expect(node.kind).toBe("source")
    expect(node.accession).toBe("12345678")

    const edge = h.db.query("SELECT * FROM edge WHERE relation='mentions' AND to_id=?").get("src:pubmed:12345678")
    expect(edge).toBeDefined()

    // And twice, to confirm it is idempotent rather than accumulating.
    GraphStore.rebuild(h)
    expect((h.db.query("SELECT count(*) AS n FROM edge WHERE relation='mentions'").get() as any).n).toBe(1)
    h.close()
  })

  test("agent-asserted claims are preserved, not re-derived", async () => {
    const h = await db()
    session(h, { kbNodes: ["src:pubmed:1"] })
    GraphStore.rebuild(h)

    GraphStore.recordNode(h, {
      id: "clm:abc",
      kind: "claim",
      label: "a claim",
      recorded_at: 1,
      origin: "agent",
      confidence: 0.8,
      source_node_id: "src:pubmed:1",
      review_state: "unreviewed",
    })

    GraphStore.rebuild(h)
    expect(h.db.query("SELECT * FROM node WHERE id='clm:abc'").get()).toBeDefined()
    h.close()
  })

  test("rebuild aborts cleanly when a claim's evidence would vanish", async () => {
    // A claim citing a system node whose source part is gone. Deferred FKs let
    // the wipe/re-derive pass through an inconsistent state, but COMMIT must
    // still refuse rather than silently orphaning the claim's provenance.
    const h = await db()
    session(h, { kbNodes: ["src:pubmed:1"] })
    GraphStore.rebuild(h)

    GraphStore.recordNode(h, {
      id: "clm:orphan",
      kind: "claim",
      label: "cites something that will disappear",
      recorded_at: 1,
      origin: "agent",
      source_node_id: "src:pubmed:1",
      review_state: "unreviewed",
    })

    // Remove the part that re-derives src:pubmed:1.
    h.db.query(`DELETE FROM part WHERE id = 'pt1'`).run()

    expect(() => GraphStore.rebuild(h)).toThrow(/rebuild aborted/)
    // And nothing was changed — the claim and its evidence both survive.
    expect(h.db.query("SELECT 1 FROM node WHERE id='clm:orphan'").get()).toBeDefined()
    expect(h.db.query("SELECT 1 FROM node WHERE id='src:pubmed:1'").get()).toBeDefined()
    h.close()
  })
})

describe("graph queries over the ingested KB", () => {
  test("a source reached from a message is findable by search", async () => {
    const h = await db()
    session(h)
    GraphStore.rebuild(h)
    Ingest.record(h, {
      connectorId: "pubmed",
      domain: "literature",
      query: "TP53",
      messageId: "m1",
      hits: [{ id: "777", title: "TP53 mutations in cancer" }],
    })

    const hits = GraphQuery.search(h, "TP53 mutations")
    expect(hits.map((n: any) => n.id)).toContain("src:pubmed:777")
    h.close()
  })

  test("neighbors of the message include the mentioned source", async () => {
    const h = await db()
    session(h)
    GraphStore.rebuild(h)
    Ingest.record(h, {
      connectorId: "pubmed",
      domain: "literature",
      query: "TP53",
      messageId: "m1",
      hits: [{ id: "888", title: "paper" }],
    })

    const nb = GraphQuery.neighbors(h, "msg:m1", "mentions")
    expect(nb.nodes.map((n: any) => n.id)).toContain("src:pubmed:888")
    h.close()
  })
})
