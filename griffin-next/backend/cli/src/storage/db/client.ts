import { Database } from "bun:sqlite"
import path from "path"
import { Global } from "../../global"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

/**
 * The ONLY module in src/ permitted to name `bun:sqlite`.
 *
 * `backend/cli/package.json` maps `"exports": {"./*": "./src/*.ts"}`, so any
 * src module is one import away from the frontend bundle. A static specifier
 * is safe here — the phase 0 spike confirmed `bun:` builtins bypass
 * export-condition resolution under a `bun-*` compile target, so the CLI's
 * `conditions: ["browser"]` build (script/build.ts:159) resolves it fine — but
 * `test/storage/db/guard.test.ts` asserts exactly one file matches, so the
 * blast radius stays one module.
 */
export namespace DatabaseClient {
  const log = Log.create({ service: "storage.db" })

  export type Connection = Database

  /** Bumped only when the *physical* file layout changes, not per migration. */
  export const FILENAME = "griffin.db"

  export function file(): string {
    return path.join(Global.Path.data, FILENAME)
  }

  /**
   * Establish WAL exactly once, then never contend for it again.
   *
   * `PRAGMA journal_mode = WAL` takes a momentary exclusive lock. Two griffin
   * processes issuing it concurrently fail on Windows with
   * SQLITE_IOERR_TRUNCATE, and the failing process loses every write it went
   * on to attempt — observed directly in the phase 0 spike. Two rules follow:
   * `busy_timeout` must already be set (it does not retroactively cover a
   * pragma issued before it), and journal_mode must be READ before it is
   * written, since it is persistent in the file header.
   */
  function establishWal(db: Database, label: string) {
    const current = () => {
      const row = db.query("PRAGMA journal_mode").get() as Record<string, string> | null
      return String(Object.values(row ?? {})[0] ?? "").toLowerCase()
    }
    if (current() === "wal") return

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        db.exec("PRAGMA journal_mode = WAL")
        return
      } catch (e) {
        // A peer may have just won the race and already set it.
        if (current() === "wal") return
        if (attempt === 9) throw e
        Bun.sleepSync(25 + attempt * 25)
      }
    }
    throw new Error(`could not establish WAL on ${label}`)
  }

  function configure(db: Database, opts: { readonly: boolean; label: string }) {
    // MUST be first — everything below can contend with another process.
    db.exec("PRAGMA busy_timeout = 5000")
    if (!opts.readonly) establishWal(db, opts.label)
    db.exec("PRAGMA foreign_keys = ON")
    // NORMAL, not FULL: under WAL this risks only the last commits on an OS
    // crash, and JSON remains the rollback source through phase 14.
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec("PRAGMA cache_size = -16000")
    db.exec("PRAGMA mmap_size = 268435456")
    if (opts.readonly) db.exec("PRAGMA query_only = 1")
  }

  /**
   * A connection plus its prepared-statement cache.
   *
   * bun:sqlite is synchronous, so execution cost is negligible (~10-40us for a
   * single-row upsert) but *re-preparing* on every call is not. Every query
   * goes through `stmt()`.
   */
  export type Handle = {
    db: Database
    stmt: (sql: string) => ReturnType<Database["prepare"]>
    tx: <T>(fn: () => T) => T
    close: () => void
  }

  function wrap(db: Database): Handle {
    const cache = new Map<string, ReturnType<Database["prepare"]>>()
    const stmt = (sql: string) => {
      const hit = cache.get(sql)
      if (hit) return hit
      const prepared = db.prepare(sql)
      cache.set(sql, prepared)
      return prepared
    }
    return {
      db,
      stmt,
      tx: <T>(fn: () => T): T => db.transaction(fn)(),
      close: () => {
        // Cached statements must be finalized before the handle closes.
        // Leaving them outstanding keeps the file locked on Windows, which
        // surfaces as EBUSY on the next unlink — and would leave a stale lock
        // across a data-dir relocation.
        for (const prepared of cache.values()) {
          try {
            prepared.finalize()
          } catch {}
        }
        cache.clear()
        db.close()
      },
    }
  }

  /**
   * Open a connection at an explicit path.
   *
   * Exported as a factory because `Global.Path.data` is frozen at module import
   * (global/index.ts:62) and `test/preload.ts` fixes it per process — a test
   * cannot relocate it, so tests must be able to open their own database. This
   * is also what makes the cross-process concurrency test possible.
   */
  export function create(target: string, opts?: { readonly?: boolean }): Handle {
    const readonly = opts?.readonly ?? false
    // Note both open read-write at the SQLite level. A true `mode=ro`
    // connection cannot create the -shm file, so it fails SQLITE_CANTOPEN
    // against a WAL database with no live writer. Read-only is enforced with
    // `PRAGMA query_only = 1` in configure() instead. The Python client
    // (griffin/storage/db.py) must do the same.
    const db = new Database(target, { create: true })
    configure(db, { readonly, label: target })
    return wrap(db)
  }

  // Two connections against one WAL file. A slow recursive lineage query from a
  // server route must not block the streaming part writer, and WAL gives
  // concurrent readers for free.
  const writerState = lazy(() => {
    const handle = create(file())
    opened.push(handle)
    log.info("opened writer", { file: file() })
    return handle
  })

  const readerState = lazy(() => {
    const handle = create(file(), { readonly: true })
    opened.push(handle)
    return handle
  })

  /** The single writer. Owned by the projection layer; serialized by construction. */
  export function writer(): Handle {
    return writerState()
  }

  /** Reader for server routes, graph tools, and `db status`. */
  export function reader(): Handle {
    return readerState()
  }

  let opened: Handle[] = []

  /**
   * Close both connections and drop the memoized handles.
   *
   * Required before data-dir relocation: `settings/storage.ts` copies the whole
   * data dir, and copying a live WAL set yields a torn database.
   */
  export function close() {
    for (const handle of opened) {
      try {
        handle.close()
      } catch (e) {
        log.error("failed closing connection", { error: e })
      }
    }
    opened = []
    writerState.reset()
    readerState.reset()
  }

  /** `PRAGMA integrity_check` — run on boot, surfaced by `griffin db status`. */
  export function integrity(handle: Handle = reader()): string {
    const row = handle.db.query("PRAGMA integrity_check").get() as Record<string, string> | null
    return String(Object.values(row ?? {})[0] ?? "unknown")
  }
}
