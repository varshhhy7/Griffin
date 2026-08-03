import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { GraphStore } from "../../../src/storage/db/graph/store"
import { Beam } from "../../../src/storage/db/graph/beam"

/**
 * Can the agent build a graph it can later traverse?
 *
 * It could create nodes long before it could create edges, which meant every
 * entity it recorded was an island: a claim about TP53 was reachable from its
 * source paper and from nowhere else, so a Think-on-Graph search starting at
 * TP53 found nothing. Knowledge that traversal cannot reach is, for every
 * question anyone actually asks, the same as knowledge that was never stored.
 *
 * These tests exercise the storage layer the `kb_*` tools write through.
 */
const dirs: string[] = []

async function kb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-kbauth-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)
  return h
}

const entity = (h: DatabaseClient.Handle, id: string, label: string) =>
  GraphStore.recordNode(h, {
    id,
    kind: "entity",
    subtype: "gene",
    label,
    recorded_at: 0,
    origin: "agent",
    review_state: "accepted",
  })

const claim = (h: DatabaseClient.Handle, id: string, label: string) =>
  GraphStore.recordNode(h, {
    id,
    kind: "claim",
    subtype: "assertion",
    label,
    recorded_at: 0,
    origin: "agent",
    confidence: 0.9,
    review_state: "unreviewed",
  })

const link = (h: DatabaseClient.Handle, from: string, to: string, relation: string) =>
  GraphStore.linkEdge(h, { from_id: from, to_id: to, relation, origin: "agent", created_at: 0 })

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("reachability", () => {
  test("a claim linked only to its source is unreachable from the entity it is about", async () => {
    // The defect, pinned so it cannot come back.
    const h = await kb()
    entity(h, "ent:tp53", "TP53")
    GraphStore.recordNode(h, {
      id: "src:p1",
      kind: "source",
      label: "a paper",
      recorded_at: 0,
      origin: "system",
      review_state: "accepted",
    })
    claim(h, "clm:1", "TP53 loss drives instability")
    link(h, "clm:1", "src:p1", "derived-from")

    expect(Beam.expand(h, ["ent:tp53"], { direction: "both", includeUnreviewed: true })).toEqual([])
    h.close()
  })

  test("a `mentions` link makes it reachable", async () => {
    const h = await kb()
    entity(h, "ent:tp53", "TP53")
    claim(h, "clm:1", "TP53 loss drives instability")
    link(h, "clm:1", "ent:tp53", "mentions")

    const reached = Beam.expand(h, ["ent:tp53"], { direction: "both", includeUnreviewed: true })
    expect(reached.map((n) => n.id)).toEqual(["clm:1"])
    h.close()
  })

  test("two hops: entity → claim → source", async () => {
    // The shape a real Think-on-Graph query needs: start at the gene, find what
    // is claimed about it, then find the evidence.
    const h = await kb()
    entity(h, "ent:tp53", "TP53")
    claim(h, "clm:1", "TP53 loss drives instability")
    GraphStore.recordNode(h, {
      id: "src:p1",
      kind: "source",
      label: "a paper",
      recorded_at: 0,
      origin: "system",
      review_state: "accepted",
    })
    link(h, "clm:1", "ent:tp53", "mentions")
    link(h, "clm:1", "src:p1", "derived-from")

    const hop1 = Beam.expand(h, ["ent:tp53"], { direction: "both", includeUnreviewed: true })
    expect(hop1.map((n) => n.id)).toEqual(["clm:1"])
    const hop2 = Beam.expand(h, ["clm:1"], { relations: ["derived-from"], includeUnreviewed: true })
    expect(hop2.map((n) => n.id)).toEqual(["src:p1"])
    h.close()
  })

  test("entities can be related to each other", async () => {
    const h = await kb()
    entity(h, "ent:tp53", "TP53")
    entity(h, "ent:mdm2", "MDM2")
    entity(h, "ent:p53", "p53")
    link(h, "ent:tp53", "ent:p53", "same-as")

    const reached = Beam.expand(h, ["ent:tp53"], { direction: "both", includeUnreviewed: true })
    expect(reached.map((n) => n.id)).toEqual(["ent:p53"])
    h.close()
  })

  test("supports and refutes attach evidence to a claim", async () => {
    const h = await kb()
    claim(h, "clm:1", "a contested claim")
    GraphStore.recordNode(h, {
      id: "src:for",
      kind: "source",
      label: "supporting paper",
      recorded_at: 0,
      origin: "system",
      review_state: "accepted",
    })
    GraphStore.recordNode(h, {
      id: "src:against",
      kind: "source",
      label: "contradicting paper",
      recorded_at: 0,
      origin: "system",
      review_state: "accepted",
    })
    link(h, "src:for", "clm:1", "supports")
    link(h, "src:against", "clm:1", "refutes")

    const relations = Beam.exploreRelations(h, ["clm:1"], { includeUnreviewed: true }).map((r) => r.relation)
    expect(relations.sort()).toEqual(["refutes", "supports"])
    h.close()
  })
})

describe("guard rails", () => {
  test("agent-authored edges are marked agent, never system", async () => {
    // Otherwise an assertion is indistinguishable from observed lineage in
    // every query and every view.
    const h = await kb()
    entity(h, "ent:a", "A")
    claim(h, "clm:1", "c")
    link(h, "clm:1", "ent:a", "mentions")

    const edge = h.db.query("SELECT origin FROM edge WHERE relation = 'mentions'").get() as any
    expect(edge.origin).toBe("agent")
    h.close()
  })

  test("a dangling edge is rejected by the schema, not silently written", async () => {
    const h = await kb()
    entity(h, "ent:a", "A")
    expect(() => link(h, "ent:a", "does-not-exist", "mentions")).toThrow()
    h.close()
  })

  test("linking the same pair twice does not duplicate the edge", async () => {
    const h = await kb()
    entity(h, "ent:a", "A")
    claim(h, "clm:1", "c")
    link(h, "clm:1", "ent:a", "mentions")
    link(h, "clm:1", "ent:a", "mentions")

    expect((h.db.query("SELECT count(*) AS n FROM edge").get() as any).n).toBe(1)
    h.close()
  })

  test("unreviewed agent claims stay out of default scope even when linked", async () => {
    // Linking must not launder an assertion into trusted knowledge.
    const h = await kb()
    entity(h, "ent:tp53", "TP53")
    claim(h, "clm:1", "an unreviewed claim")
    link(h, "clm:1", "ent:tp53", "mentions")

    expect(Beam.expand(h, ["ent:tp53"])).toEqual([])
    expect(Beam.expand(h, ["ent:tp53"], { includeUnreviewed: true }).map((n) => n.id)).toEqual(["clm:1"])
    h.close()
  })

  test("a revoked link stops being traversable without being deleted", async () => {
    const h = await kb()
    entity(h, "ent:tp53", "TP53")
    claim(h, "clm:1", "c")
    link(h, "clm:1", "ent:tp53", "mentions")
    h.db.query(`UPDATE edge SET revoked_at = 1`).run()

    expect(Beam.expand(h, ["ent:tp53"], { includeUnreviewed: true })).toEqual([])
    expect((h.db.query("SELECT count(*) AS n FROM edge").get() as any).n).toBe(1)
    h.close()
  })
})
