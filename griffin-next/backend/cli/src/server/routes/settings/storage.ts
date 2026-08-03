/**
 * Local storage inspector (settings ▸ Storage). Reports the real on-disk
 * footprint of Griffin's data directory (and the config/cache/state
 * siblings), plus a supported "change data location" operation.
 *
 * Change-location is a genuine move: it copies the current data directory to
 * the chosen target and writes a pointer file (config/data-location) that
 * `Global` honours on the next launch — so it takes effect after a restart.
 * The original directory is left in place as a safety copy.
 */
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { lazy } from "@/util/lazy"

const pointerPath = path.join(Global.Path.config, "data-location")

async function dirSize(target: string): Promise<number> {
  let total = 0
  const stack: string[] = [target]
  while (stack.length) {
    const dir = stack.pop()!
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const stat = await fs.stat(full).catch(() => undefined)
      if (stat) total += stat.size
    }
  }
  return total
}

const Usage = z.object({
  data_dir: z.string(),
  config_dir: z.string(),
  cache_dir: z.string(),
  state_dir: z.string(),
  pointer: z.string().nullable(),
  total_bytes: z.number(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number(), kind: z.enum(["dir", "file"]) })),
  db_mode: z.enum(["off", "shadow", "primary"]),
})

export const StorageRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get storage usage",
        description: "Real on-disk sizes for the Griffin data directory and its top-level entries.",
        operationId: "settings.storage.usage",
        responses: {
          200: {
            description: "Usage",
            content: { "application/json": { schema: resolver(Usage) } },
          },
        },
      }),
      async (c) => {
        const dataDir = Global.Path.data
        const dirents = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [])
        const entries = await Promise.all(
          dirents
            .filter((e) => !e.isSymbolicLink())
            .map(async (e) => {
              const full = path.join(dataDir, e.name)
              const bytes = e.isDirectory()
                ? await dirSize(full)
                : ((await fs.stat(full).catch(() => undefined))?.size ?? 0)
              return { name: e.name, path: full, bytes, kind: e.isDirectory() ? ("dir" as const) : ("file" as const) }
            }),
        )
        entries.sort((a, b) => b.bytes - a.bytes)
        const pointer = await Bun.file(pointerPath)
          .text()
          .then((t) => t.trim() || null)
          .catch(() => null)
        const { DatabaseMode } = await import("@/storage/db/mode")
        return c.json({
          data_dir: dataDir,
          config_dir: Global.Path.config,
          cache_dir: Global.Path.cache,
          state_dir: Global.Path.state,
          pointer,
          total_bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
          entries,
          db_mode: DatabaseMode.get(),
        })
      },
    )
    .post(
      "/db-mode",
      describeRoute({
        summary: "Toggle Knowledge Graph database mode",
        description: "Update experimental.db in griffin.json to shadow or off.",
        operationId: "settings.storage.setDbMode",
        responses: {
          200: {
            description: "Updated DB mode",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), mode: z.enum(["off", "shadow", "primary"]) })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ mode: z.enum(["off", "shadow", "primary"]) })),
      async (c) => {
        const mode = c.req.valid("json").mode
        const configFile = path.join(Global.Path.config, "griffin.json")
        let currentConfig: any = {}
        try {
          const text = await Bun.file(configFile).text()
          currentConfig = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""))
        } catch {}
        currentConfig.experimental = { ...currentConfig.experimental, db: mode }
        await Bun.write(configFile, JSON.stringify(currentConfig, null, 2), { mode: 0o600 })
        const { DatabaseMode } = await import("@/storage/db/mode")
        DatabaseMode.reset()
        return c.json({ ok: true, mode: DatabaseMode.get() })
      },
    )
    .post(
      "/obsidian-sync",
      describeRoute({
        summary: "Sync graph to Obsidian vault",
        description: "Export active Knowledge Graph nodes and edges as Markdown files for Obsidian.",
        operationId: "settings.storage.obsidianSync",
        responses: {
          200: {
            description: "Synced to Obsidian vault",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ ok: z.boolean(), exportedNodes: z.number(), exportedEdges: z.number(), targetDir: z.string() }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const { DatabaseClient } = await import("@/storage/db/client")
        const { ObsidianExporter } = await import("@/storage/db/graph/obsidian")
        const handle = DatabaseClient.reader()
        const res = await ObsidianExporter.exportVault(handle)
        return c.json({ ok: true, ...res })
      },
    )
    .post(
      "/location",
      describeRoute({
        summary: "Change data location",
        description:
          "Copy the data directory to a new absolute path and record a pointer honoured on next launch. Requires restart.",
        operationId: "settings.storage.relocate",
        responses: {
          200: {
            description: "Relocated",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), target: z.string(), restart_required: z.boolean() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ path: z.string().min(1) })),
      async (c) => {
        const raw = c.req.valid("json").path
        const target = path.resolve(raw.replace(/^~(?=$|\/)/, Global.Path.home))
        const source = path.resolve(Global.Path.data)
        if (!path.isAbsolute(target)) return c.json({ error: "Path must be absolute" }, 400)
        if (target === source) return c.json({ error: "Already the current location" }, 400)
        const rel = path.relative(source, target)
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
          return c.json({ error: "Target cannot be inside the current data directory" }, 400)

        const existing = await fs.readdir(target).catch(() => undefined)
        if (existing && existing.length > 0) return c.json({ error: "Target directory is not empty" }, 400)

        await fs.mkdir(target, { recursive: true })
        const dbPath = path.join(source, "griffin.db")
        const targetDbPath = path.join(target, "griffin.db")
        const dbExists = await fs.stat(dbPath).then(() => true).catch(() => false)
        if (dbExists) {
          // VACUUM INTO writes a consistent snapshot in one operation and skips
          // the WAL entirely. A plain file copy cannot be used here, not even
          // as a fallback: the database is open, so `griffin.db` alone omits
          // whatever is still in `-wal`, and copying the WAL set separately
          // races the writer. A torn database that looks like a successful
          // relocation is worse than a relocation that refused to run.
          try {
            const { DatabaseClient } = await import("@/storage/db/client")
            DatabaseClient.reader().db.query(`VACUUM INTO ?`).run(targetDbPath)
          } catch (e) {
            await fs.rm(targetDbPath, { force: true }).catch(() => {})
            return c.json(
              { error: `Could not snapshot the database to the new location: ${e}. Nothing was moved.` },
              500,
            )
          }
        }
        await fs.cp(source, target, {
          recursive: true,
          errorOnExist: false,
          force: true,
          filter: (srcPath) => {
            const base = path.basename(srcPath)
            return !base.startsWith("griffin.db")
          },
        })
        await Bun.write(path.join(source, ".relocated"), target)
        await Bun.write(pointerPath, target, { mode: 0o600 })
        return c.json({ ok: true, target, restart_required: true })
      },
    )
    .delete(
      "/location",
      describeRoute({
        summary: "Reset data location",
        description: "Remove the data-location pointer so the default location is used on next launch.",
        operationId: "settings.storage.resetLocation",
        responses: {
          200: {
            description: "Reset",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      async (c) => {
        await fs.rm(pointerPath, { force: true })
        return c.json({ ok: true })
      },
    ),
)
