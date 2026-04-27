"""
CVA Tool v1.10.0 — wrapper_mode Column Migration
=================================================

Adds `wrapper_mode VARCHAR(8) NULL` and a covering index to the `pairs` table.

Idempotency:
    Guarded by the `schema_meta` table (created by migrate_v190).
    On first run the column and index are added, then a `schema_meta`
    row for version `1.10.0` is inserted.  On subsequent startups the
    presence of that row short-circuits the entire migration.

This script is called from `api/main.py` via
`migrate_v1_10_0.run_if_needed(_DB_CONFIG)` inside the
`@app.on_event("startup")` handler, after `migrate_v190.run_if_needed`.
"""

from __future__ import annotations

from typing import Any

import pymysql
import pymysql.cursors

SCHEMA_VERSION = "1.10.0"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_if_needed(db_config: dict[str, Any]) -> None:
    """
    Apply the v1.10.0 migration if it has not already been applied.

    Args:
        db_config: kwargs for pymysql.connect() — same dict used elsewhere
                   in api/main.py as _DB_CONFIG.
    """
    conn = pymysql.connect(**db_config)
    try:
        with conn.cursor() as cur:
            if _is_applied(cur):
                print(f"[migrate_v1_10_0] schema_meta has {SCHEMA_VERSION} — no-op.")
                return

            print(f"[migrate_v1_10_0] Applying schema version {SCHEMA_VERSION}...")

            # Add wrapper_mode column (idempotent — IGNORE error if already exists)
            try:
                cur.execute(
                    "ALTER TABLE pairs "
                    "ADD COLUMN wrapper_mode VARCHAR(8) NULL "
                    "AFTER pii_scrubbed"
                )
                print("[migrate_v1_10_0] Added pairs.wrapper_mode column.")
            except pymysql.err.OperationalError as exc:
                if exc.args[0] == 1060:  # Duplicate column name
                    print("[migrate_v1_10_0] pairs.wrapper_mode already exists — skipping ALTER.")
                else:
                    raise

            # Add index (idempotent — IGNORE error if already exists)
            try:
                cur.execute(
                    "CREATE INDEX idx_pairs_wrapper ON pairs (wrapper_mode)"
                )
                print("[migrate_v1_10_0] Created idx_pairs_wrapper index.")
            except pymysql.err.OperationalError as exc:
                if exc.args[0] == 1061:  # Duplicate key name
                    print("[migrate_v1_10_0] idx_pairs_wrapper already exists — skipping.")
                else:
                    raise

            # Stamp schema_meta (only after schema changes succeed)
            cur.execute(
                "INSERT IGNORE INTO schema_meta (version, description) VALUES (%s, %s)",
                (SCHEMA_VERSION, "Add wrapper_mode column + index to pairs"),
            )

        conn.commit()
    finally:
        conn.close()

    print(f"[migrate_v1_10_0] v{SCHEMA_VERSION} migration complete.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_applied(cur) -> bool:
    """Return True if the v1.10.0 schema_meta row already exists."""
    cur.execute(
        "SELECT 1 FROM schema_meta WHERE version = %s",
        (SCHEMA_VERSION,),
    )
    return cur.fetchone() is not None
