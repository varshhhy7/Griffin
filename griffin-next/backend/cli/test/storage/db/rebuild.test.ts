import os from "os"
import { expect, test, beforeEach, afterEach } from "bun:test"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { GraphStore } from "../../../src/storage/db/graph/store"
import path from "path"
import fs from "fs/promises"

// Databases go to os.tmpdir(), never into the repo: files written under test/
// are not gitignored and get committed by a directory-wide `git add`.
const tmpDir = path.join(os.tmpdir(), "griffin-test-rebuild-" + process.pid)
let handle: DatabaseClient.Handle | undefined

beforeEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(tmpDir, { recursive: true }).catch(() => {})
})

afterEach(async () => {
  if (handle) {
    try { handle.db.close() } catch {}
  }
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

test("GraphStore rebuild preserves agent/user nodes while re-deriving system nodes", () => {
  handle = DatabaseClient.create(path.join(tmpDir, "rebuild.db"))
  Schema.migrate(handle)

  // System entities
  handle.stmt(`INSERT INTO project (id, vcs, worktree, json) VALUES ('p1', 'git', '/app', '{}')`).run()
  handle.stmt(`INSERT INTO session (id, project_id, json) VALUES ('s1', 'p1', '{}')`).run()
  handle.stmt(`INSERT INTO message (id, session_id, role, created_at, json) VALUES ('m1', 's1', 'assistant', 1000, '{}')`).run()

  // Agent node
  GraphStore.recordNode(handle, {
    id: "clm:agent_claim_1",
    kind: "claim",
    label: "Agent Claim",
    recorded_at: 1000,
    origin: "agent",
    review_state: "unreviewed",
  })

  // Perform rebuild
  const res = GraphStore.rebuild(handle)
  expect(res.systemNodes).toBeGreaterThan(0)

  // Verify agent node survived rebuild
  const agentNode = handle.stmt(`SELECT * FROM node WHERE id = 'clm:agent_claim_1'`).get() as any
  expect(agentNode).toBeDefined()
  expect(agentNode.origin).toBe("agent")
})

/**
 * Columns compared for rebuild determinism (acceptance criterion 5).
 *
 * `derived_at` is excluded on purpose: it is a wall-clock watermark recording
 * *when* derivation ran, not what the graph contains, so it necessarily differs
 * between rebuilds. Everything that describes the graph itself — including
 * `recorded_at`, which comes from the message's own creation time rather than
 * `Date.now()` — must be byte-identical.
 */
const CONTENT_COLUMNS = [
  "id",
  "kind",
  "subtype",
  "label",
  "recorded_at",
  "entity_type",
  "entity_id",
  "content_hash",
  "hash_algo",
  "accession",
  "authority",
  "origin",
  "confidence",
  "source_node_id",
  "review_state",
  "merged_into",
  "meta",
].join(", ")

test("rebuild is deterministic in everything except the derivation watermark", () => {
  handle = DatabaseClient.create(path.join(tmpDir, "determinism.db"))
  Schema.migrate(handle)

  handle.stmt(`INSERT INTO project (id, vcs, worktree, json) VALUES ('p1','git','/app','{}')`).run()
  handle.stmt(`INSERT INTO session (id, project_id, json) VALUES ('s1','p1','{}')`).run()
  for (const [id, at] of [
    ["m1", 1000],
    ["m2", 2000],
  ] as const) {
    handle
      .stmt(`INSERT INTO message (id, session_id, role, created_at, json) VALUES (?, 's1', 'assistant', ?, '{}')`)
      .run(id, at)
  }
  handle
    .stmt(
      `INSERT INTO part (id, message_id, session_id, type, tool, json)
       VALUES ('pt1','m1','s1','tool','read','{}'), ('pt2','m2','s1','patch',NULL,'{}')`,
    )
    .run()

  const snapshot = () =>
    JSON.stringify([
      handle!.stmt(`SELECT ${CONTENT_COLUMNS} FROM node ORDER BY id`).all(),
      handle!
        .stmt(`SELECT from_id, to_id, relation, origin, confidence, revoked_at, meta FROM edge
               ORDER BY from_id, to_id, relation`)
        .all(),
    ])

  GraphStore.rebuild(handle)
  const first = snapshot()
  GraphStore.rebuild(handle)
  const second = snapshot()
  GraphStore.rebuild(handle)

  expect(second).toBe(first)
  expect(snapshot()).toBe(first)

  // And confirm the excluded column really is the only thing that moves, so
  // this test cannot quietly become vacuous by excluding too much.
  const watermarks = () => handle!.stmt(`SELECT derived_at FROM node WHERE derived_at IS NOT NULL`).all()
  const before = JSON.stringify(watermarks())
  Bun.sleepSync(5)
  GraphStore.rebuild(handle)
  expect(JSON.stringify(watermarks())).not.toBe(before)
})
