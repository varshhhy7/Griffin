import os from "os"
import { expect, test, beforeEach, afterEach } from "bun:test"
import { Projection } from "../../../src/storage/db/projection"
import { DatabaseClient } from "../../../src/storage/db/client"
import { DatabaseMode } from "../../../src/storage/db/mode"
import path from "path"
import fs from "fs/promises"

// Databases go to os.tmpdir(), never into the repo: files written under test/
// are not gitignored and get committed by a directory-wide `git add`.
const tmpDir = path.join(os.tmpdir(), "griffin-test-projection-" + process.pid)

beforeEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(tmpDir, { recursive: true }).catch(() => {})
  process.env.GRIFFIN_DB = "shadow"
  DatabaseClient.create(path.join(tmpDir, "test.db"))
  Projection.reset()
})

afterEach(async () => {
  delete process.env.GRIFFIN_DB
  DatabaseMode.reset()
  Projection.reset()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

test("Projection.map handles entity namespaces and ignores permission/share", () => {
  expect(Projection.map(["permission", "p1"], {})).toBeUndefined()
  expect(Projection.map(["share", "s1"], {})).toBeUndefined()

  const prj = Projection.map(["project", "p1"], { vcs: "git", worktree: "/app" })
  expect(prj?.table).toBe("project")
  expect(prj?.columns.id).toBe("p1")

  const ses = Projection.map(["session", "p1", "s1"], { title: "Test Session" })
  expect(ses?.table).toBe("session")
  expect(ses?.columns.id).toBe("s1")
  expect(ses?.columns.project_id).toBe("p1")

  const msg = Projection.map(["message", "s1", "m1"], { role: "user" })
  expect(msg?.table).toBe("message")
  expect(msg?.columns.id).toBe("m1")
  expect(msg?.columns.session_id).toBe("s1")

  const part = Projection.map(["part", "m1", "pr1"], { type: "tool", tool: "bash" })
  expect(part?.table).toBe("part")
  expect(part?.columns.id).toBe("pr1")

  const run = Projection.map(["research_run", "p1", "r1"], { status: "running" })
  expect(run?.table).toBe("research_run")
  expect(run?.columns.id).toBe("r1")
})

test("Projection.write and read round-trip correctly", async () => {
  await Projection.write(["project", "p1"], { id: "p1", vcs: "git", worktree: "/app" })
  await Projection.flush()

  const readBack = await Projection.read<any>(["project", "p1"])
  expect(readBack).toBeDefined()
  expect(readBack.id).toBe("p1")
  expect(readBack.vcs).toBe("git")
})
