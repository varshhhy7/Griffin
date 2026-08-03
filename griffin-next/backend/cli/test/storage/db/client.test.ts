import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { MIGRATIONS } from "../../../src/storage/db/migrations"
import { Log } from "../../../src/util/log"

Log.init({ print: false })

async function tmpdb(name: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `griffin-db-${name}-`))
  const file = path.join(dir, "griffin.db")
  return {
    file,
    dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

describe("DatabaseClient", () => {
  test("opens in WAL with the expected pragmas", async () => {
    await using tmp = await tmpdb("pragma")
    const h = DatabaseClient.create(tmp.file)

    const one = (sql: string) => Object.values(h.db.query(sql).get() as Record<string, unknown>)[0]

    expect(String(one("PRAGMA journal_mode")).toLowerCase()).toBe("wal")
    expect(Number(one("PRAGMA foreign_keys"))).toBe(1)
    expect(Number(one("PRAGMA busy_timeout"))).toBe(5000)
    expect(Number(one("PRAGMA synchronous"))).toBe(1) // NORMAL

    h.close()
  })

  test("reopening an existing WAL database does not rewrite journal_mode", async () => {
    // The phase 0 finding: journal_mode is persistent in the file header, and
    // re-issuing `PRAGMA journal_mode = WAL` is what collides across processes.
    // configure() must read before it writes, so a reopen is contention-free.
    await using tmp = await tmpdb("reopen")
    DatabaseClient.create(tmp.file).close()

    const h = DatabaseClient.create(tmp.file)
    expect(String(Object.values(h.db.query("PRAGMA journal_mode").get() as any)[0]).toLowerCase()).toBe("wal")
    h.close()
  })

  test("a readonly handle rejects writes but still serves reads", async () => {
    await using tmp = await tmpdb("ro")
    const w = DatabaseClient.create(tmp.file)
    Schema.migrate(w)
    w.db.query("INSERT INTO project (id, json) VALUES (?, ?)").run("p1", "{}")

    // mode=rw + query_only=1, not mode=ro — a true read-only connection cannot
    // create the -shm file and fails SQLITE_CANTOPEN against a WAL database.
    const r = DatabaseClient.create(tmp.file, { readonly: true })
    expect((r.db.query("SELECT count(*) AS n FROM project").get() as any).n).toBe(1)
    expect(() => r.db.query("INSERT INTO project (id, json) VALUES (?, ?)").run("p2", "{}")).toThrow()

    r.close()
    w.close()
  })

  test("prepared statements are cached per connection", async () => {
    await using tmp = await tmpdb("stmt")
    const h = DatabaseClient.create(tmp.file)
    const sql = "SELECT 1 AS n"
    expect(h.stmt(sql)).toBe(h.stmt(sql))
    h.close()
  })

  test("integrity_check reports ok on a fresh database", async () => {
    await using tmp = await tmpdb("integrity")
    const h = DatabaseClient.create(tmp.file)
    Schema.migrate(h)
    expect(DatabaseClient.integrity(h)).toBe("ok")
    h.close()
  })
})

describe("Schema.migrate", () => {
  test("applies every migration and records each one", async () => {
    await using tmp = await tmpdb("migrate")
    const h = DatabaseClient.create(tmp.file)

    expect(Schema.current(h)).toBe(0)
    expect(Schema.migrate(h)).toBe(Schema.latest())

    expect(Schema.applied(h).map((x) => x.id)).toEqual(MIGRATIONS.map((m) => m.id))
    expect(Schema.applied(h).map((x) => x.name)).toEqual(MIGRATIONS.map((m) => m.name))

    h.close()
  })

  test("is idempotent", async () => {
    await using tmp = await tmpdb("idempotent")
    const h = DatabaseClient.create(tmp.file)

    Schema.migrate(h)
    const first = Schema.applied(h)
    Schema.migrate(h)

    expect(Schema.applied(h)).toEqual(first)
    h.close()
  })

  test("a failing migration rolls back its DDL and does NOT record a version", async () => {
    // The bug not to inherit from storage.ts:153-154, which bumps its counter
    // even when the migration throws and therefore skips it forever.
    await using tmp = await tmpdb("rollback")
    const h = DatabaseClient.create(tmp.file)
    Schema.migrate(h)
    const before = Schema.current(h)

    const bad = {
      id: before + 1,
      name: "intentionally_broken",
      sql: "CREATE TABLE ok_so_far (id TEXT); THIS IS NOT SQL;",
    }
    MIGRATIONS.push(bad)
    try {
      expect(() => Schema.migrate(h)).toThrow()

      // Version unchanged, so it retries next boot...
      expect(Schema.current(h)).toBe(before)
      // ...and the partial DDL was rolled back, so the retry starts clean.
      expect(() => h.db.query("SELECT 1 FROM ok_so_far").get()).toThrow()
    } finally {
      MIGRATIONS.pop()
    }

    h.close()
  })

  test("rejects a gap in migration ids", async () => {
    await using tmp = await tmpdb("gap")
    const h = DatabaseClient.create(tmp.file)

    MIGRATIONS.push({ id: Schema.latest() + 2, name: "gapped", sql: "SELECT 1;" })
    try {
      expect(() => Schema.migrate(h)).toThrow(/contiguous/)
    } finally {
      MIGRATIONS.pop()
    }

    h.close()
  })
})

describe("entity schema", () => {
  test("part cascades from message, which cascades from session", async () => {
    // This is what replaces the manual three-level delete loop at
    // session/index.ts:312-333, whose partial failures are currently silent.
    await using tmp = await tmpdb("cascade")
    const h = DatabaseClient.create(tmp.file)
    Schema.migrate(h)

    h.db.query("INSERT INTO session (id, project_id, json) VALUES (?, ?, ?)").run("s1", "p1", "{}")
    h.db.query("INSERT INTO message (id, session_id, json) VALUES (?, ?, ?)").run("m1", "s1", "{}")
    h.db.query("INSERT INTO part (id, message_id, json) VALUES (?, ?, ?)").run("pt1", "m1", "{}")

    h.db.query("DELETE FROM session WHERE id = ?").run("s1")

    expect((h.db.query("SELECT count(*) AS n FROM message").get() as any).n).toBe(0)
    expect((h.db.query("SELECT count(*) AS n FROM part").get() as any).n).toBe(0)

    h.close()
  })

  test("a session outlives its project — no FK from session to project", async () => {
    // project/project.ts:229 removes a project row while its sessions may still
    // exist. Encoding a constraint the app does not hold would make projection
    // throw on a normal operation.
    await using tmp = await tmpdb("noproj")
    const h = DatabaseClient.create(tmp.file)
    Schema.migrate(h)

    h.db.query("INSERT INTO session (id, project_id, json) VALUES (?, ?, ?)").run("s1", "ghost", "{}")
    expect((h.db.query("SELECT count(*) AS n FROM session").get() as any).n).toBe(1)

    h.close()
  })

  test("contract views expose the columns the Python client depends on", async () => {
    await using tmp = await tmpdb("views")
    const h = DatabaseClient.create(tmp.file)
    Schema.migrate(h)

    const expected: Record<string, string[]> = {
      v_project: ["id", "vcs", "worktree", "created_at", "initialized_at"],
      v_session: [
        "id",
        "project_id",
        "parent_id",
        "title",
        "slug",
        "directory",
        "version",
        "created_at",
        "updated_at",
        "archived_at",
      ],
      v_message: ["id", "session_id", "role", "agent", "model", "created_at"],
      v_research_run: [
        "id",
        "project_id",
        "session_id",
        "workflow_id",
        "workflow_version",
        "status",
        "created_at",
        "updated_at",
      ],
    }

    for (const [view, columns] of Object.entries(expected)) {
      const actual = (h.db.query(`PRAGMA table_info(${view})`).all() as { name: string }[]).map((c) => c.name)
      expect(actual).toEqual(columns)
    }

    h.close()
  })
})
