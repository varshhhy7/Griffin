import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { Beam } from "../../../src/storage/db/graph/beam"

const dirs: string[] = []

/**
 * A small but realistic KB spanning both halves of the graph:
 *
 *   msg1 --mentions--> TP53 (entity, observed)
 *   msg1 --mentions--> paper1 (source, observed)
 *   claim1 --derived-from--> paper1        (agent, unreviewed)
 *   claim1 --mentions--> TP53              (agent, unreviewed)
 *   claim2 --derived-from--> paper1        (agent, ACCEPTED)
 *   TP53 --same-as--> p53_alias (entity, unreviewed duplicate)
 */
async function kb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-beam-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)

  const node = (
    id: string,
    kind: string,
    label: string,
    origin: string,
    review: string,
    extra: { accession?: string; authority?: string; subtype?: string } = {},
  ) =>
    h.db
      .query(
        `INSERT INTO node (id, kind, subtype, label, recorded_at, accession, authority, origin, review_state)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(id, kind, extra.subtype ?? null, label, extra.accession ?? null, extra.authority ?? null, origin, review)

  const edge = (from: string, to: string, relation: string, origin = "system", confidence: number | null = null) =>
    h.db
      .query(
        `INSERT INTO edge (from_id, to_id, relation, origin, confidence, created_at) VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(from, to, relation, origin, confidence)

  node("msg1", "message", "user asked about p53", "system", "accepted")
  node("tp53", "entity", "TP53", "system", "accepted", {
    accession: "ENSG00000141510",
    authority: "ensembl",
    subtype: "gene",
  })
  node("paper1", "source", "p53 mutations in cancer", "system", "accepted", {
    accession: "12345678",
    authority: "pubmed",
    subtype: "paper",
  })
  node("claim1", "claim", "TP53 is mutated in most cancers", "agent", "unreviewed", { subtype: "assertion" })
  node("claim2", "claim", "TP53 is a tumour suppressor", "agent", "accepted", { subtype: "assertion" })
  node("p53_alias", "entity", "p53", "agent", "unreviewed", { subtype: "gene" })

  h.db.query(`INSERT INTO alias (node_id, alias, normalized) VALUES ('tp53','TP53','tp53')`).run()
  h.db.query(`INSERT INTO alias (node_id, alias, normalized) VALUES ('tp53','tumour protein 53','tumour protein 53')`).run()

  edge("msg1", "tp53", "mentions")
  edge("msg1", "paper1", "mentions")
  edge("claim1", "paper1", "derived-from", "agent", 0.7)
  edge("claim1", "tp53", "mentions", "agent", 0.7)
  edge("claim2", "paper1", "derived-from", "agent", 0.95)
  edge("tp53", "p53_alias", "same-as", "agent", 0.6)

  return h
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("link (entity linking)", () => {
  test("an accession match is exact", async () => {
    const h = await kb()
    const [r] = Beam.link(h, ["ENSG00000141510"])
    expect(r.matches[0]?.id).toBe("tp53")
    expect(r.matches[0]?.exact).toBeTrue()
    h.close()
  })

  test("an alias match is exact and case-insensitive", async () => {
    const h = await kb()
    expect(Beam.link(h, ["tumour Protein 53"])[0].matches[0]?.id).toBe("tp53")
    expect(Beam.link(h, ["tumour Protein 53"])[0].matches[0]?.exact).toBeTrue()
    h.close()
  })

  test("a substring match is returned but flagged inexact", async () => {
    // ToG's answer quality depends on its starting entities, so a guess must
    // be visibly a guess.
    const h = await kb()
    const [r] = Beam.link(h, ["mutations in cancer"])
    expect(r.matches[0]?.id).toBe("paper1")
    expect(r.matches[0]?.exact).toBeFalse()
    h.close()
  })

  test("unreviewed nodes are excluded from linking by default", async () => {
    const h = await kb()
    expect(Beam.link(h, ["p53"])[0].matches.map((m) => m.id)).not.toContain("p53_alias")
    expect(Beam.link(h, ["p53"], { includeUnreviewed: true })[0].matches.map((m) => m.id)).toContain("p53_alias")
    h.close()
  })
})

describe("exploreRelations", () => {
  test("reports relations, direction, reach, and target kinds without expanding", async () => {
    const h = await kb()
    const options = Beam.exploreRelations(h, ["paper1"])

    const derived = options.find((o) => o.relation === "derived-from")
    expect(derived).toBeDefined()
    expect(derived!.direction).toBe("in")
    expect(derived!.kinds).toEqual(["claim"])
    // claim1 is unreviewed and excluded; only claim2 is accepted.
    expect(derived!.reaches).toBe(1)
    h.close()
  })

  test("is sorted by reach, so the model sees the widest branch first", async () => {
    const h = await kb()
    const options = Beam.exploreRelations(h, ["msg1", "paper1"], { includeUnreviewed: true })
    for (let i = 1; i < options.length; i++) {
      expect(options[i - 1].reaches).toBeGreaterThanOrEqual(options[i].reaches)
    }
    h.close()
  })

  test("an exhausted frontier reports no relations", async () => {
    const h = await kb()
    // An isolated node — p53_alias is NOT isolated, it has an incoming
    // same-as edge from tp53.
    h.db
      .query(
        `INSERT INTO node (id, kind, label, recorded_at, origin, review_state)
         VALUES ('lonely','entity','orphan',0,'system','accepted')`,
      )
      .run()
    expect(Beam.exploreRelations(h, ["lonely"])).toEqual([])
    h.close()
  })

  test("an empty frontier is not an error", async () => {
    const h = await kb()
    expect(Beam.exploreRelations(h, [])).toEqual([])
    h.close()
  })
})

describe("expand", () => {
  test("carries the path that reached each node", async () => {
    // Without `via`, the evidence path has to be reconstructed afterwards,
    // which is ambiguous whenever more than one path exists.
    const h = await kb()
    const nodes = Beam.expand(h, ["msg1"], { relations: ["mentions"] })

    const tp53 = nodes.find((n) => n.id === "tp53")!
    expect(tp53.via).toEqual({ from: "msg1", relation: "mentions", direction: "out" })
    h.close()
  })

  test("filters by relation, direction, and kind", async () => {
    const h = await kb()
    expect(Beam.expand(h, ["paper1"], { relations: ["derived-from"], direction: "in" }).map((n) => n.id)).toEqual([
      "claim2",
    ])
    expect(Beam.expand(h, ["msg1"], { kinds: ["source"] }).map((n) => n.id)).toEqual(["paper1"])
    h.close()
  })

  test("excludes unreviewed agent assertions by default", async () => {
    // Default query scope is trusted-only; criterion 9.
    const h = await kb()
    expect(Beam.expand(h, ["paper1"]).map((n) => n.id)).not.toContain("claim1")
    expect(Beam.expand(h, ["paper1"], { includeUnreviewed: true }).map((n) => n.id)).toContain("claim1")
    h.close()
  })

  test("does not traverse revoked edges", async () => {
    const h = await kb()
    h.db.query(`UPDATE edge SET revoked_at = 1 WHERE relation = 'mentions'`).run()
    expect(Beam.expand(h, ["msg1"])).toEqual([])
    h.close()
  })

  test("deduplicates nodes reachable by more than one path", async () => {
    const h = await kb()
    const nodes = Beam.expand(h, ["msg1", "claim1"], { includeUnreviewed: true })
    const ids = nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    h.close()
  })

  test("caps the frontier and the result set", async () => {
    const h = await kb()
    const huge = Array.from({ length: 500 }, (_, i) => `n${i}`)
    expect(() => Beam.expand(h, huge, { limit: 10_000 })).not.toThrow()
    expect(Beam.expand(h, [...huge, "msg1"], { limit: 10_000 }).length).toBeLessThanOrEqual(Beam.MAX_ROWS)
    h.close()
  })
})

describe("evidence", () => {
  test("serializes triples with labels and trust, not bare ids", async () => {
    const h = await kb()
    const triples = Beam.evidence(h, ["msg1", "tp53", "paper1"])

    expect(triples).toContainEqual({
      subject: "user asked about p53",
      relation: "mentions",
      object: "TP53",
      origin: "system",
      confidence: null,
    })
    h.close()
  })

  test("agent-asserted edges carry their confidence so they can be cited differently", async () => {
    const h = await kb()
    const triples = Beam.evidence(h, ["claim2", "paper1"])
    const t = triples.find((x) => x.relation === "derived-from")!

    expect(t.origin).toBe("agent")
    expect(t.confidence).toBe(0.95)
    h.close()
  })

  test("only edges between the supplied nodes are returned", async () => {
    const h = await kb()
    expect(Beam.evidence(h, ["msg1", "tp53"]).every((t) => t.object !== "p53 mutations in cancer")).toBeTrue()
    h.close()
  })

  test("unconnected nodes yield no triples", async () => {
    const h = await kb()
    expect(Beam.evidence(h, ["tp53", "claim2"])).toEqual([])
    h.close()
  })
})

describe("a full Think-on-Graph traversal", () => {
  test("question -> link -> explore -> prune -> expand -> evidence", async () => {
    // The whole loop, with the model's pruning decisions made explicitly here.
    const h = await kb()

    // 1. Entity linking from "what do we know about TP53?"
    const linked = Beam.link(h, ["TP53"])
    const frontier = linked[0].matches.filter((m) => m.exact).map((m) => m.id)
    expect(frontier).toEqual(["tp53"])

    // 2. Which relations leave it?
    const relations = Beam.exploreRelations(h, frontier, { includeUnreviewed: true })
    expect([...new Set(relations.map((r) => r.relation))].sort()).toEqual(["mentions", "same-as"])

    // 3. Prune to the ones that could answer a "what do we know" question —
    //    this is the step the model performs in a real traversal.
    const chosen = [...new Set(relations.filter((r) => r.relation === "mentions").map((r) => r.relation))]

    // 4. Expand.
    const hop1 = Beam.expand(h, frontier, { relations: chosen, includeUnreviewed: true })
    expect(hop1.map((n) => n.id).sort()).toEqual(["claim1", "msg1"])

    // 5. Second hop from the claim to its source.
    const hop2 = Beam.expand(h, ["claim1"], { relations: ["derived-from"], includeUnreviewed: true })
    expect(hop2.map((n) => n.id)).toEqual(["paper1"])

    // 6. Cite.
    const gathered = ["tp53", ...hop1.map((n) => n.id), ...hop2.map((n) => n.id)]
    const triples = Beam.evidence(h, gathered)
    expect(triples.length).toBeGreaterThan(0)
    // The claim is agent-asserted, so its edge must not read as observed.
    expect(triples.some((t) => t.origin === "agent")).toBeTrue()
    expect(triples.some((t) => t.origin === "system")).toBeTrue()
    h.close()
  })

  test("the default trusted-only path never surfaces an unreviewed claim", async () => {
    const h = await kb()
    const hop = Beam.expand(h, ["tp53"])
    expect(hop.map((n) => n.id)).not.toContain("claim1")
    expect(hop.map((n) => n.id)).not.toContain("p53_alias")
    h.close()
  })
})
