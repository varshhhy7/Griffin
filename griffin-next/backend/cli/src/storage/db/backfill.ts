import path from "path"
import { Global } from "../../global"
import { Projection } from "./projection"
import { DatabaseClient } from "./client"
import { Schema } from "./schema"
import { FTS } from "./fts"
import { Log } from "../../util/log"

export namespace Backfill {
  const log = Log.create({ service: "storage.db.backfill" })

  export interface Result {
    processed: number
    skipped: number
    errors: number
    /** Distinct namespaces with no projection mapping — same signal `verify` reports. */
    unknown: string[]
    duration_ms: number
  }

  export interface Options {
    /** Root to read JSON records from. Defaults to the live data dir. */
    dataDir?: string
    /** Database to write into. Defaults to the process-wide writer. */
    handle?: DatabaseClient.Handle
  }

  export async function run(options: Options | string = {}): Promise<Result> {
    const opts: Options = typeof options === "string" ? { dataDir: options } : options
    const start = Date.now()
    const storageDir = path.join(opts.dataDir ?? Global.Path.data, "storage")
    const handle = opts.handle ?? DatabaseClient.writer()
    Schema.migrate(handle)

    let processed = 0
    let skipped = 0
    let errors = 0
    const unknown = new Set<string>()

    const glob = new Bun.Glob("**/*.json")
    const entries: { key: string[]; value: any; jsonStr: string }[] = []

    try {
      for await (const file of glob.scan({ cwd: storageDir, onlyFiles: true })) {
        if (file === "migration" || file.endsWith("migration.json")) continue
        const fullPath = path.join(storageDir, file)
        const parts = file.slice(0, -5).split(/[\\/]/)
        // Classify up front, from the same source of truth `verify` uses.
        // Previously an unknown namespace fell through to `map()` throwing and
        // was counted as an error here, while `verify` called the same record
        // `missing_in_db` — two different names for one condition.
        const kind = Projection.classify(parts[0])
        if (kind === "ignored") {
          skipped++
          continue
        }
        if (kind === "unknown") {
          unknown.add(parts[0] ?? "")
          skipped++
          continue
        }
        try {
          const jsonStr = await Bun.file(fullPath).text()
          const value = JSON.parse(jsonStr)
          entries.push({ key: parts, value, jsonStr })
        } catch (e) {
          log.error("failed to read json file for backfill", { file, error: e })
          errors++
        }
      }
    } catch {
      // storage directory does not exist or empty
    }

    // Insert parents before children.
    //
    // Bun.Glob yields in filesystem order, not lexicographic — observed as
    // todo, session, project, part, message. Because `part` references
    // `message` and `message` references `session` with foreign_keys=ON, that
    // ordering makes every part insert fail its FK check. Backfill logged each
    // one and carried on, so a real data dir came out with zero parts: the
    // entire body of every message, dropped, with a green-looking summary.
    const ORDER = new Map(
      ["project", "session", "message", "part", "research_run", "session_diff", "todo", "session_share"].map(
        (kind, index) => [kind, index],
      ),
    )
    entries.sort((a, b) => (ORDER.get(a.key[0]) ?? 99) - (ORDER.get(b.key[0]) ?? 99))

    const CHUNK_SIZE = 200
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
      const chunk = entries.slice(i, i + CHUNK_SIZE)
      handle.tx(() => {
        for (const item of chunk) {
          try {
            const row = Projection.map(item.key, item.value)
            if (!row) {
              skipped++
              continue
            }
            const columns = [...Object.keys(row.columns), "json"]
            const pkCol = row.table === "session_diff" || row.table === "todo" || row.table === "session_share" ? "session_id" : "id"
            const sql =
              `INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
              `ON CONFLICT(${pkCol}) DO UPDATE SET ${columns
                .filter((c) => c !== pkCol)
                .map((c) => `${c} = excluded.${c}`)
                .join(", ")}`
            handle.stmt(sql).run(...(Object.values(row.columns) as any[]), item.jsonStr)
            // Backfill has its own insert loop rather than going through
            // Projection.write, so it has to enqueue full-text rows itself —
            // otherwise a database built by `db backfill` has an empty index
            // and content search silently returns nothing.
            const text = Projection.searchableText(item.key, item.value)
            if (text) FTS.queue(handle, "part", row.columns.id as string, text)
            processed++
          } catch (e) {
            log.error("failed to project backfill row", { key: item.key.join("/"), error: e })
            errors++
          }
        }
      })
      await Bun.sleep(0)
    }

    // Index synchronously here, unlike the streaming path. Backfill is an
    // explicit batch operation with no SSE stream to stall, and leaving the
    // queue full would make a freshly backfilled database silently unsearchable
    // until some later write happened to schedule a drain.
    const indexed = FTS.drainAll(handle)

    const duration_ms = Date.now() - start
    log.info("backfill complete", { processed, skipped, errors, indexed, unknown: unknown.size, duration_ms })
    return { processed, skipped, errors, unknown: [...unknown].sort(), duration_ms }
  }
}
