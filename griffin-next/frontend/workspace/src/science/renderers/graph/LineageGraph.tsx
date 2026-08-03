import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { JSX } from "solid-js"

type Status = "idle" | "loading" | "ready" | "empty" | "error"

export interface GraphNode {
  id: string
  kind: string
  label: string
  origin: string
  review_state: string
  subtype?: string | null
}

export interface GraphEdge {
  id?: number | string
  from_id: string
  to_id: string
  relation: string
}

export interface LineageGraphProps {
  data?: {
    nodes?: GraphNode[]
    edges?: GraphEdge[]
  }
  height?: number
}

export function LineageGraph(props: LineageGraphProps): JSX.Element {
  let host!: HTMLDivElement
  const [status, setStatus] = createSignal<Status>("idle")
  const [error, setError] = createSignal<string>("")
  let disposed = false
  let token = 0

  onMount(async () => {
    setStatus("loading")
    try {
      if (disposed) return
      setStatus("ready")
    } catch (e) {
      if (!disposed) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus("error")
      }
    }
  })

  createEffect(() => {
    const data = props.data
    void renderGraph(data)
  })

  async function renderGraph(data: LineageGraphProps["data"]) {
    const my = ++token
    if (!data?.nodes || data.nodes.length === 0) {
      setStatus("empty")
      if (host) host.innerHTML = ""
      return
    }

    setStatus("loading")
    setError("")

    try {
      if (my !== token || disposed) return
      // Dynamic import Cytoscape and cytoscape-dagre layout
      const [cytoscapeMod, dagreMod] = await Promise.all([
        import("cytoscape").catch(() => null),
        import("cytoscape-dagre").catch(() => null),
      ])

      if (my !== token || disposed) return

      if (cytoscapeMod && cytoscapeMod.default && host) {
        const cytoscape = cytoscapeMod.default
        if (dagreMod && dagreMod.default) {
          cytoscape.use(dagreMod.default)
        }

        const elements = [
          ...data.nodes.map((n) => ({
            data: {
              id: n.id,
              label: `${n.label}\n[${n.kind}${n.subtype ? "/" + n.subtype : ""}]`,
              origin: n.origin,
              review: n.review_state,
            },
            classes: `${n.origin} ${n.review_state}`,
          })),
          ...(data.edges ?? []).map((e, idx) => ({
            data: {
              id: `e_${e.from_id}_${e.to_id}_${idx}`,
              source: e.from_id,
              target: e.to_id,
              label: e.relation,
            },
          })),
        ]

        host.innerHTML = ""
        cytoscape({
          container: host,
          elements,
          style: [
            {
              selector: "node",
              style: {
                label: "data(label)",
                "text-wrap": "wrap",
                "font-size": "10px",
                "text-valign": "center",
                "text-halign": "center",
                "background-color": "#1e293b",
                color: "#f8fafc",
                "border-width": 2,
                "border-color": "#3b82f6",
                width: "120px",
                height: "50px",
                shape: "round-rectangle",
              },
            },
            {
              selector: "node.agent.unreviewed",
              style: {
                "border-style": "dashed",
                "border-color": "#eab308",
                "background-color": "#1c1917",
                color: "#fef08a",
              },
            },
            {
              selector: "edge",
              style: {
                width: 2,
                "line-color": "#64748b",
                "target-arrow-color": "#64748b",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                label: "data(label)",
                "font-size": "9px",
                color: "#94a3b8",
              },
            },
          ],
          layout: {
            name: "dagre",
            rankDir: "LR",
            nodeSep: 30,
            rankSep: 60,
          } as any,
        })
      } else {
        // Fallback canvas/SVG renderer when cytoscape library is not installed
        renderFallbackSvg(data)
      }

      if (my === token && !disposed) {
        setStatus("ready")
      }
    } catch (e) {
      if (my === token && !disposed) {
        setError(e instanceof Error ? e.message : String(e))
        setStatus("error")
      }
    }
  }

  function renderFallbackSvg(data: NonNullable<LineageGraphProps["data"]>) {
    if (!host) return
    const nodes = data.nodes || []
    const edges = data.edges || []
    let svgHtml = `<svg width="100%" height="100%" style="background:#0b0d12;" xmlns="http://www.w3.org/2000/svg">`
    svgHtml += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker></defs>`

    nodes.forEach((n, i) => {
      const x = 40 + (i % 4) * 180
      const y = 40 + Math.floor(i / 4) * 90
      const isUnreviewed = n.review_state === "unreviewed"
      const stroke = isUnreviewed ? "#eab308" : "#3b82f6"
      const fill = isUnreviewed ? "#1c1917" : "#1e293b"
      const dash = isUnreviewed ? 'stroke-dasharray="4 4"' : ""

      svgHtml += `<rect x="${x}" y="${y}" width="140" height="50" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="2" ${dash}/>`
      svgHtml += `<text x="${x + 70}" y="${y + 22}" fill="#f8fafc" font-size="11" font-family="sans-serif" text-anchor="middle">${n.label.slice(0, 18)}</text>`
      svgHtml += `<text x="${x + 70}" y="${y + 38}" fill="#94a3b8" font-size="9" font-family="sans-serif" text-anchor="middle">[${n.kind}] ${n.review_state}</text>`
    })

    edges.forEach((e) => {
      const srcIdx = nodes.findIndex((n) => n.id === e.from_id)
      const tgtIdx = nodes.findIndex((n) => n.id === e.to_id)
      if (srcIdx >= 0 && tgtIdx >= 0) {
        const x1 = 40 + (srcIdx % 4) * 180 + 70
        const y1 = 40 + Math.floor(srcIdx / 4) * 90 + 25
        const x2 = 40 + (tgtIdx % 4) * 180 + 70
        const y2 = 40 + Math.floor(tgtIdx / 4) * 90 + 25
        svgHtml += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="1.5" marker-end="url(#arrow)"/>`
      }
    })

    svgHtml += `</svg>`
    host.innerHTML = svgHtml
  }

  onCleanup(() => {
    disposed = true
    token++
  })

  const height = () => props.height ?? 400

  return (
    <div
      data-component="lineage-graph"
      style={{
        position: "relative",
        width: "100%",
        height: `${height()}px`,
        overflow: "hidden",
        "border-radius": "4px",
        background: "#0b0d12",
      }}
    >
      <div ref={host} style={{ position: "absolute", inset: "0" }} />
      <Show when={status() !== "ready"}>
        <div
          style={{
            position: "absolute",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "text-align": "center",
            padding: "12px",
            "pointer-events": "none",
            color: "#c7ccd6",
            font: "13px/1.5 ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <Show when={status() === "loading"}>Loading lineage graph…</Show>
          <Show when={status() === "empty"}>No lineage graph to display.</Show>
          <Show when={status() === "error"}>
            <span style={{ color: "#ff8f8f" }}>Could not render lineage graph: {error()}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export default LineageGraph
