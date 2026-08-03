import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { GraphReason } from "../../../src/storage/db/graph/reason"

const dirs: string[] = []

/**
 * A 3-hop chain plus a decoy branch, so pruning is observable:
 *
 *   TP53 --mentions--  claim  --derived-from--> paper --published-in--> venue
 *        --same-as-->  decoy (a dead end the pruner should avoid)
 */
async function kb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-reason-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)

  const node = (id: string, kind: string, label: string, accession?: string) =>
    h.db
      .query(
        `INSERT INTO node (id, kind, label, recorded_at, accession, authority, origin, review_state)
         VALUES (?, ?, ?, 0, ?, ?, 'system', 'accepted')`,
      )
      .run(id, kind, label, accession ?? null, accession ? "test" : null)
  const edge = (from: string, to: string, relation: string) =>
    h.db
      .query(`INSERT INTO edge (from_id, to_id, relation, origin, created_at) VALUES (?, ?, ?, 'system', 0)`)
      .run(from, to, relation)

  node("tp53", "entity", "TP53", "ENSG00000141510")
  node("claim", "claim", "TP53 is mutated in most cancers")
  node("paper", "source", "p53 mutations in cancer")
  node("venue", "source", "Nature Reviews Cancer")
  node("decoy", "entity", "unrelated thing")

  edge("claim", "tp53", "mentions")
  edge("claim", "paper", "derived-from")
  edge("paper", "venue", "derived-from")
  edge("tp53", "decoy", "same-as")

  h.db.query(`INSERT INTO alias (node_id, alias, normalized) VALUES ('tp53','TP53','tp53')`).run()
  return h
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

/** Pruner that follows a scripted plan, recording what it was offered. */
function scripted(plan: { relations?: string[][]; keepAll?: boolean; sufficientAtHop?: number }) {
  const offered: string[][] = []
  const pruners: GraphReason.Pruners = {
    relations: async ({ hop, options }) => {
      offered.push(options.map((o) => o.relation))
      return plan.relations?.[hop - 1] ?? []
    },
    entities: async ({ hop, candidates, width }) => ({
      keep: candidates.slice(0, width).map((c) => c.id),
      sufficient: plan.sufficientAtHop === hop,
    }),
  }
  return { pruners, offered }
}

describe("seeding", () => {
  test("links the question to exact matches and starts there", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "what is TP53?", terms: ["ENSG00000141510"] },
      GraphReason.passthroughPruners,
    )
    expect(r.seeds.map((s) => s.id)).toEqual(["tp53"])
    h.close()
  })

  test("an unlinkable question stops immediately rather than searching blindly", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "?", terms: ["nothing-in-this-graph"] },
      GraphReason.passthroughPruners,
    )
    expect(r.seeds).toEqual([])
    expect(r.hops).toEqual([])
    expect(r.stopped).toBe("exhausted")
    h.close()
  })

  test("exact matches win over fuzzy ones as seeds", async () => {
    // Starting a beam search from a guess propagates the guess through every
    // later hop, so an exact match must displace fuzzy candidates entirely.
    const h = await kb()
    const r = await GraphReason.run(h, { question: "q", terms: ["TP53"] }, GraphReason.passthroughPruners)
    expect(r.seeds.every((s) => s.exact)).toBeTrue()
    h.close()
  })
})

describe("traversal", () => {
  test("walks multiple hops and gathers the chain", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "which paper backs the TP53 claim?", terms: ["TP53"], depth: 3, width: 5 },
      GraphReason.passthroughPruners,
    )

    expect(r.visited).toContain("claim")
    expect(r.visited).toContain("paper")
    expect(r.hops.length).toBeGreaterThanOrEqual(2)
    h.close()
  })

  test("respects the depth cap", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "q", terms: ["TP53"], depth: 1 },
      GraphReason.passthroughPruners,
    )
    expect(r.hops).toHaveLength(1)
    expect(r.stopped).toBe("depth")
    h.close()
  })

  test("respects the beam width", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "q", terms: ["TP53"], depth: 1, width: 1 },
      GraphReason.passthroughPruners,
    )
    expect(r.hops[0].kept).toHaveLength(1)
    h.close()
  })

  test("stops early when a pruner reports the evidence sufficient", async () => {
    const h = await kb()
    const { pruners } = scripted({ sufficientAtHop: 1 })
    const r = await GraphReason.run(h, { question: "q", terms: ["TP53"], depth: 5 }, pruners)

    expect(r.hops).toHaveLength(1)
    expect(r.stopped).toBe("sufficient")
    expect(r.converged).toBeTrue()
    h.close()
  })

  test("stops when the branch is exhausted", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "q", terms: ["Nature Reviews Cancer"], depth: 5 },
      GraphReason.passthroughPruners,
    )
    expect(r.stopped).toBe("exhausted")
    h.close()
  })
})

describe("pruning", () => {
  test("the pruner sees the relations available at each hop", async () => {
    const h = await kb()
    const { pruners, offered } = scripted({ relations: [["mentions"]] })
    await GraphReason.run(h, { question: "q", terms: ["TP53"], depth: 1 }, pruners)

    expect(offered[0]).toContain("mentions")
    expect(offered[0]).toContain("same-as")
    h.close()
  })

  test("a chosen relation actually narrows the expansion", async () => {
    const h = await kb()
    const { pruners } = scripted({ relations: [["mentions"]] })
    const r = await GraphReason.run(h, { question: "q", terms: ["TP53"], depth: 1 }, pruners)

    // The decoy is only reachable via same-as, which was pruned away.
    expect(r.visited).toContain("claim")
    expect(r.visited).not.toContain("decoy")
    h.close()
  })

  test("a pruner that returns nothing falls back to all relations", async () => {
    // A model returning an empty or unparseable choice must not silently end
    // the search — that reads as "no answer exists" when none was looked for.
    const h = await kb()
    const { pruners } = scripted({ relations: [[]] })
    const r = await GraphReason.run(h, { question: "q", terms: ["TP53"], depth: 1 }, pruners)
    expect(r.hops[0].relationsChosen.length).toBeGreaterThan(0)
    h.close()
  })

  test("hallucinated relation names are discarded, not passed to SQL", async () => {
    const h = await kb()
    const { pruners } = scripted({ relations: [["definitely-not-a-relation"]] })
    const r = await GraphReason.run(h, { question: "q", terms: ["TP53"], depth: 1 }, pruners)

    // Filtered out, then fell back to the offered set rather than querying for
    // a relation that does not exist.
    expect(r.hops[0].relationsChosen).not.toContain("definitely-not-a-relation")
    expect(r.hops[0].reached).toBeGreaterThan(0)
    h.close()
  })

  test("hallucinated node ids in `keep` are discarded", async () => {
    const h = await kb()
    const pruners: GraphReason.Pruners = {
      relations: async ({ options }) => options.map((o) => o.relation),
      entities: async () => ({ keep: ["node-that-does-not-exist"], sufficient: false }),
    }
    const r = await GraphReason.run(h, { question: "q", terms: ["TP53"], depth: 1 }, pruners)

    expect(r.visited).not.toContain("node-that-does-not-exist")
    expect(r.hops[0].kept.length).toBeGreaterThan(0)
    h.close()
  })
})

describe("evidence", () => {
  test("returns triples among everything visited", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "which paper backs the TP53 claim?", terms: ["TP53"], depth: 3 },
      GraphReason.passthroughPruners,
    )

    expect(r.triples.length).toBeGreaterThan(0)
    expect(r.triples.some((t) => t.subject === "TP53 is mutated in most cancers")).toBeTrue()
    h.close()
  })

  test("caps are enforced regardless of what the caller asks for", async () => {
    const h = await kb()
    const r = await GraphReason.run(
      h,
      { question: "q", terms: ["TP53"], depth: 999, width: 999 },
      GraphReason.passthroughPruners,
    )
    expect(r.hops.length).toBeLessThanOrEqual(GraphReason.MAX_DEPTH)
    h.close()
  })
})
