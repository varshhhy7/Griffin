from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional
from .db import open_readonly

class RunStore:
    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path

    def get(self, run_id: str) -> Optional[Dict[str, Any]]:
        conn = open_readonly(self.db_path)
        try:
            cursor = conn.execute(
                "SELECT id, project_id, session_id, workflow_id, workflow_version, status, created_at, updated_at "
                "FROM v_research_run WHERE id = ?",
                (run_id,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            return {
                "id": row[0],
                "project_id": row[1],
                "session_id": row[2],
                "workflow_id": row[3],
                "workflow_version": row[4],
                "status": row[5],
                "created_at": row[6],
                "updated_at": row[7],
            }
        finally:
            conn.close()

    def list(self, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
        conn = open_readonly(self.db_path)
        try:
            if project_id:
                cursor = conn.execute(
                    "SELECT id, project_id, session_id, workflow_id, workflow_version, status, created_at, updated_at "
                    "FROM v_research_run WHERE project_id = ? ORDER BY updated_at DESC",
                    (project_id,),
                )
            else:
                cursor = conn.execute(
                    "SELECT id, project_id, session_id, workflow_id, workflow_version, status, created_at, updated_at "
                    "FROM v_research_run ORDER BY updated_at DESC"
                )
            return [
                {
                    "id": r[0],
                    "project_id": r[1],
                    "session_id": r[2],
                    "workflow_id": r[3],
                    "workflow_version": r[4],
                    "status": r[5],
                    "created_at": r[6],
                    "updated_at": r[7],
                }
                for r in cursor.fetchall()
            ]
        finally:
            conn.close()
