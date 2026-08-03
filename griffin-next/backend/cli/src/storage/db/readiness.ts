import path from "path"
import { Global } from "../../global"
import { Projection } from "./projection"
import { DatabaseClient } from "./client"
import { Log } from "../../util/log"

/**
 * Is the database complete enough to be the authoritative read path?
 *
 * `primary` routes `read`, `update`, and `list` to SQL. If the database has not
 * been backfilled, those reads succeed against whatever happens to be there —
 * so `list()` returns a SHORTER LIST rather than an error, and a user sees half
 * their projects vanish with nothing to explain it. Measured on a real dev data
 * dir mid-rollout: 15 project files on disk, 8 rows in the table.
 *
 * That is the worst shape a failure can take: silent, partial, and on the one
 * config flip that is meant to be the point of no return. So `primary` refuses
 * to serve reads until the counts agree.
 *
 * The check is a per-namespace count comparison, not a deep verify — `db
 * verify` already does the expensive thing. This runs once per process and only
 * in `primary`.
 */
export namespace Readiness {
  const log = Log.create({ service: "storage.db.readiness" })

  /** Escape hatch for tests and for deliberately partial databases. */
  const OVERRIDE = "GRIFFIN_DB_SKIP_READINESS"

  export interface NamespaceCount {
    namespace: string
    json: number
    rows: number
  }

  export interface Report {
    ready: boolean
    counts: NamespaceCount[]
    /** Namespaces where JSON has projectable records the database does not. */
    missing: NamespaceCount[]
    /**
     * Records that can never be projected because their parent is gone.
     *
     * `message` references `session` and `part` references `message` with
     * foreign keys on, so a record whose parent was deleted is unprojectable by
     * construction — backfill logs it and moves on. Counting those as "missing"
     * would make readiness permanently unreachable, which turns the guard into
     * a wall. They are a pre-existing integrity problem for `db verify` to
     * report, not a reason to refuse every read.
     */
    orphaned: Record<string, number>
  }

  const TABLE: Record<string, string> = {
    project: "project",
    session: "session",
    message: "message",
    part: "part",
    research_run: "research_run",
    session_diff: "session_diff",
    todo: "todo",
    session_share: "session_share",
  }

  export async function check(opts: { dataDir?: string; handle?: DatabaseClient.Handle } = {}): Promise<Report> {
    const storageDir = path.join(opts.dataDir ?? Global.Path.data, "storage")
    const handle = opts.handle ?? DatabaseClient.reader()

    // Two passes: collect keys first, then classify, because whether a `part`
    // is projectable depends on whether its parent `message` exists.
    const keys: string[][] = []
    try {
      for await (const file of new Bun.Glob("**/*.json").scan({ cwd: storageDir, onlyFiles: true })) {
        const key = file.slice(0, -5).split(/[\\/]/)
        // Namespaces with no table are not expected to project; counting them
        // would make the gate permanently red.
        if (Projection.classify(key[0]) !== "projected") continue
        keys.push(key)
      }
    } catch {
      // No storage dir — a fresh install has nothing to be missing.
    }

    const sessions = new Set(keys.filter((k) => k[0] === "session").map((k) => k[2]))
    const messages = new Set(keys.filter((k) => k[0] === "message").map((k) => k[2]))

    /**
     * Can backfill actually insert this record?
     *
     * Keys are `[kind, parent, id]`, so the parent is already in hand — no
     * extra filesystem work. A message whose session is gone, or a part whose
     * message is gone, fails its foreign key and is skipped forever.
     */
    const projectable = (key: string[]): boolean => {
      if (key[0] === "message") return sessions.has(key[1])
      if (key[0] === "part") return messages.has(key[1])
      return true
    }

    const json: Record<string, number> = {}
    const orphaned: Record<string, number> = {}
    for (const key of keys) {
      const bucket = projectable(key) ? json : orphaned
      bucket[key[0]] = (bucket[key[0]] ?? 0) + 1
    }

    const counts: NamespaceCount[] = []
    for (const [namespace, table] of Object.entries(TABLE)) {
      const rows = (() => {
        try {
          return (handle.stmt(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
        } catch {
          return 0
        }
      })()
      counts.push({ namespace, json: json[namespace] ?? 0, rows })
    }

    // Rows exceeding files is fine — a deleted JSON record whose row lingers is
    // `db verify`'s business, not a reason to block reads. Only the reverse
    // direction hides data from the user.
    const missing = counts.filter((c) => c.json > c.rows)
    return { ready: missing.length === 0, counts, missing, orphaned }
  }

  export function overridden(): boolean {
    const raw = process.env[OVERRIDE]
    return raw === "1" || raw === "true"
  }

  export function explain(report: Report): string {
    const lines = report.missing.map((m) => `  ${m.namespace}: ${m.json} on disk, ${m.rows} in the database`)
    const orphans = Object.entries(report.orphaned)
    if (orphans.length > 0) {
      lines.push(
        "",
        `Not counted (parent record is gone, so they cannot be projected): ${orphans
          .map(([k, n]) => `${n} ${k}`)
          .join(", ")}`,
      )
    }
    return [
      "Refusing to read from SQLite: the database is missing records that exist on disk.",
      "",
      ...lines,
      "",
      "In `primary` mode these records would be invisible — `list()` would silently",
      "return a shorter result rather than an error. Nothing has been lost; the JSON",
      "is intact.",
      "",
      "Run:  griffin db backfill    then:  griffin db verify",
      "",
      `Or set ${OVERRIDE}=1 to proceed anyway.`,
    ].join("\n")
  }

  /**
   * Gate `primary` reads. Runs the count comparison once per process.
   *
   * Memoized on the promise rather than the result so concurrent first reads
   * share one filesystem scan instead of racing several.
   */
  let gate: Promise<void> | undefined

  export function assertReady(): Promise<void> {
    if (gate) return gate
    gate = (async () => {
      if (overridden()) {
        log.warn("primary readiness check skipped by environment override")
        return
      }
      const report = await check()
      if (report.ready) {
        log.info("primary readiness ok", { counts: report.counts.length })
        return
      }
      throw new Error(explain(report))
    })()
    // A failed check must be retryable — otherwise a transient filesystem error
    // poisons the process until restart.
    gate.catch(() => {
      gate = undefined
    })
    return gate
  }

  export function reset(): void {
    gate = undefined
  }
}
