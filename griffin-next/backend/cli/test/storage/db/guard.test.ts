import { expect, test } from "bun:test"
import path from "path"

const src = path.resolve(import.meta.dir, "../../../src")

/**
 * `backend/cli/package.json` maps `"exports": {"./*": "./src/*.ts"}`, so every
 * src module is one import away from the frontend bundle, and the CLI itself
 * builds with `conditions: ["browser"]` (script/build.ts:159).
 *
 * The phase 0 spike confirmed `bun:sqlite` survives that build, so this is not
 * about the import failing today — it is about keeping the blast radius at one
 * module, so the day it does become a problem there is exactly one file to fix.
 */
test("exactly one src module imports bun:sqlite", async () => {
  const hits: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: src, absolute: true })) {
    const content = await Bun.file(file).text()
    if (/from\s+["']bun:sqlite["']|import\s*\(\s*["']bun:sqlite["']\s*\)/.test(content)) {
      hits.push(path.relative(src, file).replace(/\\/g, "/"))
    }
  }

  expect(hits).toEqual(["storage/db/client.ts"])
})
