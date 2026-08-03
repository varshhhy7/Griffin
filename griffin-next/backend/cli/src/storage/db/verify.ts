import path from "path"
import { Global } from "../../global"
import { Projection } from "./projection"
import type { DatabaseClient } from "./client"

export namespace Verify {
  export type DiffKind = "missing_in_db" | "missing_in_json" | "content_mismatch" | "unknown_namespace"

  export interface Diff {
    key: string[]
    kind: DiffKind
    details?: string
  }

  export interface Result {
    verified: number
    diffs: Diff[]
    /** Distinct namespaces with no projection mapping, for actionable output. */
    unknown: string[]
    ok: boolean
  }

  /**
   * Deep-compare every JSON record against its projected row.
   *
   * Note the four diff kinds are not interchangeable:
   *
   *  - `missing_in_db` / `missing_in_json` / `content_mismatch` mean projection
   *    is wrong for a namespace we own.
   *  - `unknown_namespace` means we found a record whose top-level key has no
   *    projection mapping at all. That is a *different* defect — usually a new
   *    namespace added elsewhere in the codebase that nobody taught the
   *    projection layer about, which is precisely the rot this gate exists to
   *    catch. Conflating it with `missing_in_db` (as this did previously) makes
   *    the signal useless, because one stray file in a data dir drowns real
   *    drift in false positives.
   *
   * All four still fail the run: an unknown namespace demands a decision (add a
   * table, or add it to IGNORED), and silently passing is how shadow mode rots.
   */
  export interface Options {
    /** Root to read JSON records from. Defaults to the live data dir. */
    dataDir?: string
    /**
     * Database to compare against. Defaults to the process-wide writer.
     *
     * Without this, `dataDir` only redirects half the comparison — the JSON
     * side moves but the database stays global — so the two sides describe
     * different stores and the command cannot be exercised hermetically.
     */
    handle?: DatabaseClient.Handle
  }

  export async function run(options: Options | string = {}): Promise<Result> {
    const opts: Options = typeof options === "string" ? { dataDir: options } : options
    if (!opts.handle) await Projection.flush()
    const storageDir = path.join(opts.dataDir ?? Global.Path.data, "storage")

    const jsonKeys = new Map<string, { key: string[]; jsonStr: string }>()
    const diffs: Diff[] = []
    const unknown = new Set<string>()
    const glob = new Bun.Glob("**/*.json")

    try {
      for await (const file of glob.scan({ cwd: storageDir, onlyFiles: true })) {
        if (file === "migration" || file.endsWith("migration.json")) continue
        const key = file.slice(0, -5).split(/[\\/]/)
        const kind = Projection.classify(key[0])
        if (kind === "ignored") continue
        if (kind === "unknown") {
          unknown.add(key[0] ?? "")
          diffs.push({ key, kind: "unknown_namespace", details: `no projection mapping for "${key[0]}"` })
          continue
        }
        try {
          jsonKeys.set(key.join("/"), { key, jsonStr: await Bun.file(path.join(storageDir, file)).text() })
        } catch (e) {
          diffs.push({ key, kind: "content_mismatch", details: `unreadable: ${e}` })
        }
      }
    } catch {
      // storage directory missing or empty
    }

    const dbKeyMap = new Map<string, string[]>()
    for (const key of await Projection.list([], opts.handle)) dbKeyMap.set(key.join("/"), key)

    let verified = 0

    for (const [keyStr, item] of jsonKeys) {
      if (!dbKeyMap.has(keyStr)) {
        diffs.push({ key: item.key, kind: "missing_in_db" })
        continue
      }
      const stored = await Projection.read(item.key, opts.handle)
      if (stored === undefined) {
        diffs.push({ key: item.key, kind: "missing_in_db" })
        continue
      }
      try {
        if (!equal(JSON.parse(item.jsonStr), stored)) {
          diffs.push({ key: item.key, kind: "content_mismatch", details: `JSON and DB content differ for ${keyStr}` })
          continue
        }
        verified++
      } catch (e) {
        diffs.push({ key: item.key, kind: "content_mismatch", details: String(e) })
      }
    }

    for (const [keyStr, key] of dbKeyMap) {
      if (!jsonKeys.has(keyStr)) diffs.push({ key, kind: "missing_in_json" })
    }

    return { verified, diffs, unknown: [...unknown].sort(), ok: diffs.length === 0 }
  }

  /**
   * Structural deep equality, insensitive to key order.
   *
   * `JSON.stringify(a) === JSON.stringify(b)` was the previous check, which is
   * key-order sensitive. It happens to hold today because both sides round-trip
   * through parse/stringify of the same original object, but it would report
   * spurious mismatches the moment any writer reorders keys.
   */
  function equal(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => equal(v, b[i]))
    }
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  }
}
