import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { Backfill } from "../../../src/storage/db/backfill"
import { Readiness } from "../../../src/storage/db/readiness"

const dirs: string[] = []

async function fixture(records: Record<string, unknown>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-ready-"))
  dirs.push(dir)
  for (const [key, value] of Object.entries(records)) {
    await Bun.write(path.join(dir, "storage", ...key.split("/")) + ".json", JSON.stringify(value))
  }
  const handle = DatabaseClient.create(path.join(dir, "griffin.db"))
  Schema.migrate(handle)
  return { dataDir: dir, handle }
}

afterEach(async () => {
  delete process.env["GRIFFIN_DB_SKIP_READINESS"]
  Readiness.reset()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("check", () => {
  test("an un-backfilled database is not ready, and says which namespaces", async () => {
    // The failure this exists to prevent: `primary` reads succeed against a
    // partial database and return SHORTER LISTS, which reads as deletion.
    const ctx = await fixture({
      "project/p1": { id: "p1" },
      "project/p2": { id: "p2" },
      "session/p1/s1": { id: "s1", projectID: "p1" },
    })

    const report = await Readiness.check(ctx)

    expect(report.ready).toBeFalse()
    expect(report.missing.map((m) => m.namespace).sort()).toEqual(["project", "session"])
    expect(report.missing.find((m) => m.namespace === "project")).toMatchObject({ json: 2, rows: 0 })
  })

  test("a backfilled database is ready", async () => {
    const ctx = await fixture({
      "project/p1": { id: "p1" },
      "session/p1/s1": { id: "s1", projectID: "p1" },
      "message/s1/m1": { id: "m1", sessionID: "s1", role: "user" },
    })
    await Backfill.run(ctx)

    const report = await Readiness.check(ctx)
    expect(report.missing).toEqual([])
    expect(report.ready).toBeTrue()
  })

  test("an empty install is ready — nothing is missing", async () => {
    const ctx = await fixture({})
    expect((await Readiness.check(ctx)).ready).toBeTrue()
  })

  test("rows exceeding files does NOT block reads", async () => {
    // A row whose JSON was deleted is `db verify`'s business. Only the reverse
    // direction hides data from the user, and blocking on it would make the
    // gate red for a condition that costs nobody anything.
    const ctx = await fixture({ "project/p1": { id: "p1" } })
    await Backfill.run(ctx)
    await fs.rm(path.join(ctx.dataDir, "storage", "project", "p1.json"))

    const report = await Readiness.check(ctx)
    expect(report.ready).toBeTrue()
  })

  test("namespaces with no table never block the gate", async () => {
    // `permission` and `share` are deliberately unprojected. Counting them
    // would make readiness permanently unreachable.
    const ctx = await fixture({
      "permission/proj-1": [{ rule: "allow" }],
      "share/sh-1": { url: "https://example.invalid" },
    })
    expect((await Readiness.check(ctx)).ready).toBeTrue()
  })

  test("orphaned records do not block readiness forever", async () => {
    // A part whose message is gone fails its foreign key, so backfill can
    // never insert it. Counting it as missing would make readiness permanently
    // unreachable — the guard would become a wall. Partial deletes are real:
    // `Session.remove` is a three-level loop wrapped in a try/catch that only
    // log.errors.
    const ctx = await fixture({
      "project/p1": { id: "p1" },
      "session/p1/s1": { id: "s1", projectID: "p1" },
      "message/s1/m1": { id: "m1", sessionID: "s1", role: "user" },
      "part/m1/pt1": { id: "pt1", messageID: "m1", type: "text" },
      // Orphans: parents were deleted.
      "part/GONE/pt2": { id: "pt2", messageID: "GONE", type: "text" },
      "message/GONE/m2": { id: "m2", sessionID: "GONE", role: "user" },
    })
    await Backfill.run(ctx)

    const report = await Readiness.check(ctx)
    expect(report.ready).toBeTrue()
    expect(report.orphaned).toEqual({ part: 1, message: 1 })
  })

  test("orphans are named in the explanation rather than hidden", async () => {
    const ctx = await fixture({
      "project/p1": { id: "p1" },
      "part/GONE/pt": { id: "pt", messageID: "GONE" },
    })
    const text = Readiness.explain(await Readiness.check(ctx))
    expect(text).toContain("cannot be projected")
    expect(text).toContain("1 part")
  })

  test("an unknown namespace does not block either", async () => {
    // It is reported by `db verify` as unknown_namespace; it must not also
    // wedge the read path.
    const ctx = await fixture({ "made-up-thing/x": { a: 1 } })
    expect((await Readiness.check(ctx)).ready).toBeTrue()
  })
})

describe("explain", () => {
  test("names the counts, the remedy, and reassures nothing is lost", async () => {
    const ctx = await fixture({ "project/p1": { id: "p1" } })
    const text = Readiness.explain(await Readiness.check(ctx))

    expect(text).toContain("project: 1 on disk, 0 in the database")
    expect(text).toContain("griffin db backfill")
    expect(text).toContain("the JSON")
    expect(text).toContain("GRIFFIN_DB_SKIP_READINESS")
  })
})

describe("assertReady", () => {
  test("the override is respected", async () => {
    process.env["GRIFFIN_DB_SKIP_READINESS"] = "1"
    Readiness.reset()
    expect(Readiness.overridden()).toBeTrue()
    // Resolves without touching the filesystem.
    await Readiness.assertReady()
  })

  test("concurrent first calls share one check", async () => {
    process.env["GRIFFIN_DB_SKIP_READINESS"] = "1"
    Readiness.reset()
    const a = Readiness.assertReady()
    const b = Readiness.assertReady()
    expect(a).toBe(b)
    await a
  })

  test("a failed check is retryable rather than poisoning the process", async () => {
    // Memoizing a rejected promise would mean a transient filesystem error
    // wedges every subsequent read until restart.
    Readiness.reset()
    delete process.env["GRIFFIN_DB_SKIP_READINESS"]
    const first = Readiness.assertReady().then(
      () => "ok",
      () => "failed",
    )
    await first

    process.env["GRIFFIN_DB_SKIP_READINESS"] = "1"
    Readiness.reset()
    await Readiness.assertReady()
  })
})
