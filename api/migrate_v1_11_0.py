"""
CVA Tool v1.11.0 — std_variant Session Column Migration
========================================================

Adds `std_variant VARCHAR(8) NOT NULL DEFAULT '0'` to the `sessions` table
so that each CVA's last-used Standard panel variant is persisted across
sessions. Default '0' means new CVAs start with the wrapperless variant.

Idempotency:
    Guarded by the `schema_meta` table (created by migrate_v190).
    On first run the column is added, then a `schema_meta` row for
    version `1.11.0` is inserted. On subsequent startups the presence
    of that row short-circuits the entire migration.

Called from `api/main.py` via `migrate_v1_11_0.run_if_needed(_DB_CONFIG)`
inside the `@app.on_event("startup")` handler.
"""

from __future__ import annotations

from typing import Any

import pymysql
import pymysql.cursors

SCHEMA_VERSION = "1.11.0"


def run_if_needed(db_config: dict[str, Any]) -> None:
    """
    Apply the v1.11.0 migration if it has not already been applied.

    Args:
        db_config: kwargs for pymysql.connect() — same dict used in main.py.
    """
    conn = pymysql.connect(**db_config)
    try:
        with conn.cursor() as cur:
            if _is_applied(cur):
                print(f"[migrate_v1_11_0] schema_meta has {SCHEMA_VERSION} — no-op.")
                return

            print(f"[migrate_v1_11_0] Applying schema version {SCHEMA_VERSION}...")

            # Add std_variant column (idempotent — catch duplicate column error)
            try:
                cur.execute(
                    "ALTER TABLE sessions "
                    "ADD COLUMN std_variant VARCHAR(8) NOT NULL DEFAULT '0'"
                )
                print("[migrate_v1_11_0] Added sessions.std_variant column.")
            except pymysql.err.OperationalError as exc:
                if exc.args[0] == 1060:  # Duplicate column name
                    print("[migrate_v1_11_0] sessions.std_variant already exists — skipping ALTER.")
                else:
                    raise

            # Stamp schema_meta
            cur.execute(
                "INSERT IGNORE INTO schema_meta (version, description) VALUES (%s, %s)",
                (SCHEMA_VERSION, "Add std_variant column to sessions for sticky variant selection"),
            )

        conn.commit()
    finally:
        conn.close()

    print(f"[migrate_v1_11_0] v{SCHEMA_VERSION} migration complete.")


def _is_applied(cur) -> bool:
    """Return True if the v1.11.0 schema_meta row already exists."""
    cur.execute(
        "SELECT 1 FROM schema_meta WHERE version = %s",
        (SCHEMA_VERSION,),
    )
    return cur.fetchone() is not None
