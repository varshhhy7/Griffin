from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional

from .paths import resolve_db_path


class SchemaVersionError(RuntimeError):
    pass


# Contract views, not physical tables.
#
# Views are free, live in TypeScript-owned schema, and let the backend refactor
# its tables without touching Python. Depending on tables directly would couple
# the two release cycles, which is the thing this boundary exists to prevent.
REQUIRED_VIEWS = {
    "v_project",
    "v_session",
    "v_message",
    "v_research_run",
    "v_node",
    "v_edge_active",
}

# Accepted schema range, NOT an equality check.
#
# Equality would break Python the instant TypeScript adds any migration, even
# one that does not touch the views above. The range says: "these views have
# been stable since MIN, and MAX is the newest schema this client was written
# against." Bump MAX when a migration is known-compatible; bump MIN only when a
# view's shape actually changes.
# 2: contract views introduced. 3: graph layer (v_node, v_edge_active).
# 4: full-text search tables. 5: governed relation and node-kind taxonomy.
#    Both additive, no view change, so the range widens
#    rather than the minimum moving.
MIN_SUPPORTED_SCHEMA = 2
MAX_KNOWN_SCHEMA = 5


def schema_version(conn: sqlite3.Connection) -> int:
    try:
        row = conn.execute("SELECT COALESCE(MAX(id), 0) FROM schema_migrations").fetchone()
    except sqlite3.Error:
        return 0
    return int(row[0]) if row else 0


def open_readonly(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """
    Open the Griffin datastore read-only.

    Read-only is `mode=rw` plus `PRAGMA query_only=1`, deliberately NOT
    `mode=ro`: a true read-only connection cannot create the `-shm` file, so it
    fails SQLITE_CANTOPEN against a WAL database with no live writer. That
    would be the single most common failure mode for this client.

    TypeScript owns every migration. If Python ever needs to write, it shells
    out to the `griffin` binary or POSTs the local server — it never opens rw.
    """
    target = db_path or resolve_db_path()
    if not target.exists():
        raise FileNotFoundError(f"Database file not found at {target}. Run 'griffin db backfill' first.")

    # `mode=rw` never creates the file, so a missing database surfaces as the
    # FileNotFoundError above rather than as an empty database that the
    # TypeScript migration runner would later find schema-less.
    uri = f"file:{target.resolve().as_posix()}?mode=rw"
    conn = sqlite3.connect(uri, uri=True, timeout=5.0)
    conn.execute("PRAGMA query_only = 1;")
    conn.execute("PRAGMA busy_timeout = 5000;")

    views = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='view'")}
    missing = REQUIRED_VIEWS - views
    if missing:
        conn.close()
        raise SchemaVersionError(
            f"Database at {target} is missing required contract views: {sorted(missing)}. "
            "Upgrade the griffin-next backend, then run 'griffin db status'."
        )

    version = schema_version(conn)
    if version and not (MIN_SUPPORTED_SCHEMA <= version <= MAX_KNOWN_SCHEMA):
        conn.close()
        raise SchemaVersionError(
            f"Database at {target} is at schema version {version}, but this client supports "
            f"{MIN_SUPPORTED_SCHEMA}..{MAX_KNOWN_SCHEMA}. "
            + (
                "Upgrade the Python package."
                if version > MAX_KNOWN_SCHEMA
                else "Upgrade the griffin-next backend and run 'griffin db status'."
            )
        )

    return conn
