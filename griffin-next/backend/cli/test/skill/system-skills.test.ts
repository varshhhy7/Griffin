import { describe, expect, test } from "bun:test"
import path from "path"

// System skills are embedded (src/skill/system/*.txt) so they resolve in every
// install — including the compiled binary, which ships no skills and otherwise
// relies on the API catalog. A skill left out of SYSTEM_SKILLS works in
// `bun run dev` and silently disappears in a real install.
//
// Guard both directions: an embedded copy must not drift from its canonical
// SKILL.md, and a new embedded file must not appear without a guard.
describe("system skills", () => {
  const root = path.join(import.meta.dir, "..", "..")

  const EMBEDDED = [
    { name: "initialize-atlas-graph", file: "initialize-atlas-graph.txt" },
    { name: "think-on-graph", file: "think-on-graph.txt" },
  ]

  for (const skill of EMBEDDED) {
    test(`embedded ${skill.name} matches the canonical SKILL.md`, async () => {
      const embedded = await Bun.file(path.join(root, "src/skill/system", skill.file)).text()
      const canonical = await Bun.file(path.join(root, "skills/research", skill.name, "SKILL.md")).text()
      expect(embedded).toBe(canonical)
    })
  }

  test("every file in src/skill/system is covered by a drift guard", async () => {
    // Adding an embedded skill without listing it above would leave it free to
    // drift from its canonical source unnoticed.
    const found: string[] = []
    for await (const file of new Bun.Glob("*.txt").scan({ cwd: path.join(root, "src/skill/system") })) {
      found.push(file)
    }
    expect(found.sort()).toEqual(EMBEDDED.map((s) => s.file).sort())
  })
})
