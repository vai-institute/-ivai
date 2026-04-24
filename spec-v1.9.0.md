# CVA Tool — v1.9.0 Spec: Schema Foundation

**Status:** ready for implementation
**Written:** 2026-04-24
**Previous version:** v1.8.1 (API_BASE fix to `cva.vai-institute.com`)
**Theme:** pure data-layer refactor. Prepares the schema for v1.10.0 (Pill Navigation), v1.11.0 (Flag Workflow), and v1.12.0 (Flag Review Mode) without shipping any new UX.

---

## Guiding Principle

Do all database changes first, as a dedicated release. Build functionality on top of a stable, versioned schema in subsequent releases. v1.9.0 ships *no new CVA-visible features* — only the side-effects of the data-layer refactor.

### What a CVA will notice after v1.9.0

- "Case #1" now displays as "Case 260314-00001"
- The Resume / Start Fresh dialog no longer appears on launch — app auto-resumes
- Counts in the topbar pills are always accurate (derived, not cached)

### What a CVA will NOT see yet

- Pill Navigation (v1.10.0)
- New flag types, confirm-flag modal, defaults (v1.11.0)
- Flag Review Mode, role-aware action buttons (v1.12.0)

---

## Version Roadmap

| Version | Theme |
|---------|-------|
| **v1.9.0** | **Schema Foundation** (this release) |
| v1.10.0 | Pill Navigation — 4-mode pills (Raw / Pairs / Skipped / Flagged), Prev/Next/Jump within mode |
| v1.11.0 | Flag Workflow — peer_review_on_pair flag type, confirm modal, default reasons |
| v1.12.0 | Flag Review Mode — senior reviewer role, review actions, pair versioning in use |

Bug-fix reserves: v1.9.x, v1.10.x, etc.

---

## Changes in v1.9.0

### 1. Case ID Migration

**Format:** `YYMMDD-NNNNN`, stored as `VARCHAR(12)`.

- `YY` = two-digit year
- `MM` = zero-padded month
- `DD` = zero-padded day
- `NNNNN` = zero-padded sequence within that day (99,999 max/day)
- No prefix
- Lexicographic sort = chronological + sequence sort

**Example:** `260424-00004` = April 24, 2026, 4th case of that day.

**Seed batch:** all 3200 existing cases get `260314-00001` through `260314-03200` (March 14, 2026 — original corpus build date).

**Pair references** (display-only, derived from stored columns, NOT stored):

```
260314-00102.2      <- case_id + "." + pair_index
260314-00102.2v1    <- case_id + "." + pair_index + "v" + version (when relevant)
```

`case_id` always identifies a case. Pair identity is composite: `case_id` + `pair_index` + `version` live in separate columns; `pair_id` (UUID) remains the DB primary key.

### 2. Schema Changes

#### A. Rename across existing tables

```sql
ALTER TABLE pairs          CHANGE case_number case_id VARCHAR(12) NOT NULL;
ALTER TABLE skips          CHANGE case_number case_id VARCHAR(12) NOT NULL;
ALTER TABLE flags          CHANGE case_number case_id VARCHAR(12) NOT NULL;
ALTER TABLE queue_inflight CHANGE case_number case_id VARCHAR(12) NOT NULL;
```

Because the existing test data does not need to be preserved (Peter confirmed), the migration script drops and recreates these four tables rather than ALTERing, to avoid integer-to-string coercion complexity.

#### B. New columns prepared for future releases (all NULL-safe)

```sql
-- pairs: review lifecycle + versioning (populated by v1.12.0)
ALTER TABLE pairs ADD COLUMN reviewed_by    VARCHAR(64) NULL;
ALTER TABLE pairs ADD COLUMN reviewed_at    DATETIME    NULL;
ALTER TABLE pairs ADD COLUMN review_status  VARCHAR(16) NULL;  -- pending, approved, escalated, rejected
ALTER TABLE pairs ADD COLUMN version        INT         NOT NULL DEFAULT 1;
ALTER TABLE pairs ADD COLUMN supersedes     VARCHAR(36) NULL;  -- pair_id of older version
ALTER TABLE pairs ADD COLUMN superseded_by  VARCHAR(36) NULL;  -- pair_id of newer version

-- flags: peer-review linkage + resolution (populated by v1.11.0 & v1.12.0)
ALTER TABLE flags ADD COLUMN pair_id        VARCHAR(36) NULL;  -- link to the pair being peer-reviewed (v1.11.0)
ALTER TABLE flags ADD COLUMN resolved_by    VARCHAR(64) NULL;
ALTER TABLE flags ADD COLUMN resolved_at    DATETIME    NULL;
ALTER TABLE flags ADD COLUMN resolution     VARCHAR(32) NULL;  -- approved_as_pair, approved_as_skip, escalated, dismissed
```

All inert in v1.9.0; no endpoint touches them yet.

#### C. New `audit_logs` table (moves from file to MySQL)

Fixes a durability flaw: `_write_audit()` currently writes to `audit_log.jsonl` on Railway's ephemeral filesystem, which may be wiped on redeploy. The code's SOC 2 CC7 claim is undermined by file-based storage.

```sql
CREATE TABLE audit_logs (
  audit_id       VARCHAR(36) PRIMARY KEY,
  user_id        VARCHAR(64) NOT NULL,
  action         VARCHAR(64) NOT NULL,   -- login, pair_written, skip_recorded, flag_recorded, session_updated, case_assigned, corpus_fetched...
  resource_type  VARCHAR(32) NOT NULL,   -- pair, skip, flag, session, case, corpus
  resource_id    VARCHAR(64) NOT NULL,   -- case_id or pair_id or flag_id or user_id
  before_state   LONGTEXT NULL,          -- JSON snapshot before the action
  after_state    LONGTEXT NULL,          -- JSON snapshot after the action
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_resource   (resource_type, resource_id),
  INDEX idx_user_time  (user_id, created_at),
  INDEX idx_case_time  (resource_id, created_at)
);
```

Append-only (never UPDATE, never DELETE). Every write endpoint still calls `_write_audit()`; the implementation swaps file-append for DB-insert. Old `audit_log.jsonl` file left in place (not deleted) for historical reference.

#### D. New `schema_meta` table (migration tracking)

```sql
CREATE TABLE schema_meta (
  version     VARCHAR(8)  PRIMARY KEY,
  applied_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description VARCHAR(256)
);
```

After each successful migration script run, insert a row. Startup check: if `schema_meta` contains `'1.9.0'`, skip migration; else run it.

#### E. Indexes on `case_id` for lookup performance

```sql
ALTER TABLE pairs          ADD INDEX idx_case (case_id);
ALTER TABLE skips          ADD INDEX idx_case (case_id);
ALTER TABLE flags          ADD INDEX idx_case (case_id);
ALTER TABLE queue_inflight -- already PK on case_id after rename
```

Relevant once the data scales beyond the seed 3200, and for the v1.10.0 list endpoints.

### 3. Corpus JSONL Rewrite

Data files in `data/corpus/` use `case_number` today. Rewrite each case object:

```json
// Before
{ "case_number": 102, "prompt": "...", ... }

// After
{ "case_id": "260314-00102", "prompt": "...", ... }
```

The rewrite is a deterministic one-time transform run from the migration script. Original files backed up to `data/corpus_v1.8/` before overwrite.

### 4. Counter Truth — `GET /session` Derives Counts

The `sessions` table's counter columns (`pairs_written`, `pairs_train`, `pairs_holdout`, `skipped`, `flagged`) become vestigial. Leave them in the schema for now (to avoid touching that table this release), but change the API:

**GET `/session/{user_id}`** — compute and return derived counters:

```python
pairs_written = SELECT COUNT(*) FROM pairs WHERE user_id = X
pairs_train   = SELECT COUNT(*) FROM pairs WHERE user_id = X AND dataset_split = 'train'
pairs_holdout = SELECT COUNT(*) FROM pairs WHERE user_id = X AND dataset_split = 'holdout'
skipped       = SELECT COUNT(*) FROM skips WHERE user_id = X
flagged       = SELECT COUNT(*) FROM flags WHERE user_id = X
```

**POST `/session/{user_id}`** — ignore incoming counter fields. Persist only:

- `last_case_id` (renamed from `last_case_number`)
- `layout_preset`
- `review_mode`
- `session_start` (first-touch only)
- `last_updated`

### 5. Remove Start Fresh / Resume Dialog

With counters derived, "Start Fresh" has nothing meaningful to reset. Removing it avoids user confusion about whether it wipes pairs/skips/flags (it didn't, but the UI implied otherwise).

**Removals:**

- `renderer/index.html` — delete `<div id="resume-dialog">` block (`#btn-start-fresh`, `#btn-resume`)
- `renderer/renderer.js` — delete `showResumeDialog()` function and call paths
- `main.js` — delete `session:reset` IPC handler
- `preload.js` — delete `resetSession` bridge method

**On launch, the flow simplifies to:** fetch session → fetch next Raw case → render → done.

---

## Migration Script

**Location:** `api/migrate_v190.py`

**Invocation:** Called by `api/main.py` startup hook *before* `_ensure_corpus_loaded()`.

**Algorithm:**

```python
def run_if_needed():
    if _schema_has('1.9.0'):
        return  # already applied
    print("[migrate] Running v1.9.0 schema migration...")

    # 1. Create schema_meta if missing (bootstraps the check)
    _create_schema_meta()

    # 2. Create audit_logs if missing
    _create_audit_logs()

    # 3. Drop + recreate pairs, skips, flags, queue_inflight with case_id VARCHAR(12)
    _drop_recreate_pair_tables()

    # 4. Backfill corpus JSONL files: case_number -> case_id
    _rewrite_corpus_files(seed_date='260314')

    # 5. Mark migration applied
    _run("INSERT INTO schema_meta (version, description) VALUES ('1.9.0', 'Case ID + audit + review cols')")

    print("[migrate] v1.9.0 applied.")
```

**Idempotency:** guarded by `schema_meta` row. If the script is re-run (e.g., on redeploy), it no-ops.

**Corpus backup:** before rewriting `data/corpus/*.jsonl`, copy the directory to `data/corpus_v1.8/`. Durable rollback path if Peter reviews the migration and wants to revert.

**Testing before deploy:** the script must be runnable dry (logging-only mode) against a local MySQL first.

---

## File-Level Change Inventory

| File | Type of change | Notes |
|------|----------------|-------|
| `api/migrate_v190.py` | **NEW** | Standalone migration script, idempotent |
| `api/main.py` | Rename | `case_number` → `case_id` throughout: Pydantic models, SQL, endpoint params |
| `api/main.py` | New | `GET /session` returns derived counters; `POST /session` ignores counter fields |
| `api/main.py` | New | Startup hook calls `migrate_v190.run_if_needed()` |
| `api/main.py` | Refactor | `_write_audit()` writes to `audit_logs` table instead of `audit_log.jsonl` |
| `api/main.py` | Deletion | Remove `session:reset`-equivalent code path (no corresponding endpoint exists, but session-reset bookkeeping goes away) |
| `data/corpus/*.jsonl` | Rewrite | `case_number` → `case_id` field in every case object |
| `data/corpus_v1.8/` | **NEW** (backup) | Pre-migration corpus preserved |
| `main.js` | Rename | `case_number` → `case_id` in all URL builders, payloads, variables |
| `main.js` | Deletion | Remove `session:reset` IPC handler |
| `preload.js` | Rename | Signatures using `case_number` → `case_id` |
| `preload.js` | Deletion | Remove `resetSession` bridge |
| `renderer/renderer.js` | Rename | `case_number` / `c.case_number` → `case_id` / `c.case_id` throughout |
| `renderer/renderer.js` | Deletion | Remove `showResumeDialog()` and call sites |
| `renderer/renderer.js` | Display | "Case #N" labels → "Case 260314-NNNNN" (or just "260314-NNNNN" in compact spots) |
| `renderer/index.html` | Rename | DOM IDs containing `case-number` → `case-id`; label text updated |
| `renderer/index.html` | Deletion | Remove `#resume-dialog` markup |
| `renderer/review.js` | Rename | Any `case_number` references updated |
| `package.json` | Version | `"version": "1.9.0"` |
| `renderer/login.html` | Version | Footer bumped to `v1.9.0` |
| `renderer/index.html` | Version | Config popup footer bumped to `v1.9.0` |

---

## Testing Checklist

Before declaring v1.9.0 shipped, Peter (or Peter-with-Claude) verifies:

1. **Fresh install** (empty DB) — server boots, migration script runs, `schema_meta` records `1.9.0`, seed 3200 cases loaded, app logs in and loads a case
2. **Upgrade path** (from v1.8.1 live DB) — migration drops old tables, recreates with new schema, no errors; existing pair/skip/flag test data wiped (per design)
3. **Migration idempotency** — restart the server; migration script sees `schema_meta = 1.9.0`, no-ops. Confirm by log line and intact data
4. **Case display** — launch app, case header shows "Case 260314-00001" (or equivalent); top-bar progress reflects current case_id
5. **No resume dialog** — launch never shows Start Fresh / Resume; auto-loads next Raw case
6. **Pair-write** on a fresh DB — write a pair on `260314-00001`, verify row inserted in `pairs` table with `case_id = '260314-00001'`, `version = 1`, `review_status = NULL`
7. **Skip** on `260314-00002` — row inserted in `skips`, counters updated via derived query
8. **Flag** on `260314-00003` — row inserted in `flags` with `pair_id = NULL`, `resolved_by = NULL`
9. **Counter truth** — relaunch app, counters show `1 pair / 1 skipped / 1 flagged` without reading the session row's cached counters
10. **Audit trail** — query `audit_logs`; confirm rows for login, case_assigned, pair_written, skip_recorded, flag_recorded
11. **Audit durability** — trigger a Railway redeploy; audit_logs survive (no longer file-based)
12. **Jump to case** — "Jump #" accepts `260314-00050` and loads that case
13. **Rollback readiness** — `data/corpus_v1.8/` exists with pre-migration JSONL files

---

## SemVer Rationale

v1.9.0 = Minor bump:

- New user-visible behavior (case ID format change) — qualifies as Minor
- Backward-incompatible data shape (`case_number` → `case_id`) — would be Major if we had external API consumers, but the only consumer is our own Electron client shipped in lockstep
- Not Patch, because this is substantially more than bug fixes

**Version bump locations:**

- `package.json` — `"version": "1.9.0"`
- `renderer/index.html` — config popup footer
- `renderer/login.html` — login footer

---

## Implementation Order (suggested)

1. Write `api/migrate_v190.py` against a local MySQL; run dry + wet in a scratch DB
2. Rename `case_number` → `case_id` across `api/main.py`; verify all endpoints still compile and respond
3. Implement derived-counter `GET /session`; update `POST /session` to ignore counter fields
4. Port `_write_audit()` from file-append to `audit_logs` INSERT
5. Rename across `main.js`, `preload.js`; remove `session:reset` handler
6. Rename across `renderer/renderer.js`, `renderer/index.html`, `renderer/review.js`
7. Remove Start Fresh / Resume dialog and call paths
8. Update display labels "Case #N" → "Case 260314-NNNNN"
9. Version bumps (package.json, index.html, login.html)
10. Run testing checklist end-to-end
11. Commit + push; Railway redeploys with migration running on first boot

---

## Open Questions

None. All design decisions captured above. Ready for implementation.
