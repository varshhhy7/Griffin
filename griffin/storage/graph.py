from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional
from .db import open_readonly

class GraphStore:
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path

    def get_node(self, node_id: str) -> Optional[Dict[str, Any]]:
        conn = open_readonly(self.db_path)
        try:
            cursor = conn.execute(
                "SELECT id, kind, subtype, label, recorded_at, accession, authority, origin, review_state "
                "FROM v_node WHERE id = ?",
                (node_id,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "kind": row[1],
                "subtype": row[2],
                "label": row[3],
                "recorded_at": row[4],
                "accession": row[5],
                "authority": row[6],
                "origin": row[7],
                "review_state": row[8],
            }
        finally:
            conn.close()

    def lineage(self, node_id: str, max_depth: int = 6) -> Dict[str, List[Dict[str, Any]]]:
        conn = open_readonly(self.db_path)
        try:
            sql = """
                WITH RECURSIVE anc(id, depth) AS (
                    SELECT ?, 0
                    UNION ALL
                    SELECT e.to_id, a.depth + 1
                    FROM v_edge_active e
                    JOIN anc a ON e.from_id = a.id
                    WHERE a.depth < ?
                )
                SELECT DISTINCT n.id, n.kind, n.subtype, n.label, n.recorded_at, n.origin, n.review_state
                FROM v_node n JOIN anc a ON n.id = a.id
            """
            cursor = conn.execute(sql, (node_id, max_depth))
            nodes = [
                {
                    "id": r[0],
                    "kind": r[1],
                    "subtype": r[2],
                    "label": r[3],
                    "recorded_at": r[4],
                    "origin": r[5],
                    "review_state": r[6],
                }
                for r in cursor.fetchall()
            ]
            
            node_ids = tuple(n["id"] for n in nodes)
            if not node_ids:
                return {"nodes": [], "edges": []}
            
            placeholders = ",".join("?" * len(node_ids))
            edges_cursor = conn.execute(
                f"SELECT id, from_id, to_id, relation, origin, confidence, created_at "
                f"FROM v_edge_active WHERE from_id IN ({placeholders}) AND to_id IN ({placeholders})",
                node_ids + node_ids,
            )
            edges = [
                {
                    "id": r[0],
                    "from_id": r[1],
                    "to_id": r[2],
                    "relation": r[3],
                    "origin": r[4],
                    "confidence": r[5],
                    "created_at": r[6],
                }
                for r in edges_cursor.fetchall()
            ]
            return {"nodes": nodes, "edges": edges}
        finally:
            conn.close()
