import { DatabaseClient } from "../client"
import { Hash } from "../hash"
import { Log } from "../../../util/log"

export namespace Derive {
  const log = Log.create({ service: "storage.db.graph.derive" })

  const TOOL_INPUT_PATH_KEYS = new Set([
    "filePath",
    "path",
    "file",
    "targetPath",
    "sourcePath",
    "destPath",
    "filename",
  ])

  export function artifactId(path: string): string {
    const norm = path.replace(/\\/g, "/").toLowerCase().trim()
    return "art:" + Hash.sha256Hex(norm).slice(0, 16)
  }

  /** Characters of message text sampled into a node label. */
  const SNIPPET_CHARS = 60

  /**
   * A short, human-readable sample of what a message said.
   *
   * Truncates by code point, not UTF-16 unit: `"🧬".slice(0, 60)` can cut a
   * surrogate pair in half, and the result lands in the graph label, the
   * Obsidian note title, and therefore a filename.
   */
  function messageSnippet(handle: DatabaseClient.Handle, messageId: string): string {
    const rows = handle
      .stmt(
        `SELECT type, json FROM part
          WHERE message_id = ? AND type IN ('text','reasoning')
          ORDER BY CASE type WHEN 'text' THEN 0 ELSE 1 END, created_at
          LIMIT 4`,
      )
      .all(messageId) as { type: string; json: string }[]

    for (const row of rows) {
      let text = ""
      try {
        const parsed = JSON.parse(row.json || "{}")
        text = String(parsed.text ?? parsed.content ?? "")
      } catch {
        continue
      }
      const clean = text.replace(/\s+/g, " ").trim()
      if (!clean) continue
      const points = [...clean]
      const snippet = points.length > SNIPPET_CHARS ? `${points.slice(0, SNIPPET_CHARS).join("")}…` : clean
      // Reasoning is a fallback, so mark it — otherwise a label reads as
      // something the user was shown when it never left the model's head.
      return row.type === "reasoning" ? `(reasoning) ${snippet}` : snippet
    }
    return ""
  }

  export function deriveFromMessage(handle: DatabaseClient.Handle, messageId: string): void {
    const msgRow = handle
      .stmt(`SELECT id, session_id, role, agent, model, created_at, json FROM message WHERE id = ?`)
      .get(messageId) as any
    if (!msgRow) return

    const sesRow = handle
      .stmt(`SELECT id, project_id, created_at FROM session WHERE id = ?`)
      .get(msgRow.session_id) as any
    if (!sesRow) return

    const projectId = sesRow.project_id
    const prjNodeId = `prj:${projectId}`
    const sesNodeId = `ses:${sesRow.id}`
    const msgNodeId = `msg:${msgRow.id}`
    const recordedAt = msgRow.created_at ?? Date.now()

    handle.tx(() => {
      // 1. Ensure project node
      handle
        .stmt(
          `INSERT INTO node (id, kind, label, recorded_at, entity_type, entity_id, origin, review_state) ` +
            `VALUES (?, 'project', ?, ?, 'project', ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
        )
        .run(prjNodeId, `Project ${projectId}`, recordedAt, projectId)

      // 2. Ensure session node + edge
      handle
        .stmt(
          `INSERT INTO node (id, kind, label, recorded_at, entity_type, entity_id, origin, review_state) ` +
            `VALUES (?, 'session', ?, ?, 'session', ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
        )
        .run(sesNodeId, `Session ${sesRow.id}`, recordedAt, sesRow.id)

      handle
        .stmt(
          `INSERT INTO edge (from_id, to_id, relation, origin, created_at) ` +
            `VALUES (?, ?, 'part-of', 'system', ?) ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
        )
        .run(sesNodeId, prjNodeId, recordedAt)

      // 3. Message node + edge
      //
      // The label carries a snippet of what was actually said, which is what
      // makes the graph readable instead of a wall of ids. Prefer visible text;
      // fall back to reasoning, because an assistant turn can be almost all
      // reasoning with a one-word reply, and `message assistant msg_01H…` tells
      // a reader nothing.
      const snippet = messageSnippet(handle, messageId)
      const labelText = snippet
        ? `${msgRow.role ?? "message"}: ${snippet}`
        : `${msgRow.role ?? "message"} ${msgRow.id}`

      handle
        .stmt(
          `INSERT INTO node (id, kind, label, recorded_at, entity_type, entity_id, origin, review_state, derived_at) ` +
            `VALUES (?, 'message', ?, ?, 'message', ?, 'system', 'accepted', ?) ` +
            `ON CONFLICT(id) DO UPDATE SET label = excluded.label, derived_at = excluded.derived_at`,
        )
        .run(msgNodeId, labelText, recordedAt, msgRow.id, Date.now())

      handle
        .stmt(
          `INSERT INTO edge (from_id, to_id, relation, origin, created_at) ` +
            `VALUES (?, ?, 'part-of', 'system', ?) ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
        )
        .run(msgNodeId, sesNodeId, recordedAt)

      // 4. Parts processing
      const parts = handle
        .stmt(`SELECT id, type, tool, path, created_at, json FROM part WHERE message_id = ?`)
        .all(messageId) as any[]

      for (const p of parts) {
        const partVal = JSON.parse(p.json ?? "{}")
        const partTime = p.created_at ?? recordedAt

        if (p.type === "tool") {
          const runNodeId = `run:${p.id}`
          const toolName = p.tool ?? partVal.tool ?? "tool"
          handle
            .stmt(
              `INSERT INTO node (id, kind, subtype, label, recorded_at, entity_type, entity_id, origin, review_state) ` +
                `VALUES (?, 'run', ?, ?, ?, 'part', ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
            )
            .run(runNodeId, toolName, `Run ${toolName}`, partTime, p.id)

          handle
            .stmt(
              `INSERT INTO edge (from_id, to_id, relation, origin, created_at) ` +
                `VALUES (?, ?, 'part-of', 'system', ?) ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
            )
            .run(runNodeId, msgNodeId, partTime)

          // KB nodes from a connector search.
          //
          // `science_search` records these live, but they must also be
          // re-derivable so `db rebuild` does not silently drop the entire
          // knowledge base. The accessions are persisted in the tool part's
          // metadata precisely so this can run offline.
          deriveKbMentions(handle, partVal, msgNodeId, partTime)

          // Tool input paths allowlist
          if (partVal.state?.input && typeof partVal.state.input === "object") {
            for (const [k, v] of Object.entries(partVal.state.input)) {
              if (TOOL_INPUT_PATH_KEYS.has(k) && typeof v === "string" && v.trim()) {
                const artId = artifactId(v)
                handle
                  .stmt(
                    `INSERT INTO node (id, kind, label, recorded_at, origin, review_state) ` +
                      `VALUES (?, 'artifact', ?, ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
                  )
                  .run(artId, v, partTime)

                handle
                  .stmt(
                    `INSERT INTO edge (from_id, to_id, relation, origin, created_at) ` +
                      `VALUES (?, ?, 'consumed', 'system', ?) ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
                  )
                  .run(runNodeId, artId, partTime)
              }
            }
          }
        } else if (p.type === "patch") {
          const runNodeId = `run:${p.id}`
          handle
            .stmt(
              `INSERT INTO node (id, kind, subtype, label, recorded_at, entity_type, entity_id, origin, review_state) ` +
                `VALUES (?, 'run', 'patch', 'Patch', ?, 'part', ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
            )
            .run(runNodeId, partTime, p.id)

          handle
            .stmt(
              `INSERT INTO edge (from_id, to_id, relation, origin, created_at) ` +
                `VALUES (?, ?, 'part-of', 'system', ?) ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
            )
            .run(runNodeId, msgNodeId, partTime)

          if (Array.isArray(partVal.files)) {
            for (const filePath of partVal.files) {
              if (typeof filePath === "string" && filePath.trim()) {
                const artId = artifactId(filePath)
                handle
                  .stmt(
                    `INSERT INTO node (id, kind, label, recorded_at, origin, review_state) ` +
                      `VALUES (?, 'artifact', ?, ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
                  )
                  .run(artId, filePath, partTime)

                const patchMeta = partVal.hash ? JSON.stringify({ patch_hash: partVal.hash }) : null
                handle
                  .stmt(
                    `INSERT INTO edge (from_id, to_id, relation, origin, created_at, meta) ` +
                      `VALUES (?, ?, 'produced', 'system', ?, ?) ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
                  )
                  .run(runNodeId, artId, partTime, patchMeta)
              }
            }
          }
        } else if (p.type === "file") {
          const source = partVal.source
          if (source?.type === "file" || source?.type === "symbol") {
            const filePath = source.path
            if (typeof filePath === "string" && filePath.trim()) {
              const artId = artifactId(filePath)
              handle
                .stmt(
                  `INSERT INTO node (id, kind, label, recorded_at, origin, review_state) ` +
                    `VALUES (?, 'artifact', ?, ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
                )
                .run(artId, filePath, partTime)
            }
          } else if (source?.type === "resource" && source.uri) {
            const entNodeId = `ent:mcp:${source.uri}`
            handle
              .stmt(
                `INSERT INTO node (id, kind, label, recorded_at, authority, accession, origin, review_state) ` +
                  `VALUES (?, 'entity', ?, ?, 'mcp', ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
              )
              .run(entNodeId, source.uri, partTime, source.uri)
          }
        }
      }
    })
  }

  /**
   * Re-create `source`/`entity` nodes and their `mentions` edges from a stored
   * `science_search` tool part.
   *
   * Reads only the persisted metadata — no network. Nodes recorded here keep
   * `origin='system'`: the accession came from the authority, so the identity
   * is observed rather than asserted, and `db rebuild` is allowed to recreate
   * it. Anything the *model* asserted (`kb_assert`, `kb_entity` fallbacks)
   * carries `origin='agent'` and is preserved by rebuild rather than derived.
   */
  function deriveKbMentions(
    handle: DatabaseClient.Handle,
    partVal: any,
    msgNodeId: string,
    at: number,
  ): void {
    const meta = partVal?.state?.metadata
    if (!meta || typeof meta !== "object") return
    const nodes: unknown = meta.kb_nodes
    if (!Array.isArray(nodes) || nodes.length === 0) return

    const label = typeof meta.db === "string" ? meta.db : "source"
    for (const raw of nodes) {
      const nodeId = String(raw ?? "").trim()
      // ids are `src:<authority>:<accession>` or `ent:<authority>:<accession>`
      const parts = nodeId.split(":")
      if (parts.length < 3) continue
      const [prefix, authority, ...rest] = parts
      const accession = rest.join(":")
      if (prefix !== "src" && prefix !== "ent") continue

      handle
        .stmt(
          `INSERT INTO node (id, kind, label, recorded_at, authority, accession, origin, review_state)
           VALUES (?, ?, ?, ?, ?, ?, 'system', 'accepted') ON CONFLICT(id) DO NOTHING`,
        )
        .run(nodeId, prefix === "src" ? "source" : "entity", accession || nodeId, at, authority, accession)

      handle
        .stmt(
          `INSERT INTO edge (from_id, to_id, relation, origin, created_at, meta)
           VALUES (?, ?, 'mentions', 'system', ?, ?)
           ON CONFLICT(from_id, to_id, relation) WHERE revoked_at IS NULL DO NOTHING`,
        )
        .run(msgNodeId, nodeId, at, JSON.stringify({ connector: label }))
    }
  }

  export function deriveAll(handle: DatabaseClient.Handle): void {
    const messages = handle.stmt(`SELECT id FROM message`).all() as { id: string }[]
    for (const msg of messages) {
      deriveFromMessage(handle, msg.id)
    }
  }
}
