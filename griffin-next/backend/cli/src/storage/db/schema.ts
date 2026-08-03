import { DatabaseClient } from "./client"
import { MIGRATIONS, type Migration } from "./migrations"
import { Log } from "../../util/log"

export namespace Schema {
  const log = Log.create({ service: "storage.db.schema" })

  const TABLE = /* sql */ `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `

  export function latest(): number {
    return MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0)
  }

  /**
   * The full schema as one SQL script, for consumers outside this runtime.
   *
   * The Python client (`griffin/storage/`) reads the same database and needs a
   * fixture to test against. Hand-writing that fixture in Python makes the
   * contract test unable to detect the drift it exists to catch — it would
   * only prove Python agrees with Python. Emitting the DDL from the single
   * source of truth, snapshotting it to `schemas/griffin-db.sql`, and building
   * the Python fixture from that snapshot keeps one definition and fails on the
   * TypeScript side, where any change originates.
   */
  export function sql(): string {
    const header = [
      "-- GENERATED FILE — DO NOT EDIT.",
      "-- Source: backend/cli/src/storage/db/migrations/index.ts",
      "-- Regenerate: cd griffin-next/backend/cli && bun run src/index.ts db schema --write",
      `-- schema_version: ${latest()}`,
      "",
    ].join("\n")
    const body = MIGRATIONS.sort((a, b) => a.id - b.id)
      .map((m) => `-- migration ${m.id}: ${m.name}\n${m.sql.trim()}`)
      .join("\n\n")
    return `${header}\n${body}\n`
  }

  export function current(handle: DatabaseClient.Handle): number {
    try {
      const row = handle.db.query("SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations").get() as { v: number } | null
      return row?.v ?? 0
    } catch {
      return 0
    }
  }

  export function applied(handle: DatabaseClient.Handle): { id: number; name: string; applied_at: number }[] {
    try {
      return handle.db.query("SELECT id, name, applied_at FROM schema_migrations ORDER BY id").all() as any
    } catch {
      return []
    }
  }

  function apply(handle: DatabaseClient.Handle, migration: Migration) {
    // One transaction per migration, covering the DDL *and* the version row.
    //
    // SQLite has transactional DDL, so a throw here rolls the schema back and
    // leaves the version unchanged — the migration is retried on next boot.
    // This is the specific bug not to inherit from storage.ts:153-154, which
    // bumps its counter even when the migration throws and therefore skips it
    // forever.
    handle.tx(() => {
      handle.db.exec(migration.sql)
      handle.db.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        Date.now(),
      )
    })
  }

  /**
   * Bring a database up to the latest schema. Idempotent.
   *
   * Throws on failure rather than logging and continuing — an unmigrated
   * database must not be written to, and in `shadow` mode the caller is what
   * decides that a throw is non-fatal.
   */
  export function migrate(handle: DatabaseClient.Handle = DatabaseClient.writer()): number {
    handle.db.exec(TABLE)
    const from = current(handle)
    const pending = MIGRATIONS.filter((m) => m.id > from).sort((a, b) => a.id - b.id)
    if (pending.length === 0) return from

    // Contiguity guard: a gap means a migration was renumbered or dropped,
    // which would silently skip schema the code assumes exists.
    let expect = from + 1
    for (const m of pending) {
      if (m.id !== expect) throw new Error(`migration ids must be contiguous: expected ${expect}, found ${m.id}`)
      expect++
    }

    for (const m of pending) {
      log.info("applying migration", { id: m.id, name: m.name })
      apply(handle, m)
    }
    return latest()
  }
}
