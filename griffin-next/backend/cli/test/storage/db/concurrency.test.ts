import { afterEach, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"

/**
 * Acceptance criterion 11: two `griffin` processes against one data dir must
 * not corrupt the database or lose writes.
 *
 * This needs real processes. `util/lock.ts` is a single-process, in-memory
 * lock keyed on an absolute path — it explicitly does not span processes, and
 * the data dir is user-relocatable and shared, so this is reachable in normal
 * use. WAL plus `busy_timeout` is the entire mechanism being tested.
 *
 * The COLD-START case is the important one. Establishing WAL takes a momentary
 * exclusive lock, and two processes racing it on Windows fail with
 * SQLITE_IOERR_TRUNCATE — the loser then silently loses every write it goes on
 * to attempt. Only the cold path exposes that; a warm database is already in
 * WAL and never contends. `client.ts` handles it by setting busy_timeout
 * first, reading journal_mode before writing it, and retrying on failure.
 */
const dirs: string[] = []

// The writer spins until a shared wall-clock start time before touching the
// database. Without that barrier, `bun run` startup jitter (~100ms, and
// variable) means the two processes reach the WAL pragma far apart and the
// race simply never happens — the test then passes even against a knowingly
// broken client, which is worse than having no test.
const WRITER = `
const [file, tag, count, startAt] = process.argv.slice(2)
const { DatabaseClient } = await import(${JSON.stringify(
  path.resolve(import.meta.dir, "../../../src/storage/db/client.ts").replace(/\\/g, "/"),
)})
while (Date.now() < Number(startAt)) {}
const h = DatabaseClient.create(file)
h.db.exec("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY, tag TEXT NOT NULL)")
const insert = h.stmt("INSERT OR REPLACE INTO t (id, tag) VALUES (?, ?)")
for (let i = 0; i < Number(count); i++) insert.run(tag + "-" + i, tag)
h.close()
`

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-conc-"))
  dirs.push(dir)
  const script = path.join(dir, "writer.ts")
  await Bun.write(script, WRITER)
  return { dir, script, file: path.join(dir, "griffin.db") }
}

/** Wall-clock instant every process in a batch unblocks at. */
function barrier(ms = 2500) {
  return Date.now() + ms
}

function spawn(script: string, file: string, tag: string, count: number, startAt: number) {
  return Bun.spawn(["bun", "run", script, file, tag, String(count), String(startAt)], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function settle(procs: ReturnType<typeof spawn>[]) {
  const codes = await Promise.all(procs.map((p) => p.exited))
  const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()))
  return { codes, errors }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

test(
  "two processes racing creation of a new database both succeed",
  async () => {
    const { script, file } = await scratch()
    const at = barrier()

    const { codes, errors } = await settle([
      spawn(script, file, "A", 300, at),
      spawn(script, file, "B", 300, at),
    ])

    expect(errors.filter(Boolean).join("\n")).not.toContain("SQLITE_IOERR")
    expect(codes).toEqual([0, 0])

    const h = DatabaseClient.create(file, { readonly: true })
    const count = (tag: string) => (h.db.query("SELECT count(*) AS n FROM t WHERE tag = ?").get(tag) as any).n
    // No lost writes: the failure mode this guards against is one process
    // exiting non-zero after writing nothing at all.
    expect(count("A")).toBe(300)
    expect(count("B")).toBe(300)
    expect(DatabaseClient.integrity(h)).toBe("ok")
    h.close()
  },
  60_000,
)

test(
  "three processes writing to an existing WAL database do not lose writes",
  async () => {
    const { script, file } = await scratch()
    await settle([spawn(script, file, "seed", 1, Date.now())])

    const at = barrier()
    const { codes } = await settle([
      spawn(script, file, "A", 300, at),
      spawn(script, file, "B", 300, at),
      spawn(script, file, "C", 300, at),
    ])
    expect(codes).toEqual([0, 0, 0])

    const h = DatabaseClient.create(file, { readonly: true })
    expect((h.db.query("SELECT count(*) AS n FROM t").get() as any).n).toBe(901)
    expect(DatabaseClient.integrity(h)).toBe("ok")
    h.close()
  },
  60_000,
)

test("journal_mode is persistent, so reopening never rewrites it", async () => {
  // The property that makes the steady state contention-free: WAL lives in the
  // file header, so configure() reads it and skips the exclusive-lock write.
  const { file } = await scratch()
  DatabaseClient.create(file).close()

  for (let i = 0; i < 5; i++) {
    const h = DatabaseClient.create(file)
    expect(String(Object.values(h.db.query("PRAGMA journal_mode").get() as any)[0]).toLowerCase()).toBe("wal")
    h.close()
  }
})
