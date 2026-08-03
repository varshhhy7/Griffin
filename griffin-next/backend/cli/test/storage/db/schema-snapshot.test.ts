import { expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Schema } from "../../../src/storage/db/schema"
import { DatabaseClient } from "../../../src/storage/db/client"
import { SCHEMA_SNAPSHOT } from "../../../src/cli/cmd/db"

// test/storage/db -> test -> cli -> backend -> griffin-next -> <repo root>
const snapshot = path.resolve(import.meta.dir, "../../../../../..", SCHEMA_SNAPSHOT)

/**
 * The schema snapshot is the contract the Python client
 * (`griffin/storage/`, `tests/test_schema_contract.py`) builds its fixture
 * from. Python cannot run the TypeScript migrations, and hand-writing the DDL
 * on the Python side produces a test that only proves Python agrees with
 * itself — it cannot detect the TypeScript drift it exists to catch.
 *
 * So the snapshot is generated from the one source of truth and checked in,
 * and this test fails on the TypeScript side — where any schema change
 * originates — the moment it goes stale.
 */
test("schemas/griffin-db.sql matches the migrations", async () => {
  const onDisk = await Bun.file(snapshot)
    .text()
    .catch(() => "")

  expect(onDisk).not.toBe("")
  expect(onDisk.replace(/\r\n/g, "\n")).toBe(Schema.sql().replace(/\r\n/g, "\n"))
})

test("the snapshot is executable and produces the same objects as migrate()", async () => {
  // Guards the other half: a snapshot that matches the source text but does not
  // actually run would still leave Python testing against nothing.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-snap-"))
  try {
    const fromSnapshot = DatabaseClient.create(path.join(dir, "snap.db"))
    fromSnapshot.db.exec(await Bun.file(snapshot).text())

    const fromMigrations = DatabaseClient.create(path.join(dir, "migrated.db"))
    Schema.migrate(fromMigrations)

    const objects = (h: DatabaseClient.Handle) =>
      (
        h.db
          .query("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
          .all() as { type: string; name: string }[]
      )
        // schema_migrations is bookkeeping created by the runner, not DDL.
        .filter((o) => o.name !== "schema_migrations")
        .map((o) => `${o.type}:${o.name}`)

    expect(objects(fromSnapshot)).toEqual(objects(fromMigrations))

    // The seeded vocabulary must survive the round trip too — it is data the
    // Python contract test reads.
    const count = (h: DatabaseClient.Handle) => (h.db.query("SELECT count(*) AS n FROM vocabulary").get() as any).n
    expect(count(fromSnapshot)).toBe(count(fromMigrations))
    expect(count(fromSnapshot)).toBeGreaterThan(0)

    fromSnapshot.close()
    fromMigrations.close()
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
