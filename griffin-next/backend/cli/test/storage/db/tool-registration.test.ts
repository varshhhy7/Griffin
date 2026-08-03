import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { ToolRegistry } from "../../../src/tool/registry"
import { DatabaseMode } from "../../../src/storage/db/mode"

/**
 * The graph and KB tools existed, were tested, and were unreachable: nothing
 * imported them into `tool/registry.ts`, so the model could never call one.
 * A unit test of a tool's `execute` does not catch that — only asking the
 * registry what it actually offers does.
 */
const DB_TOOLS = [
  "graph_search",
  "graph_neighbors",
  "graph_lineage",
  "graph_link",
  "graph_explore_relations",
  "graph_expand",
  "graph_evidence",
  "graph_reason",
  "kb_assert",
  "kb_entity",
  "kb_link",
  "kb_node",
  "kb_vocabulary_propose",
]

afterEach(() => {
  delete process.env["GRIFFIN_DB"]
  DatabaseMode.reset()
})

async function ids(mode?: string) {
  if (mode) process.env["GRIFFIN_DB"] = mode
  else delete process.env["GRIFFIN_DB"]
  DatabaseMode.reset()

  await using tmp = await tmpdir()
  return Instance.provide({ directory: tmp.path, fn: () => ToolRegistry.ids() })
}

test("datastore tools are registered when the database is enabled", async () => {
  const registered = await ids("shadow")
  for (const id of DB_TOOLS) expect(registered).toContain(id)
})

test("datastore tools are absent when experimental.db is off", async () => {
  // Acceptance criterion 2: `off` restores current behavior exactly. Offering
  // the model tools that open a database the user opted out of would break it.
  const registered = await ids("off")
  for (const id of DB_TOOLS) expect(registered).not.toContain(id)
})

test("provenance tools stay registered in both modes", async () => {
  // They predate the datastore and are backed by graph.json, so the gate must
  // not accidentally take them with it.
  expect(await ids("off")).toContain("provenance_record")
  expect(await ids("shadow")).toContain("provenance_record")
})
