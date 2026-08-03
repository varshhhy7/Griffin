/**
 * Export the knowledge graph to an Obsidian vault.
 *
 * Thin wrapper around the real exporter. This used to be a second, independent
 * implementation that had drifted: it keyed note filenames on `node.label`, and
 * labels are not unique — `derive.ts` names every tool run `Run <tool>` — so
 * notes silently overwrote each other and their edges were lost, while the
 * script reported every node as exported.
 *
 * Equivalent to: `griffin db export-obsidian --target-dir obsidian_kg`
 */
import path from "node:path"
import { DatabaseClient } from "../backend/cli/src/storage/db/client"
import { ObsidianExporter } from "../backend/cli/src/storage/db/graph/obsidian"

const handle = DatabaseClient.reader()
const res = await ObsidianExporter.exportVault(handle, {
  targetDir: path.join(process.cwd(), "obsidian_kg"),
  // --include-text inlines full message bodies; --redact strips conversation
  // wording from the body, heading and filename alike.
  includeText: process.argv.includes("--include-text"),
  redact: process.argv.includes("--redact"),
})

console.log(`Wrote ${res.written} note(s), pruned ${res.pruned}, ${res.edges} edge(s) -> ${res.targetDir}`)
handle.close()
