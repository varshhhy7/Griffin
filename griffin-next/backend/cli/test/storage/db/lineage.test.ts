import { afterEach, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { GraphQuery } from "../../../src/storage/db/graph/query"

const dirs: string[] = []

/**
 * A minimal reproducibility DAG:
 *
 *   counts.tsv --consumed--> run_read
 *   run_patch  --produced--> figure.png
 *   figure.png --derived-from--> counts.tsv
 *
 * plus containment (`part-of`) edges to a shared message, which must NOT act
 * as lineage hops.
 */
async function graph() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-lineage-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)

  const node = (id: string, kind: string, label: string) =>
    h.db
      .query(
        `INSERT INTO node (id, kind, label, recorded_at, origin, review_state)
         VALUES (?, ?, ?, 0, 'system', 'accepted')`,
      )
      .run(id, kind, label)
  const edge = (from: string, to: string, relation: string) =>
    h.db
      .query(`INSERT INTO edge (from_id, to_id, relation, origin, created_at) VALUES (?, ?, ?, 'system', 0)`)
      .run(from, to, relation)

  node("msg", "message", "assistant")
  node("counts", "artifact", "counts.tsv")
  node("figure", "artifact", "figure.png")
  node("unrelated", "artifact", "unrelated.txt")
  node("run_read", "run", "read")
  node("run_patch", "run", "patch")

  edge("run_read", "counts", "consumed")
  edge("run_patch", "figure", "produced")
  edge("figure", "counts", "derived-from")
  // Containment: every run hangs off the same message, and an unrelated
  // artifact does too.
  edge("run_read", "msg", "part-of")
  edge("run_patch", "msg", "part-of")
  edge("unrelated", "msg", "part-of")

  return h
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

const labels = (r: { nodes: any[] }) => r.nodes.map((n) => n.label).sort()

test("ancestors of an output answer 'what produced this'", async () => {
  // The core reproducibility query, and the default direction. It previously
  // returned only the node itself: `produced` points run -> artifact, so an
  // output artifact has no outgoing edges to walk.
  const h = await graph()
  const got = labels(GraphQuery.lineage(h, { nodeId: "figure" }))

  expect(got).toContain("patch")
  expect(got).toContain("counts.tsv")
  h.close()
})

test("descendants answer 'what did this feed into'", async () => {
  const h = await graph()
  const got = labels(GraphQuery.lineage(h, { nodeId: "counts", direction: "descendants" }))

  expect(got).toContain("read")
  expect(got).toContain("figure.png")
  h.close()
})

test("part-of is containment, not lineage — it must not drag in siblings", async () => {
  // Every run is part-of the same message. Treating that as a lineage hop made
  // a two-hop query return the entire project through shared parents.
  const h = await graph()
  const got = labels(GraphQuery.lineage(h, { nodeId: "figure", direction: "both", maxDepth: 6 }))

  expect(got).not.toContain("unrelated.txt")
  expect(got).not.toContain("assistant")
  h.close()
})

test("depth cap is honoured", async () => {
  const h = await graph()
  // The base fixture is one hop deep in every direction, so it cannot
  // distinguish depths. Chain four artifacts to make the cap observable.
  for (let i = 0; i < 4; i++) {
    h.db
      .query(
        `INSERT INTO node (id, kind, label, recorded_at, origin, review_state)
         VALUES (?, 'artifact', ?, 0, 'system', 'accepted')`,
      )
      .run(`c${i}`, `chain-${i}`)
  }
  // c0 <- c1 <- c2 <- c3, so ancestors of c0 walk back up the chain.
  for (let i = 0; i < 3; i++) {
    h.db
      .query(
        `INSERT INTO edge (from_id, to_id, relation, origin, created_at)
         VALUES (?, ?, 'derived-from', 'system', 0)`,
      )
      .run(`c${i}`, `c${i + 1}`)
  }

  const depth = (d: number) => GraphQuery.lineage(h, { nodeId: "c0", direction: "ancestors", maxDepth: d }).nodes.length

  expect(depth(1)).toBe(2) // c0, c1
  expect(depth(2)).toBe(3) // + c2
  expect(depth(6)).toBe(4) // + c3, then exhausted
  h.close()
})

test("revoked edges are not traversed", async () => {
  // Correction is append-only: setting revoked_at, never DELETE.
  const h = await graph()
  h.db.query(`UPDATE edge SET revoked_at = 1 WHERE relation = 'produced'`).run()

  expect(labels(GraphQuery.lineage(h, { nodeId: "figure" }))).not.toContain("patch")
  h.close()
})

test("a cycle terminates instead of looping forever", async () => {
  const h = await graph()
  h.db
    .query(`INSERT INTO edge (from_id, to_id, relation, origin, created_at) VALUES ('counts','figure','derived-from',
            'system', 0)`)
    .run()

  const got = GraphQuery.lineage(h, { nodeId: "figure", direction: "both", maxDepth: 6 })
  expect(got.nodes.length).toBeGreaterThan(0)
  h.close()
})
