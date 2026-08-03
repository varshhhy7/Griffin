import path from "path"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { DatabaseClient } from "../../storage/db/client"
import { DatabaseMode } from "../../storage/db/mode"
import { Schema } from "../../storage/db/schema"

import { Backfill } from "../../storage/db/backfill"
import { Verify } from "../../storage/db/verify"
import { GraphStore } from "../../storage/db/graph/store"
import { Vocabulary } from "../../storage/db/graph/vocabulary"
import { Readiness } from "../../storage/db/readiness"
import { ObsidianExporter } from "../../storage/db/graph/obsidian"

/**
 * `griffin db` — inspect and maintain the SQLite datastore.
 *
 * The datastore is gated by `experimental.db` (off | shadow | primary); see
 * docs/plans/12-sqlite-knowledge-graph.md. These commands work regardless of
 * the mode so the database can be inspected before it is switched on.
 */
export const DbCommand = cmd({
  command: "db",
  describe: "inspect and maintain the local SQLite datastore",
  builder: (yargs) =>
    yargs
      .command(DbStatusCommand)
      .command(DbBackfillCommand)
      .command(DbVerifyCommand)
      .command(DbRebuildCommand)
      .command(DbSchemaCommand)
      .command(DbExportObsidianCommand)
      .demandCommand(),
  async handler() {},
})

const ENTITY_TABLES = [
  "project",
  "session",
  "message",
  "part",
  "research_run",
  "session_diff",
  "todo",
  "session_share",
] as const

type Status = {
  mode: DatabaseMode.Mode
  file: string
  exists: boolean
  size_bytes: number
  schema_version: number
  schema_latest: number
  journal_mode: string
  integrity: string
  rows: Record<string, number>
  migrations: { id: number; name: string; applied_at: number }[]
  /** Agent-proposed subtypes awaiting review, highest usage first. */
  proposed_vocabulary: { kind: string; name: string; usage_count: number }[]
  unreviewed_nodes: number
  /** Whether the database is complete enough to be the authoritative read path. */
  primary_ready: boolean
  unprojected: { namespace: string; json: number; rows: number }[]
}

async function collect(): Promise<Status> {
  const file = DatabaseClient.file()
  const exists = await Bun.file(file).exists()
  const mode = DatabaseMode.get()

  if (!exists) {
    return {
      mode,
      file,
      exists: false,
      size_bytes: 0,
      schema_version: 0,
      schema_latest: Schema.latest(),
      journal_mode: "n/a",
      integrity: "n/a",
      rows: {},
      migrations: [],
      proposed_vocabulary: [],
      unreviewed_nodes: 0,
      primary_ready: false,
      unprojected: [],
    }
  }

  // Read path only — `db status` must never migrate as a side effect, or a
  // user inspecting an `off` install would silently get a schema written.
  const handle = DatabaseClient.reader()
  const version = Schema.current(handle)
  const readiness = await Readiness.check({ handle })
  const rows: Record<string, number> = {}
  for (const table of ENTITY_TABLES) {
    try {
      rows[table] = (handle.db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    } catch {
      // Table not created yet at this schema version.
    }
  }

  return {
    mode,
    file,
    exists: true,
    size_bytes: Bun.file(file).size,
    schema_version: version,
    schema_latest: Schema.latest(),
    journal_mode: String(
      Object.values(handle.db.query("PRAGMA journal_mode").get() as Record<string, string>)[0] ?? "unknown",
    ),
    integrity: DatabaseClient.integrity(handle),
    rows,
    migrations: Schema.applied(handle),
    // Surfaced so vocabulary drift is a visible chore rather than an invisible
    // one: a proposed subtype with high usage and no review means either accept
    // it or fix the resolver that keeps emitting it.
    proposed_vocabulary: safely(() => Vocabulary.proposed(handle), []),
    unreviewed_nodes: safely(
      () => (handle.db.query("SELECT count(*) AS n FROM node WHERE review_state = 'unreviewed'").get() as any).n,
      0,
    ),
    primary_ready: readiness.ready,
    unprojected: readiness.missing,
  }
}

/** Tolerate tables that do not exist yet at an older schema version. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

const DATA_DIR_HELP = "operate on this data dir and its griffin.db instead of the live one (used by CI fixtures)"

/**
 * Point backfill/verify at an alternate data dir *and* its database.
 *
 * Both halves have to move together. Redirecting only the JSON side leaves the
 * comparison pointed at the live database, so the two sides describe different
 * stores and every record looks like drift.
 */
function scope(dataDir: string | undefined) {
  if (!dataDir) return {}
  const dir = path.resolve(dataDir)
  return { dataDir: dir, handle: DatabaseClient.create(path.join(dir, DatabaseClient.FILENAME)) }
}

const DbStatusCommand = cmd({
  command: "status",
  describe: "show datastore mode, schema version, size, and row counts",
  builder: (yargs) =>
    yargs.option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" }),
  async handler(args) {
    const status = await collect()

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n")
      return
    }

    UI.empty()
    prompts.log.info(`mode            ${status.mode}`)
    prompts.log.info(`file            ${status.file}`)

    if (!status.exists) {
      prompts.log.warn("database        not created yet")
      prompts.log.info(
        status.mode === "off"
          ? 'Set `experimental.db` to "shadow" (or GRIFFIN_DB=shadow) to start populating it.'
          : "It will be created on the next write.",
      )
      UI.empty()
      return
    }

    prompts.log.info(`size            ${(status.size_bytes / 1024 / 1024).toFixed(2)} MB`)
    prompts.log.info(`schema          ${status.schema_version} of ${status.schema_latest}`)
    prompts.log.info(`journal         ${status.journal_mode}`)

    if (status.integrity === "ok") prompts.log.info(`integrity       ok`)
    else prompts.log.error(`integrity       ${status.integrity}`)

    if (status.schema_version < status.schema_latest) {
      prompts.log.warn(`${status.schema_latest - status.schema_version} migration(s) pending`)
    }

    // The readiness line is the thing to check before flipping to `primary`.
    if (status.primary_ready) {
      prompts.log.info(`primary         ready`)
    } else {
      prompts.log.error(`primary         NOT READY — ${status.unprojected.length} namespace(s) unprojected`)
      for (const u of status.unprojected) {
        prompts.log.warn(`  ${u.namespace}: ${u.json} on disk, ${u.rows} in the database`)
      }
      prompts.log.info("Run `griffin db backfill` before setting experimental.db to primary.")
    }

    const counted = Object.entries(status.rows)
    if (counted.length > 0) {
      UI.empty()
      const width = Math.max(...counted.map(([t]) => t.length))
      for (const [table, n] of counted) {
        prompts.log.info(`${table.padEnd(width)}  ${n.toLocaleString()}`)
      }
    }

    if (status.unreviewed_nodes > 0) {
      UI.empty()
      prompts.log.warn(`unreviewed nodes  ${status.unreviewed_nodes.toLocaleString()} (excluded from default scope)`)
    }

    if (status.proposed_vocabulary.length > 0) {
      UI.empty()
      prompts.log.warn(`proposed vocabulary (${status.proposed_vocabulary.length}), by usage:`)
      for (const v of status.proposed_vocabulary.slice(0, 15)) {
        prompts.log.info(`  ${v.kind}/${v.name}  ${v.usage_count}`)
      }
      if (status.proposed_vocabulary.length > 15) {
        prompts.log.info(`  ...and ${status.proposed_vocabulary.length - 15} more`)
      }
    }
    UI.empty()
  },
})

const DbBackfillCommand = cmd({
  command: "backfill",
  describe: "import existing JSON storage files into the SQLite database",
  builder: (yargs) =>
    yargs
      .option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" })
      .option("data-dir", { type: "string", describe: DATA_DIR_HELP }),
  async handler(args) {
    const res = await Backfill.run(scope(args["data-dir"]))
    if (res.errors > 0) process.exitCode = 1

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      return
    }
    UI.empty()
    prompts.log.info(`processed       ${res.processed}`)
    prompts.log.info(`skipped         ${res.skipped}`)
    prompts.log.info(`errors          ${res.errors}`)
    prompts.log.info(`duration        ${res.duration_ms} ms`)
    if (res.unknown.length > 0) {
      prompts.log.warn(`unknown namespaces: ${res.unknown.join(", ")}`)
      prompts.log.info("Add a table in storage/db/migrations, or add the namespace to IGNORED in projection.ts.")
    }
    UI.empty()
  },
})

const DbVerifyCommand = cmd({
  command: "verify",
  describe: "deep-compare JSON storage files against SQLite rows",
  builder: (yargs) =>
    yargs
      .option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" })
      .option("data-dir", { type: "string", describe: DATA_DIR_HELP }),
  async handler(args) {
    const res = await Verify.run(scope(args["data-dir"]))

    // Set before the format branch, not inside it. CI uses --format json, and
    // an exit code applied only on the text path is an exit code CI never sees.
    if (!res.ok) process.exitCode = 1

    if (args.format === "json") {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      return
    }
    UI.empty()
    prompts.log.info(`verified        ${res.verified}`)

    if (res.diffs.length === 0) {
      prompts.log.info("diffs           0")
      UI.empty()
      return
    }

    // Group by kind — an unknown namespace and a content mismatch demand
    // completely different responses, and a flat list buries that.
    const byKind = new Map<string, typeof res.diffs>()
    for (const d of res.diffs) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d])

    prompts.log.error(`diffs           ${res.diffs.length}`)
    for (const [kind, items] of byKind) {
      prompts.log.warn(`  ${kind}: ${items.length}`)
      for (const d of items.slice(0, 5)) prompts.log.warn(`    ${d.key.join("/")} ${d.details ?? ""}`)
      if (items.length > 5) prompts.log.warn(`    ...and ${items.length - 5} more`)
    }

    if (res.unknown.length > 0) {
      UI.empty()
      prompts.log.warn(`Namespaces with no projection mapping: ${res.unknown.join(", ")}`)
      prompts.log.info("Add a table in storage/db/migrations, or add the namespace to IGNORED in projection.ts.")
    }

    UI.empty()
  },
})

const DbRebuildCommand = cmd({
  command: "rebuild",
  describe: "drop and re-derive system-origin graph nodes and edges",
  builder: (yargs) =>
    yargs
      .option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" })
      .option("obsidian", {
        type: "boolean",
        default: true,
        describe: "refresh an existing Obsidian vault afterwards (never creates one)",
      }),
  async handler(args) {
    const handle = DatabaseClient.writer()
    Schema.migrate(handle)
    const res = GraphStore.rebuild(handle)

    // Keep an existing vault current — it just went stale by definition. A
    // vault is never created here; that stays an explicit `db export-obsidian`.
    const synced = args.obsidian ? await ObsidianExporter.syncIfPresent(handle) : undefined

    if (args.format === "json") {
      process.stdout.write(JSON.stringify({ ...res, obsidian: synced ?? null }, null, 2) + "\n")
      return
    }
    UI.empty()
    prompts.log.info(`system_nodes     ${res.systemNodes}`)
    prompts.log.info(`system_edges     ${res.systemEdges}`)
    if (synced) prompts.log.info(`obsidian         ${synced.written} note(s), ${synced.pruned} pruned`)
    prompts.log.info("rebuild          ok")
    UI.empty()
  },
})

/** Path of the checked-in schema snapshot, relative to the repo root. */
export const SCHEMA_SNAPSHOT = "schemas/griffin-db.sql"

const DbSchemaCommand = cmd({
  command: "schema",
  describe: "print the full SQL schema, or refresh the checked-in snapshot",
  builder: (yargs) =>
    yargs.option("write", {
      type: "boolean",
      default: false,
      describe: `refresh ${SCHEMA_SNAPSHOT} from the migrations`,
    }),
  async handler(args) {
    const sql = Schema.sql()
    if (!args.write) {
      process.stdout.write(sql)
      return
    }
    // src/cli/cmd -> src -> cli -> backend -> griffin-next -> <repo root>
    const target = path.resolve(import.meta.dir, "../../../../../..", SCHEMA_SNAPSHOT)
    await Bun.write(target, sql)
    UI.empty()
    prompts.log.success(`wrote ${target}`)
    UI.empty()
  },
})

const DbExportObsidianCommand = cmd({
  command: "export-obsidian",
  describe: "export graph nodes and edges to an Obsidian vault directory",
  builder: (yargs) =>
    yargs
      .option("format", { choices: ["text", "json"] as const, default: "text", describe: "output format" })
      .option("target-dir", { type: "string", describe: "custom target directory for the vault" })
      .option("include-text", {
        type: "boolean",
        default: false,
        describe: "inline full message bodies into notes (off by default — vaults get synced and shared)",
      })
      .option("redact", {
        type: "boolean",
        default: false,
        describe:
          "strip conversation text entirely: message notes are titled `role id`, so no wording reaches the body, heading, or filename",
      })
      .option("prune", {
        type: "boolean",
        default: true,
        describe: "remove notes this exporter wrote whose node no longer exists",
      }),
  async handler(args) {
    const handle = DatabaseClient.reader()
    const res = await ObsidianExporter.exportVault(handle, {
      targetDir: args["target-dir"],
      includeText: args["include-text"],
      redact: args.redact,
      prune: args.prune,
    })
    if (args.format === "json") {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n")
      return
    }
    UI.empty()
    prompts.log.info(`written        ${res.written}`)
    prompts.log.info(`pruned         ${res.pruned}`)
    prompts.log.info(`edges          ${res.edges}`)
    prompts.log.info(`target_dir     ${res.targetDir}`)
    prompts.log.success("export-obsidian ok")
    UI.empty()
  },
})
