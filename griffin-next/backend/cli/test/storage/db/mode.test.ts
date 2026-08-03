import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { DatabaseMode } from "../../../src/storage/db/mode"
import { Global } from "../../../src/global"

const configFile = path.join(Global.Path.config, "griffin.json")

async function withConfig(body: unknown | undefined, fn: () => void | Promise<void>) {
  const existing = await Bun.file(configFile)
    .text()
    .catch(() => undefined)
  try {
    if (body === undefined) await fs.rm(configFile, { force: true })
    else await Bun.write(configFile, JSON.stringify(body))
    DatabaseMode.reset()
    await fn()
  } finally {
    if (existing === undefined) await fs.rm(configFile, { force: true })
    else await Bun.write(configFile, existing)
    DatabaseMode.reset()
  }
}

afterEach(() => {
  delete process.env["GRIFFIN_DB"]
  DatabaseMode.reset()
})

describe("DatabaseMode", () => {
  test("defaults to off with no env and no config", async () => {
    await withConfig(undefined, () => {
      expect(DatabaseMode.get()).toBe("off")
      expect(DatabaseMode.enabled()).toBe(false)
      expect(DatabaseMode.primary()).toBe(false)
    })
  })

  test("reads experimental.db from the config file", async () => {
    await withConfig({ experimental: { db: "shadow" } }, () => {
      expect(DatabaseMode.get()).toBe("shadow")
      expect(DatabaseMode.enabled()).toBe(true)
      expect(DatabaseMode.primary()).toBe(false)
    })
  })

  test("primary() is true only in primary", async () => {
    await withConfig({ experimental: { db: "primary" } }, () => {
      expect(DatabaseMode.primary()).toBe(true)
      expect(DatabaseMode.enabled()).toBe(true)
    })
  })

  test("GRIFFIN_DB overrides the config file", async () => {
    await withConfig({ experimental: { db: "primary" } }, () => {
      process.env["GRIFFIN_DB"] = "shadow"
      DatabaseMode.reset()
      expect(DatabaseMode.get()).toBe("shadow")
    })
  })

  test("an unrecognized value falls back rather than throwing", async () => {
    // Config validates the flag properly; this module must not be a second
    // place that can hard-fail startup on a typo.
    await withConfig({ experimental: { db: "PRIMARY!!" } }, () => {
      expect(DatabaseMode.get()).toBe("off")
    })
  })

  test("a malformed config file falls back to off", async () => {
    const existing = await Bun.file(configFile)
      .text()
      .catch(() => undefined)
    try {
      await Bun.write(configFile, "{ this is not json")
      DatabaseMode.reset()
      expect(DatabaseMode.get()).toBe("off")
    } finally {
      if (existing === undefined) await fs.rm(configFile, { force: true })
      else await Bun.write(configFile, existing)
      DatabaseMode.reset()
    }
  })

  test("the resolved mode is memoized", async () => {
    await withConfig({ experimental: { db: "shadow" } }, async () => {
      expect(DatabaseMode.get()).toBe("shadow")
      await Bun.write(configFile, JSON.stringify({ experimental: { db: "off" } }))
      // No reset() — the flag cannot change mid-process.
      expect(DatabaseMode.get()).toBe("shadow")
    })
  })
})
