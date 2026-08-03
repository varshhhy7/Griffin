import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { DatabaseClient } from "../../../src/storage/db/client"
import { Schema } from "../../../src/storage/db/schema"
import { ObsidianExporter } from "../../../src/storage/db/graph/obsidian"

const dirs: string[] = []

async function db() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "griffin-obs-"))
  dirs.push(dir)
  const h = DatabaseClient.create(path.join(dir, "g.db"))
  Schema.migrate(h)
  return { h, vault: path.join(dir, "vault") }
}

function node(
  h: DatabaseClient.Handle,
  id: string,
  kind: string,
  label: string,
  extra: { origin?: string; review?: string; subtype?: string } = {},
) {
  h.db
    .query(
      `INSERT INTO node (id, kind, subtype, label, recorded_at, origin, review_state)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, kind, extra.subtype ?? null, label, extra.origin ?? "system", extra.review ?? "accepted")
}

function edge(h: DatabaseClient.Handle, from: string, to: string, relation: string) {
  h.db
    .query(`INSERT INTO edge (from_id, to_id, relation, origin, created_at) VALUES (?, ?, ?, 'system', 0)`)
    .run(from, to, relation)
}

const ls = (dir: string) => fs.readdir(dir)

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("noteName", () => {
  test("distinct ids never collide, even with identical labels", () => {
    // The defect this replaced: `derive.ts` labels every tool run `Run <tool>`,
    // so fifty `read` calls produced one note and forty-nine nodes' edges were
    // silently dropped.
    const a = ObsidianExporter.noteName("run:1", "Run read")
    const b = ObsidianExporter.noteName("run:2", "Run read")
    expect(a).not.toBe(b)
    expect(a.startsWith("Run read")).toBeTrue()
  })

  test("is stable for the same id", () => {
    expect(ObsidianExporter.noteName("run:1", "Run read")).toBe(ObsidianExporter.noteName("run:1", "Run read"))
  })

  test("clamps long labels well under NAME_MAX", () => {
    // An unclamped 300-char label threw ENOENT and aborted the entire export
    // partway through. PubMed titles reach this routinely.
    const name = ObsidianExporter.noteName("n1", "x".repeat(400))
    expect(`${name}.md`.length).toBeLessThan(255)
  })

  test("truncates by code point, never splitting a surrogate pair", () => {
    const name = ObsidianExporter.noteName("n1", "🧬".repeat(200))
    expect(name).not.toContain("�")
    expect([...name].every((c) => c !== "\uD83E")).toBeTrue()
  })

  test("strips path separators and Obsidian-hostile characters", () => {
    const name = ObsidianExporter.noteName("n1", 'a/b\\c:d*e?f"g<h>i|j#k^l[m]n')
    expect(name).not.toMatch(/[/\\:*?"<>|#^[\]]/)
  })

  test("neutralizes Windows reserved device names", () => {
    expect(ObsidianExporter.noteName("n1", "CON").toLowerCase()).not.toMatch(/^con \(/)
    expect(ObsidianExporter.noteName("n2", "nul").toLowerCase()).not.toMatch(/^nul \(/)
  })

  test("strips leading and trailing dots", () => {
    expect(ObsidianExporter.noteName("n1", "...hidden...").startsWith(".")).toBeFalse()
  })

  test("an empty or whitespace label still yields a usable name", () => {
    expect(ObsidianExporter.noteName("n1", "").length).toBeGreaterThan(0)
    expect(ObsidianExporter.noteName("n2", "   ").length).toBeGreaterThan(0)
    expect(ObsidianExporter.noteName("n3", null).length).toBeGreaterThan(0)
  })
})

describe("exportVault", () => {
  test("every node becomes exactly one note, and the count is of files written", async () => {
    const { h, vault } = await db()
    node(h, "run:1", "run", "Run read")
    node(h, "run:2", "run", "Run read")
    node(h, "run:3", "run", "Run bash")
    node(h, "art:1", "artifact", "/repo/a.txt")
    node(h, "art:2", "artifact", "/repo/b.txt")
    edge(h, "run:1", "art:1", "produced")
    edge(h, "run:2", "art:2", "produced")

    const res = await ObsidianExporter.exportVault(h, { targetDir: vault })

    expect(res.written).toBe(5)
    expect((await ls(vault)).length).toBe(5)
    h.close()
  })

  test("both same-labelled nodes keep their own edges", async () => {
    // Previously one overwrote the other and its `produced` edge vanished.
    const { h, vault } = await db()
    node(h, "run:1", "run", "Run read")
    node(h, "run:2", "run", "Run read")
    node(h, "art:1", "artifact", "a.txt")
    node(h, "art:2", "artifact", "b.txt")
    edge(h, "run:1", "art:1", "produced")
    edge(h, "run:2", "art:2", "produced")
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const all = await Promise.all(
      (await ls(vault)).map((f) => fs.readFile(path.join(vault, f), "utf8")),
    )
    const combined = all.join("\n")
    expect(combined).toContain(`[[${ObsidianExporter.noteName("art:1", "a.txt")}]]`)
    expect(combined).toContain(`[[${ObsidianExporter.noteName("art:2", "b.txt")}]]`)
    h.close()
  })

  test("a very long label does not abort the export", async () => {
    const { h, vault } = await db()
    node(h, "n1", "source", "T".repeat(400))
    node(h, "n2", "entity", "normal")

    const res = await ObsidianExporter.exportVault(h, { targetDir: vault })
    expect(res.written).toBe(2)
    h.close()
  })

  test("links resolve to real files", async () => {
    // A wikilink pointing at a filename that was never written renders as a
    // broken node in Graph View.
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    node(h, "b", "entity", "Beta")
    edge(h, "a", "b", "mentions")
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const files = new Set((await ls(vault)).map((f) => f.replace(/\.md$/, "")))
    const content = await fs.readFile(path.join(vault, `${ObsidianExporter.noteName("a", "Alpha")}.md`), "utf8")
    for (const [, target] of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      expect(files.has(target)).toBeTrue()
    }
    h.close()
  })

  test("records both directions so Graph View is connected either way", async () => {
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    node(h, "b", "entity", "Beta")
    edge(h, "a", "b", "mentions")
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const beta = await fs.readFile(path.join(vault, `${ObsidianExporter.noteName("b", "Beta")}.md`), "utf8")
    expect(beta).toContain("## Incoming")
    expect(beta).toContain("mentions")
    h.close()
  })

  test("`]]` in a label cannot break the wikilink that embeds it", async () => {
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    node(h, "b", "entity", "Link ]] breaker")
    edge(h, "a", "b", "mentions")
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const alpha = await fs.readFile(path.join(vault, `${ObsidianExporter.noteName("a", "Alpha")}.md`), "utf8")
    const links = [...alpha.matchAll(/\[\[([^\]]+)\]\]/g)]
    expect(links).toHaveLength(1)
    h.close()
  })

  test("trust is encoded as tags so it is visible in Graph View", async () => {
    const { h, vault } = await db()
    node(h, "c1", "claim", "an unreviewed claim", { origin: "agent", review: "unreviewed" })
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const content = await fs.readFile(path.join(vault, `${ObsidianExporter.noteName("c1", "an unreviewed claim")}.md`), "utf8")
    expect(content).toContain("#origin-agent")
    expect(content).toContain("#review-unreviewed")
    h.close()
  })

  test("rejected and merged nodes are not exported", async () => {
    const { h, vault } = await db()
    node(h, "keep", "entity", "Keep")
    node(h, "bad", "entity", "Rejected", { origin: "agent", review: "rejected" })
    node(h, "dupe", "entity", "Duplicate", { origin: "agent" })
    h.db.query(`UPDATE node SET merged_into = 'keep' WHERE id = 'dupe'`).run()

    const res = await ObsidianExporter.exportVault(h, { targetDir: vault })
    expect(res.written).toBe(1)
    h.close()
  })
})

describe("message text", () => {
  async function withMessage() {
    const ctx = await db()
    ctx.h.db.query(`INSERT INTO project (id, worktree, json) VALUES ('p','/r','{}')`).run()
    ctx.h.db.query(`INSERT INTO session (id, project_id, json) VALUES ('s','p','{}')`).run()
    ctx.h.db.query(`INSERT INTO message (id, session_id, role, json) VALUES ('m','s','user','{}')`).run()
    ctx.h.db
      .query(`INSERT INTO part (id, message_id, session_id, type, json) VALUES ('pt','m','s','text',?)`)
      .run(JSON.stringify({ text: "a private research question" }))
    ctx.h.db
      .query(
        `INSERT INTO node (id, kind, label, recorded_at, entity_type, entity_id, origin, review_state)
         VALUES ('msg:m','message','user: a private research question',0,'message','m','system','accepted')`,
      )
      .run()
    return ctx
  }

  test("the body is NOT inlined by default", async () => {
    // Vaults sync to iCloud, Dropbox and Git, so exporting the conversation
    // body must be opt-in.
    const { h, vault } = await withMessage()
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const content = await fs.readFile(path.join(vault, (await ls(vault))[0]), "utf8")
    expect(content).not.toContain("## Message")
    h.close()
  })

  test("but the label snippet still reaches the vault — includeText is not a privacy switch", async () => {
    // Pinning the honest contract rather than an assumed one. Message node
    // labels carry a 60-char prompt snippet (derive.ts), which is what makes
    // the graph readable, so it lands in the heading and the filename even
    // with includeText off. `redact` is the flag that actually removes it.
    const { h, vault } = await withMessage()
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    const files = await ls(vault)
    expect(files[0]).toContain("a private research question")
    h.close()
  })

  test("redact removes conversation text from the body, heading AND filename", async () => {
    const { h, vault } = await withMessage()
    await ObsidianExporter.exportVault(h, { targetDir: vault, includeText: true, redact: true })

    const files = await ls(vault)
    const content = await fs.readFile(path.join(vault, files[0]), "utf8")

    expect(files[0]).not.toContain("a private research question")
    expect(content).not.toContain("a private research question")
    expect(content).not.toContain("## Message")
    // The graph shape survives — only the wording is gone.
    expect(content).toContain("user m")
    h.close()
  })

  test("is inlined when explicitly requested", async () => {
    const { h, vault } = await withMessage()
    await ObsidianExporter.exportVault(h, { targetDir: vault, includeText: true })

    const content = await fs.readFile(path.join(vault, (await ls(vault))[0]), "utf8")
    expect(content).toContain("## Message")
    expect(content).toContain("a private research question")
    h.close()
  })
})

describe("pruning", () => {
  test("removes notes whose node is gone", async () => {
    // Without pruning the vault monotonically diverges, rendering nodes that
    // no longer exist with edges to nodes that never will.
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    node(h, "b", "entity", "Beta")
    await ObsidianExporter.exportVault(h, { targetDir: vault })
    expect((await ls(vault)).length).toBe(2)

    h.db.query(`DELETE FROM node WHERE id = 'b'`).run()
    const res = await ObsidianExporter.exportVault(h, { targetDir: vault })

    expect(res.pruned).toBe(1)
    expect((await ls(vault)).length).toBe(1)
    h.close()
  })

  test("never deletes a file this exporter did not write", async () => {
    // Obsidian vaults are user-editable. Deleting a hand-written note because
    // it sits in the export directory would be unforgivable.
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    await ObsidianExporter.exportVault(h, { targetDir: vault })
    await fs.writeFile(path.join(vault, "My own notes.md"), "# mine\nhand written", "utf8")

    h.db.query(`DELETE FROM node WHERE id = 'a'`).run()
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    expect(await ls(vault)).toEqual(["My own notes.md"])
    h.close()
  })

  test("can be turned off", async () => {
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    await ObsidianExporter.exportVault(h, { targetDir: vault })
    h.db.query(`DELETE FROM node WHERE id = 'a'`).run()

    const res = await ObsidianExporter.exportVault(h, { targetDir: vault, prune: false })
    expect(res.pruned).toBe(0)
    expect((await ls(vault)).length).toBe(1)
    h.close()
  })

  test("syncIfPresent refreshes an existing vault", async () => {
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    await ObsidianExporter.exportVault(h, { targetDir: vault })

    node(h, "b", "entity", "Beta")
    const res = await ObsidianExporter.syncIfPresent(h, { targetDir: vault })

    expect(res?.written).toBe(2)
    expect((await ls(vault)).length).toBe(2)
    h.close()
  })

  test("syncIfPresent does NOT create a vault that was never asked for", async () => {
    // `db rebuild` calls this. Conjuring a directory full of Markdown for a
    // user who never ran the export would be surprising.
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")

    expect(await ObsidianExporter.syncIfPresent(h, { targetDir: vault })).toBeUndefined()
    expect(await fs.stat(vault).catch(() => null)).toBeNull()
    h.close()
  })

  test("re-exporting is idempotent", async () => {
    const { h, vault } = await db()
    node(h, "a", "entity", "Alpha")
    node(h, "b", "entity", "Beta")
    edge(h, "a", "b", "mentions")

    const first = await ObsidianExporter.exportVault(h, { targetDir: vault })
    const before = await ls(vault)
    const second = await ObsidianExporter.exportVault(h, { targetDir: vault })

    expect(second.written).toBe(first.written)
    expect(second.pruned).toBe(0)
    expect(await ls(vault)).toEqual(before)
    h.close()
  })
})
