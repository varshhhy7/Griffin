"""
Contract test between the Python client and the TypeScript-owned datastore.

The fixture is built from ``schemas/griffin-db.sql``, which is GENERATED from
``griffin-next/backend/cli/src/storage/db/migrations/index.ts`` and kept in
sync by ``test/storage/db/schema-snapshot.test.ts`` on the TypeScript side.

This matters more than it looks. An earlier version of this file hand-wrote its
own ``CREATE TABLE``/``CREATE VIEW`` statements inline, which made it pass no
matter what the real schema did — it proved only that Python agreed with
Python, and could never detect the backend drift it exists to catch. Never
reintroduce inline DDL here.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional, Set

import pytest

from griffin.storage.db import (
    MAX_KNOWN_SCHEMA,
    MIN_SUPPORTED_SCHEMA,
    REQUIRED_VIEWS,
    SchemaVersionError,
    open_readonly,
    schema_version,
)
from griffin.storage.graph import GraphStore
from griffin.storage.run_store import RunStore

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_SQL = REPO_ROOT / "schemas" / "griffin-db.sql"

# Columns Python actually selects. If the backend drops or renames one of
# these, this list is what turns that into a red build rather than a runtime
# error in a user's session.
VIEW_COLUMNS = {
    "v_research_run": {
        "id",
        "project_id",
        "session_id",
        "workflow_id",
        "workflow_version",
        "status",
        "created_at",
        "updated_at",
    },
    "v_node": {"id", "kind", "subtype", "label", "recorded_at", "accession", "authority", "origin", "review_state"},
    "v_edge_active": {"id", "from_id", "to_id", "relation", "origin", "confidence", "created_at"},
    "v_session": {"id", "project_id", "parent_id", "title", "created_at", "updated_at"},
    "v_message": {"id", "session_id", "role", "agent", "model", "created_at"},
    "v_project": {"id", "vcs", "worktree"},
}


def build_db(path: Path, schema_version_row: Optional[int] = MAX_KNOWN_SCHEMA) -> Path:
    """Materialize a database from the generated schema snapshot."""
    assert SCHEMA_SQL.is_file(), (
        f"{SCHEMA_SQL} is missing. Regenerate it with:\n"
        "  cd griffin-next/backend/cli && bun run src/index.ts db schema --write"
    )
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
    # The migration runner creates this table; the DDL snapshot does not.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)"
    )
    if schema_version_row is not None:
        conn.execute(
            "INSERT OR REPLACE INTO schema_migrations (id, name, applied_at) VALUES (?, 'snapshot', 0)",
            (schema_version_row,),
        )
    conn.commit()
    conn.close()
    return path


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    return build_db(tmp_path / "griffin.db")


def test_snapshot_exists_and_is_generated() -> None:
    text = SCHEMA_SQL.read_text(encoding="utf-8")
    assert "GENERATED FILE" in text, "schemas/griffin-db.sql must be generated, not hand-edited"


def test_every_required_view_exists(db: Path) -> None:
    conn = open_readonly(db)
    try:
        views = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='view'")}
        assert REQUIRED_VIEWS <= views
    finally:
        conn.close()


@pytest.mark.parametrize("view,columns", sorted(VIEW_COLUMNS.items()))
def test_view_exposes_the_columns_python_selects(db: Path, view: str, columns: Set[str]) -> None:
    conn = open_readonly(db)
    try:
        actual = {row[1] for row in conn.execute("PRAGMA table_info({})".format(view))}
        assert columns <= actual, "{} is missing {}".format(view, sorted(columns - actual))
    finally:
        conn.close()


def test_schema_version_is_within_the_supported_range(db: Path) -> None:
    conn = open_readonly(db)
    try:
        assert MIN_SUPPORTED_SCHEMA <= schema_version(conn) <= MAX_KNOWN_SCHEMA
    finally:
        conn.close()


def test_run_store_reads_through_the_view(db: Path) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO research_run (id, project_id, session_id, workflow_id, workflow_version, status, "
        "created_at, updated_at, json) VALUES ('r1','p1','s1','w1','v1','completed',1000,1000,'{}')"
    )
    conn.commit()
    conn.close()

    run = RunStore(db).get("r1")
    assert run is not None
    assert run["id"] == "r1"
    assert run["status"] == "completed"
    assert [r["id"] for r in RunStore(db).list("p1")] == ["r1"]


def test_graph_store_reads_through_the_view(db: Path) -> None:
    conn = sqlite3.connect(db)
    conn.execute(
        "INSERT INTO node (id, kind, subtype, label, recorded_at, origin, review_state) "
        "VALUES ('n1','artifact',NULL,'file.py',1000,'system','accepted')"
    )
    conn.commit()
    conn.close()

    node = GraphStore(db).get_node("n1")
    assert node is not None
    assert node["kind"] == "artifact"


def test_v_node_hides_merged_nodes(db: Path) -> None:
    # Dedupe is non-destructive: merged nodes stay in the table but must not
    # appear through the contract view.
    conn = sqlite3.connect(db)
    conn.executescript(
        "INSERT INTO node (id, kind, label, recorded_at, origin, review_state) "
        "VALUES ('keep','entity','TP53',0,'agent','accepted');"
        "INSERT INTO node (id, kind, label, recorded_at, origin, review_state, merged_into) "
        "VALUES ('dupe','entity','p53',0,'agent','accepted','keep');"
    )
    conn.commit()
    conn.close()

    conn = open_readonly(db)
    try:
        assert {r[0] for r in conn.execute("SELECT id FROM v_node")} == {"keep"}
    finally:
        conn.close()


def test_v_edge_active_hides_revoked_edges(db: Path) -> None:
    # Edges are append-only; correction sets revoked_at rather than deleting.
    conn = sqlite3.connect(db)
    conn.executescript(
        "INSERT INTO node (id, kind, label, recorded_at, origin, review_state) "
        "VALUES ('a','entity','A',0,'system','accepted');"
        "INSERT INTO node (id, kind, label, recorded_at, origin, review_state) "
        "VALUES ('b','entity','B',0,'system','accepted');"
        "INSERT INTO edge (from_id, to_id, relation, origin, created_at) VALUES ('a','b','same-as','agent',0);"
        "INSERT INTO edge (from_id, to_id, relation, origin, created_at, revoked_at) "
        "VALUES ('b','a','same-as','agent',0,1);"
    )
    conn.commit()
    conn.close()

    conn = open_readonly(db)
    try:
        assert [tuple(r) for r in conn.execute("SELECT from_id, to_id FROM v_edge_active")] == [("a", "b")]
    finally:
        conn.close()


def test_connection_is_read_only(db: Path) -> None:
    conn = open_readonly(db)
    try:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute(
                "INSERT INTO node (id, kind, label, recorded_at, origin, review_state) "
                "VALUES ('x','entity','X',0,'agent','unreviewed')"
            )
    finally:
        conn.close()


def test_missing_db_raises_file_not_found(tmp_path: Path) -> None:
    # Must not create the file: sqlite's default would leave an empty database
    # that the TypeScript migration runner then finds schema-less.
    missing = tmp_path / "absent.db"
    with pytest.raises(FileNotFoundError):
        open_readonly(missing)
    assert not missing.exists()


def test_missing_views_raises_schema_version_error(tmp_path: Path) -> None:
    path = tmp_path / "empty.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE foo (id INT)")
    conn.commit()
    conn.close()

    with pytest.raises(SchemaVersionError):
        open_readonly(path)


def test_schema_newer_than_this_client_is_rejected(tmp_path: Path) -> None:
    # A range check, not equality — equality would break Python on every
    # backend migration, including ones that never touch these views.
    path = build_db(tmp_path / "future.db", schema_version_row=MAX_KNOWN_SCHEMA + 5)
    with pytest.raises(SchemaVersionError, match="Upgrade the Python package"):
        open_readonly(path)


def test_schema_older_than_supported_is_rejected(tmp_path: Path) -> None:
    path = build_db(tmp_path / "old.db", schema_version_row=MIN_SUPPORTED_SCHEMA - 1)
    with pytest.raises(SchemaVersionError, match="Upgrade the griffin-next backend"):
        open_readonly(path)
