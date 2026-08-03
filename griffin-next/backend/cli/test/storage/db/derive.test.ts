import os from "os"
import { expect, test, beforeEach, afterEach } from "bun:test"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { Derive } from "../../../src/storage/db/graph/derive"
import path from "path"
import fs from "fs/promises"

// Databases go to os.tmpdir(), never into the repo: files written under test/
// are not gitignored and get committed by a directory-wide `git add`.
const tmpDir = path.join(os.tmpdir(), "griffin-test-derive-" + process.pid)

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

test("Derive creates deterministic nodes and leaves content_hash NULL for system artifacts", () => {
  handle = DatabaseClient.create(path.join(tmpDir, "derive.db"))
  Schema.migrate(handle)

  handle.stmt(`INSERT INTO project (id, vcs, worktree, json) VALUES ('p1', 'git', '/app', '{}')`).run()
  handle.stmt(`INSERT INTO session (id, project_id, json) VALUES ('s1', 'p1', '{}')`).run()
  handle.stmt(`INSERT INTO message (id, session_id, role, created_at, json) VALUES ('m1', 's1', 'assistant', 1000, '{}')`).run()

  const partJson = JSON.stringify({
    type: "patch",
    files: ["src/main.ts"],
    hash: "patch_123",
  })
  handle.stmt(`INSERT INTO part (id, message_id, session_id, type, created_at, json) VALUES ('pr1', 'm1', 's1', 'patch', 1000, ?)`).run(partJson)

  Derive.deriveFromMessage(handle, "m1")

  const prjNode = handle.stmt(`SELECT * FROM node WHERE id = 'prj:p1'`).get() as any
  expect(prjNode).toBeDefined()
  expect(prjNode.kind).toBe("project")

  const sesNode = handle.stmt(`SELECT * FROM node WHERE id = 'ses:s1'`).get() as any
  expect(sesNode).toBeDefined()

  const msgNode = handle.stmt(`SELECT * FROM node WHERE id = 'msg:m1'`).get() as any
  expect(msgNode).toBeDefined()

  const artNodeId = Derive.artifactId("src/main.ts")
  const artNode = handle.stmt(`SELECT * FROM node WHERE id = ?`).get(artNodeId) as any
  expect(artNode).toBeDefined()
  expect(artNode.kind).toBe("artifact")
  expect(artNode.content_hash).toBeNull()
})
