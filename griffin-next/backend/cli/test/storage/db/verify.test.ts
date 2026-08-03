import { afterEach, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { Backfill } from "../../../src/storage/db/backfill"
import { Verify } from "../../../src/storage/db/verify"

/**
 * Fully hermetic: its own data dir AND its own database.
 *
 * Both halves matter. Redirecting only the JSON side leaves the comparison
 * pointed at the process-wide database that every other suite in this
 * directory also writes to, so a row another test left behind shows up here as
 * `missing_in_json` and the failure has nothing to do with verify.
 */
const dirs: string[] = []

async function fixture(records: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-verify-"))
  dirs.push(dir)
  for (const [key, value] of Object.entries(records)) {
    const file = path.join(dir, "storage", ...key.split("/")) + ".json"
    await Bun.write(file, JSON.stringify(value, null, 2))
  }
  const handle = DatabaseClient.create(path.join(dir, "griffin.db"))
  Schema.migrate(handle)
  return { dataDir: dir, handle }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

test("backfill then verify yields zero diffs on clean data", async () => {
  const ctx = await fixture({
    "project/p1": { id: "p1", vcs: "git", worktree: "/app", time: { created: 1, updated: 2 } },
    "session/p1/s1": { id: "s1", projectID: "p1", title: "hello", time: { created: 1, updated: 2 } },
    "message/s1/m1": { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
    "part/m1/pt1": { id: "pt1", messageID: "m1", sessionID: "s1", type: "text", text: "hi" },
    "todo/s1": [{ id: "t1", content: "do it" }],
  })

  const backfilled = await Backfill.run(ctx)
  const res = await Verify.run(ctx)

  if (!res.ok) console.log("VERIFY DIFFS:", JSON.stringify(res.diffs, null, 2))
  expect(backfilled.processed).toBe(5)
  expect(res.diffs).toEqual([])
  expect(res.verified).toBe(5)
  expect(res.ok).toBeTrue()
})

test("a namespace with no projection mapping is unknown_namespace, not missing_in_db", async () => {
  // The distinction that matters: `missing_in_db` means projection is broken
  // for a namespace we own; `unknown_namespace` means a namespace exists that
  // the projection layer was never taught about. Conflating them drowns real
  // drift in false positives, which is how this gate stopped being usable.
  const ctx = await fixture({ "totally-made-up-namespace/x1": { hello: "world" } })

  await Backfill.run(ctx)
  const res = await Verify.run(ctx)

  const kinds = new Set(res.diffs.map((d) => d.kind))
  expect(kinds.has("unknown_namespace")).toBeTrue()
  expect(kinds.has("missing_in_db")).toBeFalse()
  expect(res.unknown).toEqual(["totally-made-up-namespace"])
  // Still fails the run — an unknown namespace demands a decision.
  expect(res.ok).toBeFalse()
})

test("backfill and verify agree on what is unknown", async () => {
  // These two used to disagree: backfill counted an unmapped record as an
  // error, verify called the same record missing_in_db. Both now classify
  // through Projection.classify.
  const ctx = await fixture({ "another-unmapped-ns/y1": { a: 1 } })

  const backfilled = await Backfill.run(ctx)
  const verified = await Verify.run(ctx)

  expect(backfilled.unknown).toEqual(["another-unmapped-ns"])
  expect(verified.unknown).toEqual(["another-unmapped-ns"])
  expect(backfilled.errors).toBe(0)
})

test("ignored namespaces are silent in both backfill and verify", async () => {
  // `permission` is never written by the app (its writer is commented out) and
  // `share` has no writer at all, so neither gets a table — but a stale file
  // from an older build must not be reported as drift.
  const ctx = await fixture({
    "permission/proj-1": [{ rule: "allow" }],
    "share/sh-1": { url: "https://example.invalid" },
  })

  const backfilled = await Backfill.run(ctx)
  const res = await Verify.run(ctx)

  expect(res.diffs).toEqual([])
  expect(res.unknown).toEqual([])
  expect(backfilled.unknown).toEqual([])
  expect(backfilled.skipped).toBe(2)
})

test("a record present in JSON but never projected is missing_in_db", async () => {
  const ctx = await fixture({ "project/p1": { id: "p1", worktree: "/app" } })
  // Deliberately skip backfill.
  const res = await Verify.run(ctx)

  expect(res.ok).toBeFalse()
  expect(res.diffs).toEqual([{ key: ["project", "p1"], kind: "missing_in_db" }])
})

test("a row present in the DB but not on disk is missing_in_json", async () => {
  const ctx = await fixture({ "project/p1": { id: "p1", worktree: "/app" } })
  await Backfill.run(ctx)
  await fs.rm(path.join(ctx.dataDir, "storage", "project", "p1.json"))

  const res = await Verify.run(ctx)
  expect(res.diffs).toEqual([{ key: ["project", "p1"], kind: "missing_in_json" }])
})

test("content drift between JSON and the projected row is detected", async () => {
  const ctx = await fixture({ "project/p1": { id: "p1", vcs: "git", worktree: "/app" } })
  await Backfill.run(ctx)
  expect((await Verify.run(ctx)).ok).toBeTrue()

  await Bun.write(
    path.join(ctx.dataDir, "storage", "project", "p1.json"),
    JSON.stringify({ id: "p1", vcs: "git", worktree: "/moved" }),
  )

  const res = await Verify.run(ctx)
  expect(res.ok).toBeFalse()
  expect(res.diffs.map((d) => d.kind)).toEqual(["content_mismatch"])
})

test("deep equality ignores key order", async () => {
  // The previous check was JSON.stringify(a) === JSON.stringify(b), which would
  // report a spurious mismatch the moment any writer reordered keys.
  const ctx = await fixture({ "project/p1": { id: "p1", vcs: "git", worktree: "/app" } })
  await Backfill.run(ctx)

  await Bun.write(
    path.join(ctx.dataDir, "storage", "project", "p1.json"),
    JSON.stringify({ worktree: "/app", vcs: "git", id: "p1" }, null, 2),
  )

  expect((await Verify.run(ctx)).ok).toBeTrue()
})

test("nested key order and array order are handled correctly", async () => {
  const ctx = await fixture({ "project/p1": { id: "p1", time: { created: 1, updated: 2 }, sandboxes: ["a", "b"] } })
  await Backfill.run(ctx)

  await Bun.write(
    path.join(ctx.dataDir, "storage", "project", "p1.json"),
    JSON.stringify({ sandboxes: ["a", "b"], time: { updated: 2, created: 1 }, id: "p1" }),
  )
  expect((await Verify.run(ctx)).ok).toBeTrue()

  // Array order, unlike key order, is significant.
  await Bun.write(
    path.join(ctx.dataDir, "storage", "project", "p1.json"),
    JSON.stringify({ id: "p1", time: { created: 1, updated: 2 }, sandboxes: ["b", "a"] }),
  )
  expect((await Verify.run(ctx)).ok).toBeFalse()
})
