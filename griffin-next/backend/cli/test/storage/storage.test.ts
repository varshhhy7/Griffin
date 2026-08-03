import { afterAll, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Storage } from "../../src/storage/storage"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Characterization suite for the JSON-file-per-key store, written BEFORE the
// SQLite projection lands. Every assertion here is a contract that the
// `shadow` and `primary` modes must reproduce exactly — the point is to fail
// loudly if the migration changes observable behavior, not to describe ideal
// behavior. Several of these pin things that are arguably bugs; that is
// deliberate. See docs/plans/12-sqlite-knowledge-graph.md.

const root = path.join(Global.Path.data, "storage")

/**
 * Unique key prefix per test.
 *
 * Deliberately a synthetic namespace: `Storage` is a generic key/value store
 * and these tests characterize it as one, independent of which namespaces the
 * projection layer happens to know about. Arity varies across these cases
 * (2 to 4 segments), which no real namespace mapping would round-trip.
 *
 * The catch is that `Global.Path.data` is shared across the whole test process
 * and `db verify` walks every file under it, so anything left behind surfaces
 * in an unrelated suite as an `unknown_namespace` diff — order-dependently.
 * Hence the afterAll below: every prefix is tracked and removed.
 */
const created = new Set<string>()

function ns(name: string) {
  const prefix = `chr-${name}-${Math.random().toString(36).slice(2, 10)}`
  created.add(prefix)
  return prefix
}

afterAll(async () => {
  await Promise.all([...created].map((p) => fs.rm(path.join(root, p), { recursive: true, force: true })))
})

describe("Storage.read", () => {
  test("missing key throws NotFoundError with the absolute json path in the message", async () => {
    const key = [ns("read"), "nope"]
    const err = await Storage.read(key).then(
      () => undefined,
      (e) => e,
    )

    expect(err).toBeDefined()
    // ~15 call sites do `.catch(() => undefined)` on this. The named type is
    // load-bearing; the message text is what a user sees in a log.
    expect(Storage.NotFoundError.isInstance(err)).toBe(true)
    expect(err.data.message).toBe(`Resource not found: ${path.join(root, ...key) + ".json"}`)
  })

  test("round-trips an object identically", async () => {
    const key = [ns("read"), "obj"]
    const value = { id: "x", nested: { a: [1, 2, 3], b: null }, when: 1700000000000 }

    await Storage.write(key, value)

    expect(await Storage.read<typeof value>(key)).toEqual(value)
  })
})

describe("Storage.write", () => {
  test("persists as 2-space-indented JSON at <data>/storage/<...key>.json", async () => {
    const key = [ns("write"), "fmt"]
    const value = { a: 1, b: { c: 2 } }

    await Storage.write(key, value)

    const target = path.join(root, ...key) + ".json"
    expect(await Bun.file(target).text()).toBe(JSON.stringify(value, null, 2))
  })

  test("creates intermediate directories implicitly", async () => {
    const key = [ns("write"), "deep", "deeper", "leaf"]

    await Storage.write(key, { ok: true })

    expect(await Storage.read<{ ok: boolean }>(key)).toEqual({ ok: true })
  })
})

describe("Storage.update", () => {
  test("mutates in place and returns the updated content", async () => {
    const key = [ns("update"), "rec"]
    await Storage.write(key, { n: 1, keep: "yes" })

    const result = await Storage.update<{ n: number; keep: string }>(key, (draft) => {
      draft.n = 2
    })

    expect(result).toEqual({ n: 2, keep: "yes" })
    expect(await Storage.read<{ n: number; keep: string }>(key)).toEqual({ n: 2, keep: "yes" })
  })

  test("missing key throws NotFoundError — update does NOT upsert", async () => {
    const key = [ns("update"), "absent"]

    const err = await Storage.update(key, () => {}).then(
      () => undefined,
      (e) => e,
    )

    expect(Storage.NotFoundError.isInstance(err)).toBe(true)
    // Callers rely on this to distinguish "create" from "modify".
    expect(await Bun.file(path.join(root, ...key) + ".json").exists()).toBe(false)
  })
})

describe("Storage.remove", () => {
  test("deletes the record", async () => {
    const key = [ns("remove"), "gone"]
    await Storage.write(key, { a: 1 })

    await Storage.remove(key)

    expect(Storage.NotFoundError.isInstance(await Storage.read(key).catch((e) => e))).toBe(true)
  })

  test("removing a missing key is a silent no-op", async () => {
    // `fs.unlink(...).catch(() => {})` — swallows everything, including a
    // genuine permission error. Session.remove depends on the no-throw part.
    expect(await Storage.remove([ns("remove"), "never-existed"]).then(() => "ok")).toBe("ok")
  })
})

describe("Storage.list", () => {
  test("returns full key arrays, not leaf names", async () => {
    const prefix = ns("list")
    await Storage.write([prefix, "s1", "a"], {})

    expect(await Storage.list([prefix])).toEqual([[prefix, "s1", "a"]])
  })

  test("recurses the whole subtree under the prefix", async () => {
    const prefix = ns("list")
    await Storage.write([prefix, "a"], {})
    await Storage.write([prefix, "deep", "b"], {})
    await Storage.write([prefix, "deep", "deeper", "c"], {})

    expect(await Storage.list([prefix])).toEqual([
      [prefix, "a"],
      [prefix, "deep", "b"],
      [prefix, "deep", "deeper", "c"],
    ])
  })

  test("nonexistent prefix returns [] rather than throwing", async () => {
    // The `catch { return [] }` makes a broken data dir indistinguishable from
    // an empty one. Preserved deliberately — callers treat [] as "no records".
    expect(await Storage.list([ns("list"), "nothing", "here"])).toEqual([])
  })

  test("ordering is comma-joined array sort, NOT path-separator sort", async () => {
    // THE load-bearing case for the SQLite port. `result.sort()` on an array of
    // arrays coerces each element via toString(), i.e. joins with "," (0x2C).
    // Sorting the same keys as filesystem paths would join with path.sep
    // ("\" 0x5C on win32, "/" 0x2F on posix) and produce a DIFFERENT order,
    // because "," sorts below "-" (0x2D) while "\" and "/" straddle it.
    //
    // MessageV2.lastID (message-v2.ts:926-937) takes list[length-1] as the max
    // message id and caches it, so a reordering here silently corrupts new
    // message id generation. A `primary`-mode implementation must therefore
    // reproduce this exact sort in JS and must NOT push ORDER BY into SQL,
    // whose BINARY collation would order by the raw joined string.
    const prefix = ns("order")
    await Storage.write([prefix, "s1", "m1"], {})
    await Storage.write([prefix, "s1-x", "m0"], {})

    const listed = await Storage.list([prefix])

    expect(listed).toEqual([
      [prefix, "s1", "m1"],
      [prefix, "s1-x", "m0"],
    ])

    // Spell out the divergence so a future reader sees why this test exists.
    const bySep = [...listed].sort((a, b) => (a.join(path.sep) < b.join(path.sep) ? -1 : 1))
    expect(bySep).toEqual([
      [prefix, "s1-x", "m0"],
      [prefix, "s1", "m1"],
    ])
    expect(bySep).not.toEqual(listed)
  })

  test("generated identifiers contain no comma, so the comma-join sort is unambiguous", async () => {
    // The ordering contract above is only well-defined because no key segment
    // can contain the join character. Identifier is base62 + "_" + hex.
    for (const prefix of ["session", "message", "part"] as const) {
      for (let i = 0; i < 50; i++) {
        expect(Identifier.ascending(prefix)).not.toInclude(",")
      }
    }
  })

  test("ascending identifiers sort correctly under the comma-join order", async () => {
    // The property lastID actually depends on, stated directly.
    const prefix = ns("ids")
    const ids = Array.from({ length: 25 }, () => Identifier.ascending("message"))
    for (const id of ids) await Storage.write([prefix, id], {})

    const listed = await Storage.list([prefix])

    const sorted = [...ids].sort()
    expect(listed.map((k) => k[1])).toEqual(sorted)
    expect(listed[listed.length - 1][1]).toBe(sorted[sorted.length - 1])
  })
})
