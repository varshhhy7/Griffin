import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { Backfill } from "../../../src/storage/db/backfill"
import { FTS } from "../../../src/storage/db/fts"
import { GraphQuery } from "../../../src/storage/db/graph/query"

const dirs: string[] = []

async function fixture(records: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-fts-"))
  dirs.push(dir)
  for (const [key, value] of Object.entries(records)) {
    await Bun.write(path.join(dir, "storage", ...key.split("/")) + ".json", JSON.stringify(value, null, 2))
  }
  const handle = DatabaseClient.create(path.join(dir, "griffin.db"))
  Schema.migrate(handle)
  return { dataDir: dir, handle }
}

afterEach(async () => {
  FTS.cancelDrain()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("schema", () => {
  test("fts tables are created by a migration, not lazily per call", async () => {
    // Lazily creating them left the tables outside the versioned schema, so
    // `db schema` did not describe the real database and every write paid for
    // two CREATE IF NOT EXISTS statements.
    const { handle } = await fixture()
    const names = (
      handle.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'fts%' ORDER BY name").all() as any[]
    ).map((r) => r.name)

    expect(names).toContain("fts_queue")
    expect(names).toContain("fts_part")
  })
})

describe("queue and drain", () => {
  test("queueing does not index; draining does", async () => {
    // The whole point of the deferred queue: tokenizing a large tool output is
    // the expensive part and must not happen on the write path.
    const { handle } = await fixture()
    FTS.queue(handle, "part", "p1", "differential expression of TP53 in tumour samples")

    expect(FTS.pending(handle)).toBe(1)
    expect(FTS.search(handle, "TP53")).toEqual([])

    expect(FTS.drain(handle)).toBe(1)
    expect(FTS.pending(handle)).toBe(0)
    expect(FTS.search(handle, "TP53").map((h) => h.id)).toEqual(["p1"])
  })

  test("re-queueing the same id replaces its text rather than duplicating", async () => {
    const { handle } = await fixture()
    FTS.queue(handle, "part", "p1", "first version mentions BRAF")
    FTS.drainAll(handle)
    FTS.queue(handle, "part", "p1", "second version mentions KRAS")
    FTS.drainAll(handle)

    expect(FTS.search(handle, "BRAF")).toEqual([])
    expect(FTS.search(handle, "KRAS").map((h) => h.id)).toEqual(["p1"])
  })

  test("indexed text is capped so a huge tool output is not a search corpus", async () => {
    const { handle } = await fixture()
    const marker = "UNIQUEMARKERWORD"
    FTS.queue(handle, "part", "p1", "x".repeat(FTS.MAX_INDEX_CHARS) + " " + marker)
    FTS.drainAll(handle)

    const stored = handle.db.query("SELECT text FROM fts_part WHERE id = 'p1'").get() as any
    expect(stored.text.length).toBe(FTS.MAX_INDEX_CHARS)
    // Past the cap, so genuinely not searchable — asserted rather than assumed.
    expect(FTS.search(handle, marker)).toEqual([])
  })

  test("empty or whitespace-only text is not queued", async () => {
    const { handle } = await fixture()
    FTS.queue(handle, "part", "p1", "   \n  ")
    expect(FTS.pending(handle)).toBe(0)
  })

  test("a malformed MATCH expression yields no results rather than throwing", async () => {
    // Models produce unbalanced quotes; FTS5 raises on those.
    const { handle } = await fixture()
    FTS.queue(handle, "part", "p1", "hello world")
    FTS.drainAll(handle)

    expect(() => FTS.search(handle, 'unbalanced "quote')).not.toThrow()
    expect(FTS.search(handle, 'unbalanced "quote')).toEqual([])
  })

  test("drain works in bounded slices", async () => {
    const { handle } = await fixture()
    for (let i = 0; i < 25; i++) FTS.queue(handle, "part", `p${i}`, `record number ${i} about genomics`)

    expect(FTS.drain(handle, 10)).toBe(10)
    expect(FTS.pending(handle)).toBe(15)
    expect(FTS.drainAll(handle)).toBe(15)
    expect(FTS.pending(handle)).toBe(0)
  })
})

describe("projection wiring", () => {
  test("backfill indexes text and tool-output parts, and nothing else", async () => {
    const { dataDir, handle } = await fixture({
      "project/p1": { id: "p1", worktree: "/repo" },
      "session/p1/s1": { id: "s1", projectID: "p1", title: "s" },
      "message/s1/m1": { id: "m1", sessionID: "s1", role: "assistant" },
      "part/m1/prt_text": { id: "prt_text", messageID: "m1", sessionID: "s1", type: "text", text: "mitochondrial" },
      "part/m1/prt_tool": {
        id: "prt_tool",
        messageID: "m1",
        sessionID: "s1",
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: {}, output: "ribosomal subunit assembly", title: "bash", metadata: {} },
      },
      "part/m1/prt_patch": { id: "prt_patch", messageID: "m1", sessionID: "s1", type: "patch", files: ["/a"] },
    })

    await Backfill.run({ dataDir, handle })
    FTS.drainAll(handle)

    expect(FTS.search(handle, "mitochondrial").map((h) => h.id)).toEqual(["prt_text"])
    expect(FTS.search(handle, "ribosomal").map((h) => h.id)).toEqual(["prt_tool"])
    // A patch part carries paths, not prose — indexing it is noise.
    expect(handle.db.query("SELECT count(*) AS n FROM fts_part").get()).toEqual({ n: 2 })
  })

  test("graph_search's content path resolves hits back to their part rows", async () => {
    const { dataDir, handle } = await fixture({
      "project/p1": { id: "p1", worktree: "/repo" },
      "session/p1/s1": { id: "s1", projectID: "p1", title: "s" },
      "message/s1/m1": { id: "m1", sessionID: "s1", role: "assistant" },
      "part/m1/prt1": {
        id: "prt1",
        messageID: "m1",
        sessionID: "s1",
        type: "text",
        text: "the assay showed elevated interleukin levels",
      },
    })
    await Backfill.run({ dataDir, handle })
    FTS.drainAll(handle)

    const hits = GraphQuery.searchContent(handle, "interleukin")
    expect(hits).toHaveLength(1)
    expect(hits[0].part_id).toBe("prt1")
    expect(hits[0].message_id).toBe("m1")
    expect(hits[0].session_id).toBe("s1")
    expect(hits[0].type).toBe("text")
    expect(hits[0].snippet).toContain("interleukin")
  })

  test("content search returns nothing for a term that was never written", async () => {
    const { handle } = await fixture()
    expect(GraphQuery.searchContent(handle, "nonexistentterm")).toEqual([])
  })
})
