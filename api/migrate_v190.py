"""
CVA Tool v1.9.0 — Schema Foundation Migration
==============================================

Runs once at API startup before the corpus is loaded.

Idempotency:
    Guarded by the `schema_meta` table. On first run we create schema_meta,
    drop + recreate the four case-related tables with the new `case_id`
    VARCHAR(12) column (and review/versioning/pair_id columns), create the
    `audit_logs` table, rewrite `data/corpus/*.jsonl` from `case_number` to
    `case_id` (backing up the old files to `data/corpus_v1.8/`), then insert
    a `schema_meta` row for version `1.9.0`. On subsequent runs the presence
    of that row short-circuits the entire migration.

This script is called from `api/main.py` via
`migrate_v190.run_if_needed(_DB_CONFIG)` inside the `@app.on_event("startup")`
handler, before `_run_migrations()` (which owns the users/sessions DDL).

Important:
    Peter confirmed existing test data (pairs/skips/flags/queue_inflight rows
    and the `sessions` row) can be wiped. This script therefore drops and
    recreates those tables rather than attempting an in-place column
    ALTER. The `sessions` table is also recreated because its
    `last_case_number INT` column becomes `last_case_id VARCHAR(12)`.

    The `users` and `corpus` data are preserved. users.json is the source of
    truth for users and is re-seeded by `_seed_users()` in main.py.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pymysql

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCHEMA_VERSION = "1.9.0"
SEED_DATE = "260314"  # YYMMDD — original corpus build date (2026-03-14)

# Layout of the repo as seen from api/main.py's _DB_CONFIG caller
_API_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _API_DIR.parent
_CORPUS_DIR = _REPO_ROOT / "data" / "corpus"
_CORPUS_BACKUP_DIR = _REPO_ROOT / "data" / "corpus_v1.8"


# ---------------------------------------------------------------------------
# DDL — v1.9.0 schema
# ---------------------------------------------------------------------------

_DDL_SCHEMA_META = (
    "CREATE TABLE IF NOT EXISTS schema_meta ("
    "  version     VARCHAR(8)   NOT NULL,"
    "  applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    "  description VARCHAR(256),"
    "  PRIMARY KEY (version)"
    ") CHARACTER SET utf8mb4"
)

_DDL_AUDIT_LOGS = (
    "CREATE TABLE IF NOT EXISTS audit_logs ("
    "  audit_id       VARCHAR(36)  NOT NULL,"
    "  user_id        VARCHAR(64)  NOT NULL,"
    "  action         VARCHAR(64)  NOT NULL,"
    "  resource_type  VARCHAR(32)  NOT NULL,"
    "  resource_id    VARCHAR(64)  NOT NULL,"
    "  before_state   LONGTEXT     NULL,"
    "  after_state    LONGTEXT     NULL,"
    "  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,"
    "  PRIMARY KEY (audit_id),"
    "  INDEX idx_audit_resource  (resource_type, resource_id),"
    "  INDEX idx_audit_user_time (user_id, created_at),"
    "  INDEX idx_audit_res_time  (resource_id, created_at)"
    ") CHARACTER SET utf8mb4"
)

_DDL_SESSIONS = (
    "CREATE TABLE sessions ("
    "  user_id           VARCHAR(64)  NOT NULL,"
    "  last_case_id      VARCHAR(12)  NOT NULL DEFAULT '',"
    "  pairs_written     INT          NOT NULL DEFAULT 0,"
    "  pairs_train       INT          NOT NULL DEFAULT 0,"
    "  pairs_holdout     INT          NOT NULL DEFAULT 0,"
    "  skipped           INT          NOT NULL DEFAULT 0,"
    "  flagged           INT          NOT NULL DEFAULT 0,"
    "  completed_cases   LONGTEXT,"
    "  layout_preset     VARCHAR(32)  DEFAULT 'wide',"
    "  review_mode       VARCHAR(32)  DEFAULT 'staged',"
    "  session_start     VARCHAR(64),"
    "  last_updated      VARCHAR(64),"
    "  PRIMARY KEY (user_id)"
    ") CHARACTER SET utf8mb4"
)

_DDL_QUEUE_INFLIGHT = (
    "CREATE TABLE queue_inflight ("
    "  case_id     VARCHAR(12) NOT NULL,"
    "  user_id     VARCHAR(64),"
    "  claimed_at  DATETIME DEFAULT CURRENT_TIMESTAMP,"
    "  PRIMARY KEY (case_id)"
    ") CHARACTER SET utf8mb4"
)

_DDL_PAIRS = (
    "CREATE TABLE pairs ("
    "  pair_id             VARCHAR(64) NOT NULL,"
    "  user_id             VARCHAR(64) NOT NULL,"
    "  case_id             VARCHAR(12) NOT NULL,"
    "  pair_index          INT         NOT NULL DEFAULT 0,"
    "  dataset_split       VARCHAR(16) NOT NULL,"
    "  vertical            VARCHAR(64),"
    "  inversion_type      VARCHAR(64),"
    "  data_classification VARCHAR(32) DEFAULT 'general',"
    "  ferpa_blocked       TINYINT(1)  NOT NULL DEFAULT 0,"
    "  pii_scrubbed        TINYINT(1)  NOT NULL DEFAULT 0,"
    "  payload             LONGTEXT,"
    # v1.9.0 forward-compat columns (populated by v1.12.0)
    "  reviewed_by         VARCHAR(64) NULL,"
    "  reviewed_at         DATETIME    NULL,"
    "  review_status       VARCHAR(16) NULL,"
    "  version             INT         NOT NULL DEFAULT 1,"
    "  supersedes          VARCHAR(64) NULL,"
    "  superseded_by       VARCHAR(64) NULL,"
    "  created_at          DATETIME    DEFAULT CURRENT_TIMESTAMP,"
    "  PRIMARY KEY (pair_id),"
    "  INDEX idx_pairs_user  (user_id),"
    "  INDEX idx_pairs_case  (case_id),"
    "  INDEX idx_pairs_split (dataset_split),"
    "  INDEX idx_pairs_review (review_status)"
    ") CHARACTER SET utf8mb4"
)

_DDL_SKIPS = (
    "CREATE TABLE skips ("
    "  skip_id      VARCHAR(64)  NOT NULL,"
    "  user_id      VARCHAR(64)  NOT NULL,"
    "  case_id      VARCHAR(12)  NOT NULL,"
    "  reason_code  VARCHAR(64),"
    "  reason_label VARCHAR(128),"
    "  cva_notes    TEXT,"
    "  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,"
    "  PRIMARY KEY (skip_id),"
    "  INDEX idx_skips_user (user_id),"
    "  INDEX idx_skips_case (case_id)"
    ") CHARACTER SET utf8mb4"
)

_DDL_FLAGS = (
    "CREATE TABLE flags ("
    "  flag_id      VARCHAR(64) NOT NULL,"
    "  user_id      VARCHAR(64) NOT NULL,"
    "  case_id      VARCHAR(12) NOT NULL,"
    "  flag_type    VARCHAR(64),"
    "  cva_notes    TEXT,"
    # v1.9.0 forward-compat columns (populated by v1.11.0 & v1.12.0)
    "  pair_id      VARCHAR(64) NULL,"      # v1.11.0 peer_review_on_pair linkage
    "  resolved_by  VARCHAR(64) NULL,"
    "  resolved_at  DATETIME    NULL,"
    "  resolution   VARCHAR(32) NULL,"
    "  created_at   DATETIME    DEFAULT CURRENT_TIMESTAMP,"
    "  PRIMARY KEY (flag_id),"
    "  INDEX idx_flags_user (user_id),"
    "  INDEX idx_flags_case (case_id),"
    "  INDEX idx_flags_pair (pair_id),"
    "  INDEX idx_flags_resolution (resolution)"
    ") CHARACTER SET utf8mb4"
)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def run_if_needed(db_config: dict[str, Any]) -> None:
    """
    Apply the v1.9.0 migration if it has not already been applied.

    Args:
        db_config: kwargs for pymysql.connect() — same dict used elsewhere
                   in api/main.py as _DB_CONFIG.
    """
    conn = pymysql.connect(**db_config)
    try:
        with conn.cursor() as cur:
            _ensure_schema_meta(cur)
            if _is_applied(cur, SCHEMA_VERSION):
                print(f"[migrate_v190] schema_meta has {SCHEMA_VERSION} — no-op.")
                return

            print(f"[migrate_v190] Applying schema version {SCHEMA_VERSION}...")

            _ensure_audit_logs(cur)
            _drop_and_recreate_v190_tables(cur)

            # Mark applied inside the same txn so we don't re-run if the
            # corpus rewrite below partially fails.
            cur.execute(
                "INSERT INTO schema_meta (version, description) VALUES (%s, %s)",
                (SCHEMA_VERSION, "Case ID rename, audit to MySQL, review/version cols"),
            )

        conn.commit()
        print("[migrate_v190] DB schema applied.")
    finally:
        conn.close()

    # Corpus rewrite is a filesystem operation and has its own idempotency
    # check (file's first case already has case_id). Done after DB commit
    # so a half-applied schema + rewritten corpus state is impossible.
    _rewrite_corpus_if_needed()

    print(f"[migrate_v190] v{SCHEMA_VERSION} migration complete.")


# ---------------------------------------------------------------------------
# Schema-meta helpers
# ---------------------------------------------------------------------------

def _ensure_schema_meta(cur) -> None:
    cur.execute(_DDL_SCHEMA_META)


def _is_applied(cur, version: str) -> bool:
    cur.execute("SELECT 1 FROM schema_meta WHERE version = %s", (version,))
    return cur.fetchone() is not None


def _ensure_audit_logs(cur) -> None:
    cur.execute(_DDL_AUDIT_LOGS)


# ---------------------------------------------------------------------------
# Case-related table drop + recreate
# ---------------------------------------------------------------------------

def _drop_and_recreate_v190_tables(cur) -> None:
    """
    Drop the four case-related tables and recreate them with the v1.9.0
    schema. Peter confirmed existing test data can be wiped. `users` is
    not touched. `sessions` is dropped because its `last_case_number INT`
    column becomes `last_case_id VARCHAR(12)`.

    Note that drop-and-recreate is explicitly ordered to avoid any
    lingering FK surprises if FKs are added later.
    """
    for tbl in ("pairs", "skips", "flags", "queue_inflight", "sessions"):
        cur.execute(f"DROP TABLE IF EXISTS {tbl}")
        print(f"[migrate_v190]   dropped {tbl} (if existed)")

    for name, ddl in [
        ("sessions",       _DDL_SESSIONS),
        ("queue_inflight", _DDL_QUEUE_INFLIGHT),
        ("pairs",          _DDL_PAIRS),
        ("skips",          _DDL_SKIPS),
        ("flags",          _DDL_FLAGS),
    ]:
        cur.execute(ddl)
        print(f"[migrate_v190]   created {name}")


# ---------------------------------------------------------------------------
# Corpus rewrite
# ---------------------------------------------------------------------------

def _rewrite_corpus_if_needed() -> None:
    """
    Rewrite every *.jsonl file under data/corpus/ to use case_id
    (format YYMMDD-NNNNN, seed date = 260314) instead of case_number.

    Idempotent: if the first JSONL file's first line already has a
    `case_id` field, skip the rewrite.

    Backup: before any rewrite, copy data/corpus/ to data/corpus_v1.8/
    (but only if the backup does not already exist, so re-runs don't
    overwrite the original backup).
    """
    if not _CORPUS_DIR.exists():
        print(f"[migrate_v190] WARNING: corpus dir not found at {_CORPUS_DIR}")
        return

    files = sorted(_CORPUS_DIR.glob("*.jsonl"))
    if not files:
        print(f"[migrate_v190] WARNING: no *.jsonl files under {_CORPUS_DIR}")
        return

    # Idempotency probe: first line of first file
    with files[0].open("r", encoding="utf-8") as fh:
        first = fh.readline()
    try:
        probe = json.loads(first)
    except json.JSONDecodeError as exc:
        print(f"[migrate_v190] ERROR: corpus probe JSON decode failed: {exc}")
        return

    if "case_id" in probe and "case_number" not in probe:
        print("[migrate_v190] corpus already rewritten (case_id present) — skipping.")
        return

    # Back up the original corpus directory once
    if _CORPUS_BACKUP_DIR.exists():
        print(
            f"[migrate_v190] backup already at {_CORPUS_BACKUP_DIR} — "
            "not overwriting; proceeding with rewrite."
        )
    else:
        shutil.copytree(_CORPUS_DIR, _CORPUS_BACKUP_DIR)
        print(f"[migrate_v190] backed up corpus to {_CORPUS_BACKUP_DIR}")

    rewritten = 0
    for path in files:
        lines_out: list[str] = []
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                raw = raw.rstrip("\n")
                if not raw.strip():
                    continue
                rec = json.loads(raw)
                n = rec.pop("case_number", None)
                if n is None:
                    # Already transformed mid-file? Preserve as-is.
                    lines_out.append(json.dumps(rec, ensure_ascii=False))
                    continue
                case_id = f"{SEED_DATE}-{int(n):05d}"
                # Put case_id first for readability, preserve other fields
                new_rec = {"case_id": case_id, **rec}
                lines_out.append(json.dumps(new_rec, ensure_ascii=False))
                rewritten += 1
        with path.open("w", encoding="utf-8") as fh:
            fh.write("\n".join(lines_out) + "\n")

    print(
        f"[migrate_v190] rewrote {rewritten} case record(s) across "
        f"{len(files)} file(s)."
    )


# ---------------------------------------------------------------------------
# CLI entry for manual runs / dry testing (scratch DB)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Standalone run (only useful when MYSQL* env vars are set locally).
    import os

    cfg = {
        "host":     os.environ.get("MYSQLHOST", "localhost"),
        "port":     int(os.environ.get("MYSQLPORT", "3306")),
        "user":     os.environ.get("MYSQLUSER", "root"),
        "password": os.environ.get("MYSQLPASSWORD", ""),
        "database": os.environ.get("MYSQLDATABASE", "railway"),
        "charset":  "utf8mb4",
        "cursorclass": pymysql.cursors.DictCursor,
        "autocommit": False,
    }
    run_if_needed(cfg)
