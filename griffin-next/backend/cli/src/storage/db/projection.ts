import { DatabaseClient } from "./client"
import { Schema } from "./schema"
import { DatabaseMode } from "./mode"
import { FTS } from "./fts"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

/**
 * Projects `Storage` key/payload pairs into the entity layer.
 *
 * Every table keeps the FULL payload in `json`; the extracted columns exist
 * only for indexing and joins and are never the source of truth. That is what
 * makes `Storage.read` byte-identical in `primary` mode and makes `db verify` a
 * literal deep-equality check rather than an argument about schema mapping.
 */
export namespace Projection {
  const log = Log.create({ service: "storage.db.projection" })

  /** Namespaces with no table. Projection is a no-op; reads keep JSON semantics. */
  const IGNORED = new Set([
    // Never written — the writer at permission/next.ts:225 is commented out.
    "permission",
    // Read at session/index.ts:250, but nothing in the repo writes it. Dead.
    "share",
  ])

  /** Namespaces that project to a table. */
  const PROJECTED = new Set([
    "project",
    "session",
    "message",
    "part",
    "research_run",
    "session_diff",
    "todo",
    "session_share",
  ])

  export type Classification = "projected" | "ignored" | "unknown"

  /**
   * The single source of truth for what a storage namespace is.
   *
   * `backfill` and `verify` must both consult this rather than each inferring
   * it from whether `map()` threw. When they disagree, `verify` reports a
   * skipped namespace as real drift — which is how the CI gate ends up red for
   * a reason that has nothing to do with projection correctness.
   */
  export function classify(kind: string | undefined): Classification {
    if (kind && PROJECTED.has(kind)) return "projected"
    if (kind && IGNORED.has(kind)) return "ignored"
    return "unknown"
  }

  type Row = { table: string; columns: Record<string, unknown> }

  const num = (v: unknown): number | null => (typeof v === "number" ? v : null)
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

  /**
   * Map a key + payload to a table row.
   *
   * Returns undefined for namespaces without a table, so a caller can tell
   * "nothing to do" from "unknown namespace" — the latter must be loud, because
   * a new namespace silently skipping projection is exactly how shadow mode
   * rots, and is what `db verify` in CI exists to catch.
   */
  export function map(key: string[], value: any): Row | undefined {
    const [kind] = key
    if (IGNORED.has(kind)) return undefined

    switch (kind) {
      case "project":
        return {
          table: "project",
          columns: {
            id: key[1],
            vcs: str(value?.vcs),
            worktree: str(value?.worktree),
            created_at: num(value?.time?.created),
            initialized_at: num(value?.time?.initialized),
          },
        }

      case "session":
        return {
          table: "session",
          columns: {
            id: key[2],
            // Prefer the key over the payload: the key is what Storage.read
            // addresses, and project/project.ts:245 re-buckets a session under
            // a new project id by writing to a new key.
            project_id: key[1],
            parent_id: str(value?.parentID),
            title: str(value?.title),
            slug: str(value?.slug),
            directory: str(value?.directory),
            version: str(value?.version),
            created_at: num(value?.time?.created),
            updated_at: num(value?.time?.updated),
            archived_at: num(value?.time?.archived),
          },
        }

      case "message":
        return {
          table: "message",
          columns: {
            id: key[2],
            session_id: key[1],
            role: str(value?.role),
            agent: str(value?.agent),
            // Assistant carries modelID/providerID flat; User nests them.
            model: str(value?.modelID) ?? str(value?.model?.modelID),
            created_at: num(value?.time?.created),
          },
        }

      case "part":
        return {
          table: "part",
          columns: {
            id: key[2],
            message_id: key[1],
            session_id: str(value?.sessionID),
            type: str(value?.type),
            tool: str(value?.tool),
            path: partPath(value),
            created_at: num(value?.time?.start) ?? num(value?.time?.created),
          },
        }

      case "research_run":
        return {
          table: "research_run",
          columns: {
            id: key[2],
            project_id: key[1],
            session_id: str(value?.sessionID),
            workflow_id: str(value?.workflow?.id),
            workflow_version: str(value?.workflow?.version),
            status: str(value?.status),
            created_at: num(value?.time?.created),
            updated_at: num(value?.time?.updated),
          },
        }

      case "session_diff":
      case "todo":
      case "session_share":
        return { table: kind, columns: { session_id: key[1] } }
    }

    throw new Error(`no projection for storage namespace "${kind}"`)
  }

  /**
   * Best-effort path for a part.
   *
   * FilePart has NO `path` field — the path lives in `source`, a union whose
   * `resource` arm carries a `uri` instead (message-v2.ts:107-134). PatchPart
   * carries `files[]`, which is one-to-many and therefore belongs in the graph
   * layer rather than a scalar column; only the single-file case is indexed
   * here, and derivation reads the payload for the rest.
   */
  function partPath(value: any): string | null {
    if (value?.type === "file") return str(value?.source?.path) ?? str(value?.source?.uri)
    if (value?.type === "patch" && Array.isArray(value?.files) && value.files.length === 1) return str(value.files[0])
    return null
  }

  /**
   * Text worth full-text indexing, if any.
   *
   * Only parts carry prose. Tool `input` is deliberately excluded — it is
   * mostly paths and JSON, and indexing it buries real content under argument
   * noise. Tool `output` is included but capped downstream by FTS.
   */
  export function searchableText(key: string[], value: any): string | undefined {
    if (key[0] !== "part") return undefined
    if (value?.type === "text" || value?.type === "reasoning") return str(value.text) ?? undefined
    if (value?.type === "tool" && value?.state?.status === "completed") return str(value.state.output) ?? undefined
    return undefined
  }

  /** Primary key column for a table, used by upsert and delete. */
  function pk(table: string): string {
    return table === "session_diff" || table === "todo" || table === "session_share" ? "session_id" : "id"
  }

  const ready = lazy(() => {
    const handle = DatabaseClient.writer()
    Schema.migrate(handle)
    return handle
  })

  function upsert(handle: DatabaseClient.Handle, row: Row, json: string) {
    const columns = [...Object.keys(row.columns), "json"]
    const sql =
      `INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(${pk(row.table)}) DO UPDATE SET ${columns
        .filter((c) => c !== pk(row.table))
        .map((c) => `${c} = excluded.${c}`)
        .join(", ")}`
    handle.stmt(sql).run(...(Object.values(row.columns) as any[]), json)
  }

  /**
   * Queue of pending projections, drained in one transaction per microtask.
   *
   * bun:sqlite is synchronous, so same-tick bursts (a step-finish flushing
   * several parts, then the message, then the session) commit together at no
   * extra cost and without holding a transaction across an await.
   */
  type Pending = { row: Row; json: string | null; text?: string }
  let queue: Pending[] = []
  let scheduled = false
  let inflight: Promise<void> = Promise.resolve()

  function schedule(): Promise<void> {
    if (scheduled) return inflight
    scheduled = true
    let settle: () => void
    let fail: (e: unknown) => void
    inflight = new Promise<void>((res, rej) => {
      settle = res
      fail = rej
    })
    queueMicrotask(() => {
      const batch = queue
      queue = []
      scheduled = false
      try {
        const handle = ready()
        handle.tx(() => {
          for (const item of batch) {
            if (item.json === null) {
              handle.stmt(`DELETE FROM ${item.row.table} WHERE ${pk(item.row.table)} = ?`).run(
                item.row.columns[pk(item.row.table)] as any,
              )
              continue
            }
            upsert(handle, item.row, item.json)
            if (item.text) FTS.queue(handle, "part", item.row.columns.id as string, item.text)
          }
        })
        // Tokenizing happens off the hot path; this only enqueued rows.
        if (batch.some((item) => item.json !== null && item.text)) FTS.scheduleDrain(handle)
        settle!()
      } catch (e) {
        fail!(e)
      }
    })
    return inflight
  }

  /**
   * Project a write. In `shadow` this must never throw — JSON is authoritative
   * and a projection failure is a logged defect, not a user-visible error. In
   * `primary` it propagates, because there is no JSON fallback to read from.
   */
  export async function write(key: string[], value: unknown): Promise<void> {
    if (!DatabaseMode.enabled()) return
    try {
      const row = map(key, value)
      if (!row) return
      queue.push({ row, json: JSON.stringify(value), text: searchableText(key, value) })
      await schedule()
    } catch (e) {
      if (DatabaseMode.primary()) throw e
      log.error("shadow projection failed", { key: key.join("/"), error: e })
    }
  }

  export async function remove(key: string[]): Promise<void> {
    if (!DatabaseMode.enabled()) return
    try {
      const row = map(key, undefined)
      if (!row) return
      queue.push({ row, json: null })
      await schedule()
    } catch (e) {
      if (DatabaseMode.primary()) throw e
      log.error("shadow projection failed", { key: key.join("/"), error: e })
    }
  }

  /** Flush any queued projections. Tests and `db verify` need a settled state. */
  export async function flush(): Promise<void> {
    if (!DatabaseMode.enabled()) return
    while (queue.length > 0 || scheduled) await inflight.catch(() => {})
  }

  export async function read<T>(key: string[], into?: DatabaseClient.Handle): Promise<T | undefined> {
    if (!into) await flush()
    const handle = into ?? ready()
    const [kind] = key
    if (IGNORED.has(kind)) return undefined

    const dummyVal = kind === "project" || kind === "session" || kind === "message" || kind === "part" || kind === "research_run" ? {} : undefined
    const row = map(key, dummyVal)
    if (!row) return undefined

    const keyCol = pk(row.table)
    const targetId = row.columns[keyCol] as string
    if (!targetId) return undefined

    const res = handle.stmt(`SELECT json FROM ${row.table} WHERE ${keyCol} = ?`).get(targetId) as { json: string } | null
    if (!res?.json) return undefined
    return JSON.parse(res.json) as T
  }

  export async function list(prefix: string[], into?: DatabaseClient.Handle): Promise<string[][]> {
    if (!into) await flush()
    const handle = into ?? ready()
    if (prefix.length === 0) {
      const keys: string[][] = []
      for (const row of handle.stmt(`SELECT id FROM project`).all() as { id: string }[]) {
        keys.push(["project", row.id])
      }
      for (const row of handle.stmt(`SELECT project_id, id FROM session`).all() as { project_id: string; id: string }[]) {
        keys.push(["session", row.project_id, row.id])
      }
      for (const row of handle.stmt(`SELECT session_id, id FROM message`).all() as { session_id: string; id: string }[]) {
        keys.push(["message", row.session_id, row.id])
      }
      for (const row of handle.stmt(`SELECT message_id, id FROM part`).all() as { message_id: string; id: string }[]) {
        keys.push(["part", row.message_id, row.id])
      }
      for (const row of handle.stmt(`SELECT project_id, id FROM research_run`).all() as { project_id: string; id: string }[]) {
        keys.push(["research_run", row.project_id, row.id])
      }
      for (const row of handle.stmt(`SELECT session_id FROM session_diff`).all() as { session_id: string }[]) {
        keys.push(["session_diff", row.session_id])
      }
      for (const row of handle.stmt(`SELECT session_id FROM todo`).all() as { session_id: string }[]) {
        keys.push(["todo", row.session_id])
      }
      for (const row of handle.stmt(`SELECT session_id FROM session_share`).all() as { session_id: string }[]) {
        keys.push(["session_share", row.session_id])
      }
      return keys
    }

    const [kind, arg1, arg2] = prefix
    if (IGNORED.has(kind)) return []

    switch (kind) {
      case "project": {
        if (arg1) {
          const res = handle.stmt(`SELECT id FROM project WHERE id = ?`).get(arg1)
          return res ? [["project", arg1]] : []
        }
        return (handle.stmt(`SELECT id FROM project`).all() as { id: string }[]).map((r) => ["project", r.id])
      }
      case "session": {
        if (arg1 && arg2) {
          const res = handle.stmt(`SELECT id FROM session WHERE project_id = ? AND id = ?`).get(arg1, arg2)
          return res ? [["session", arg1, arg2]] : []
        }
        if (arg1) {
          return (handle.stmt(`SELECT id FROM session WHERE project_id = ?`).all(arg1) as { id: string }[]).map((r) => ["session", arg1, r.id])
        }
        return (handle.stmt(`SELECT project_id, id FROM session`).all() as { project_id: string; id: string }[]).map((r) => ["session", r.project_id, r.id])
      }
      case "message": {
        if (arg1 && arg2) {
          const res = handle.stmt(`SELECT id FROM message WHERE session_id = ? AND id = ?`).get(arg1, arg2)
          return res ? [["message", arg1, arg2]] : []
        }
        if (arg1) {
          return (handle.stmt(`SELECT id FROM message WHERE session_id = ?`).all(arg1) as { id: string }[]).map((r) => ["message", arg1, r.id])
        }
        return (handle.stmt(`SELECT session_id, id FROM message`).all() as { session_id: string; id: string }[]).map((r) => ["message", r.session_id, r.id])
      }
      case "part": {
        if (arg1 && arg2) {
          const res = handle.stmt(`SELECT id FROM part WHERE message_id = ? AND id = ?`).get(arg1, arg2)
          return res ? [["part", arg1, arg2]] : []
        }
        if (arg1) {
          return (handle.stmt(`SELECT id FROM part WHERE message_id = ?`).all(arg1) as { id: string }[]).map((r) => ["part", arg1, r.id])
        }
        return (handle.stmt(`SELECT message_id, id FROM part`).all() as { message_id: string; id: string }[]).map((r) => ["part", r.message_id, r.id])
      }
      case "research_run": {
        if (arg1 && arg2) {
          const res = handle.stmt(`SELECT id FROM research_run WHERE project_id = ? AND id = ?`).get(arg1, arg2)
          return res ? [["research_run", arg1, arg2]] : []
        }
        if (arg1) {
          return (handle.stmt(`SELECT id FROM research_run WHERE project_id = ?`).all(arg1) as { id: string }[]).map((r) => ["research_run", arg1, r.id])
        }
        return (handle.stmt(`SELECT project_id, id FROM research_run`).all() as { project_id: string; id: string }[]).map((r) => ["research_run", r.project_id, r.id])
      }
      case "session_diff":
      case "todo":
      case "session_share": {
        if (arg1) {
          const res = handle.stmt(`SELECT session_id FROM ${kind} WHERE session_id = ?`).get(arg1)
          return res ? [[kind, arg1]] : []
        }
        return (handle.stmt(`SELECT session_id FROM ${kind}`).all() as { session_id: string }[]).map((r) => [kind, r.session_id])
      }
    }
    return []
  }

  /** Ensure the schema exists. Used by backfill and by tests. */
  export function init(): DatabaseClient.Handle {
    return ready()
  }

  export function reset(): void {
    queue = []
    scheduled = false
    inflight = Promise.resolve()
    ready.reset()
  }
}
