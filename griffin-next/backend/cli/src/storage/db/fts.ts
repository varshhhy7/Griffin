import { DatabaseClient } from "./client"
import { Log } from "../../util/log"

/**
 * Deferred full-text indexing.
 *
 * The schema lives in migration 4, not here — an `ensureSchema()` on every call
 * runs a transaction with two `CREATE ... IF NOT EXISTS` statements per write,
 * which is pure overhead on the hot path and leaves the tables outside the
 * versioned schema (so `db schema` would not describe the real database).
 *
 * Writers call `queue()`, a single cheap upsert. Tokenizing — the genuinely
 * expensive part for a multi-megabyte tool output — happens in `drain()`, on an
 * idle timer, in bounded slices. bun:sqlite is synchronous, so indexing inline
 * would block the event loop mid-response and stall SSE to the browser.
 */
export namespace FTS {
  const log = Log.create({ service: "storage.db.fts" })

  /** Per-record cap on indexed text. A 5 MB bash output is not a search corpus. */
  export const MAX_INDEX_CHARS = 64 * 1024

  /** Milliseconds of quiet before the queue is drained. */
  const IDLE_MS = 750

  /** Upper bound on one drain slice, to keep any single tick short. */
  const SLICE = 100

  export type Kind = "part" | "claim" | "source" | "alias"

  export function queue(handle: DatabaseClient.Handle, kind: Kind, id: string, text: string): void {
    const trimmed = text?.trim()
    if (!trimmed) return
    handle
      .stmt(
        `INSERT INTO fts_queue (id, kind, text, queued_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, kind = excluded.kind, queued_at = excluded.queued_at`,
      )
      .run(id, kind, trimmed.slice(0, MAX_INDEX_CHARS), Date.now())
  }

  export function pending(handle: DatabaseClient.Handle): number {
    try {
      return (handle.stmt(`SELECT count(*) AS n FROM fts_queue`).get() as { n: number })?.n ?? 0
    } catch {
      return 0
    }
  }

  /** Index one slice. Returns how many rows were processed. */
  export function drain(handle: DatabaseClient.Handle, slice = SLICE): number {
    let rows: { id: string; kind: string; text: string }[]
    try {
      rows = handle.stmt(`SELECT id, kind, text FROM fts_queue ORDER BY queued_at LIMIT ?`).all(slice) as any
    } catch (e) {
      // Schema not migrated yet — nothing to do rather than a hard failure.
      log.error("fts drain skipped", { error: e })
      return 0
    }
    if (rows.length === 0) return 0

    handle.tx(() => {
      for (const row of rows) {
        handle.stmt(`DELETE FROM fts_part WHERE id = ?`).run(row.id)
        handle.stmt(`INSERT INTO fts_part (id, kind, text) VALUES (?, ?, ?)`).run(row.id, row.kind, row.text)
        handle.stmt(`DELETE FROM fts_queue WHERE id = ?`).run(row.id)
      }
    })
    return rows.length
  }

  /** Drain until empty. Used by tests, `db backfill`, and `db status`. */
  export function drainAll(handle: DatabaseClient.Handle, max = 100_000): number {
    let total = 0
    for (;;) {
      const n = drain(handle)
      if (n === 0 || total >= max) return total
      total += n
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * Schedule an idle drain. Repeated calls during a burst coalesce into one.
   *
   * `unref()` matters: without it a pending timer keeps a short-lived CLI
   * process alive past the end of its work.
   */
  export function scheduleDrain(handle: DatabaseClient.Handle): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      try {
        drain(handle)
        // More queued than one slice — come back rather than blocking here.
        if (pending(handle) > 0) scheduleDrain(handle)
      } catch (e) {
        log.error("idle fts drain failed", { error: e })
      }
    }, IDLE_MS)
    timer.unref?.()
  }

  export function cancelDrain(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  export interface Hit {
    id: string
    kind: string
    snippet: string
  }

  export function search(handle: DatabaseClient.Handle, query: string, limit = 50): Hit[] {
    const term = query.trim()
    if (!term) return []
    try {
      return handle
        .stmt(
          `SELECT id, kind, snippet(fts_part, 2, '', '', '…', 12) AS snippet
           FROM fts_part WHERE fts_part MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(term, limit) as Hit[]
    } catch {
      // A malformed FTS5 MATCH expression (an unbalanced quote from a model,
      // say) throws. Treat it as no results rather than surfacing a SQL error.
      return []
    }
  }
}
