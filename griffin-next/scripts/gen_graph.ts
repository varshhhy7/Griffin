import { DatabaseClient } from "../backend/cli/src/storage/db/client";
import fs from "node:fs";

const h = DatabaseClient.reader();
// Single quotes for the literal: SQLite resolves a double-quoted token as an
// identifier first and only falls back to a string by legacy quirk, so
// `!= "rejected"` silently compares the column to itself if a column of that
// name is ever added. Merged nodes are excluded — they are non-destructive
// duplicates and rendering them doubles up the graph.
const nodes = h.db
  .query(`SELECT id, kind, label, subtype FROM node WHERE review_state != 'rejected' AND merged_into IS NULL`)
  .all() as any[];
const edges = h.db.query(`SELECT from_id, to_id, relation FROM edge WHERE revoked_at IS NULL`).all() as any[];

const graphData = {
  nodes: nodes.map(n => ({ id: String(n.id), name: n.label || String(n.id), group: n.kind })),
  links: edges.map(e => ({ source: String(e.from_id), target: String(e.to_id), label: e.relation }))
};

const html = `<!DOCTYPE html>
<html>
<head>
  <title>Griffin Knowledge Graph</title>
  <script src="https://unpkg.com/3d-force-graph"></script>
  <style>
    body { margin: 0; background: #0b0f19; color: #fff; font-family: system-ui, sans-serif; overflow: hidden; }
    #info { position: absolute; top: 16px; left: 16px; background: rgba(15,23,42,0.85); backdrop-filter: blur(8px); padding: 14px 18px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); z-index: 10; }
    h1 { margin: 0 0 4px 0; font-size: 16px; }
    p { margin: 0; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div id="info">
    <h1>Griffin Knowledge Graph</h1>
    <p>Nodes: ${nodes.length} | Edges: ${edges.length} | Drag, scroll to zoom, click to inspect</p>
  </div>
  <div id="3d-graph"></div>
  <script>
    const data = ${JSON.stringify(graphData)};
    const colors = { entity: '#3b82f6', source: '#10b981', session: '#8b5cf6', artifact: '#f59e0b', run: '#ec4899', claim: '#f43f5e', project: '#6366f1' };

    const Graph = ForceGraph3D()(document.getElementById('3d-graph'))
      .graphData(data)
      .nodeColor(n => colors[n.group] || '#64748b')
      .nodeLabel(node => "[" + node.group + "] " + node.name)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .linkCurvature(0.2)
      .linkLabel(link => link.label);
  </script>
</body>
</html>`;

fs.writeFileSync('kg_view.html', html);
console.log(`Successfully generated kg_view.html with ${nodes.length} nodes and ${edges.length} edges!`);
h.close();
