# CVA Tool — Session Handoff
**Handoff date:** 2026-04-22  
**From version:** v1.8.0 (deployed, tested, confirmed)  
**Next phase:** v1.9.0 — Flag Review Mode + Pill Navigation

---

## Starting Prompt (paste this to open the next session)

> I'm continuing work on the IVAI CVA Tool, an Electron desktop app backed by a FastAPI service deployed on Railway. We just shipped v1.8.0 (MySQL migration) and everything is working. The next phase is **v1.9.0**: Flag Review Mode and "1 Flagged" / "1 Skipped" pill navigation.
>
> The project is at `C:\Users\peter\Documents\IVAI\Cowork\ivai-cva-tool`. The full context is in the handoff document at that same folder — `handoff-v1.8.0-to-v1.9.0.md` — please read it before we start.

---

## Current State

### What's Working (v1.8.0)
- Full MySQL migration complete — all mutable data off Railway's ephemeral filesystem
- Railway MySQL plugin provisioned in the `IVAI CVA` project (private network, auto-injected credentials)
- 6 DB tables created at startup: `users`, `sessions`, `queue_inflight`, `pairs`, `skips`, `flags`
- `peter_d` seeded from `config/users.json` on first startup
- All endpoints reading/writing DB: `/auth/login`, `/session`, `/queue/next`, `/queue/release`, `/pairs`, `/skips`, `/flags`
- "Previously Flagged for Review" indicator (red) shows correctly on case load — reads from `flags` table
- End-to-end tested: pair written (case 1), skip written (case 2), flag written (case 3) — all confirmed in Railway DB viewer

### git log (recent)
```
53d18d7  v1.8.0 — trigger redeploy (env vars now wired)
c0534a0  v1.8.0 — MySQL migration: all mutable storage moved to Railway DB
059e4f6  v1.7.2 — dynamic user ID from JWT + wire checkAuth() on all IPC results
46f62e8  v1.7.1 — bump login.html footer to v1.7.1
bbf628d  v1.7.1 — bump package.json and config popup to v1.7.1
```

Note: `53d18d7` is an empty commit used to trigger Railway redeploy after MySQL env vars were wired. `c0534a0` is the actual v1.8.0 code.

---

## Architecture

```
[Electron app]  <--IPC-->  [main.js]  <--HTTPS-->  [Railway FastAPI]  <--PyMySQL-->  [Railway MySQL]
  renderer.js               (Bearer JWT)              api/main.py                      same project
  preload.js                                          Dockerfile                       private network
  login.html                                          api/requirements.txt             auto-injected creds
```

### Key File Locations
| File | Purpose |
|------|---------|
| `main.js` | Electron main process; all IPC handlers; stores JWT in memory |
| `renderer/renderer.js` | Renderer logic; CURRENT_USER_ID dynamic from JWT |
| `renderer/preload.js` | contextBridge; exposes `window.electronAPI` |
| `renderer/login.html` | Frameless login window |
| `api/main.py` | FastAPI backend; all endpoints; DB helpers |
| `api/requirements.txt` | **Dockerfile installs THIS, not root requirements.txt** |
| `config/users.json` | Seed source for `users` table (read once at startup if table empty) |
| `config/api_keys.json` | API keys (never committed) |

### API Endpoints
```
POST /auth/login          -- returns JWT access_token (reads users table)
GET  /auth/me             -- validate token, return user info
GET  /health              -- liveness check
GET  /corpus              -- full 3200-case corpus (loads from data/corpus/*.jsonl)
GET  /session/{user_id}   -- read session state (sessions table)
POST /session/{user_id}   -- write session state (sessions table, UPSERT)
GET  /queue/next          -- next unworked case (checks pairs+skips, inserts queue_inflight)
POST /queue/release/{n}   -- release in-flight case (deletes from queue_inflight)
POST /pairs               -- write DPO pair (inserts into pairs table)
POST /skips               -- write skip record (inserts into skips table)
POST /flags               -- write flag record (inserts into flags table)
POST /review              -- Cortex review analysis (Together AI)
```

### Database Schema (Railway MySQL plugin)
```sql
users          -- user_id, display_name, role, password_hash, created_at
sessions       -- user_id (PK), last_case_number, pairs_written, pairs_train,
                  pairs_holdout, skipped, flagged, completed_cases (JSON),
                  layout_preset, review_mode, session_start, last_updated
queue_inflight -- case_number (PK), user_id, claimed_at
pairs          -- pair_id, user_id, case_number, pair_index, dataset_split,
                  vertical, inversion_type, data_classification, ferpa_blocked,
                  pii_scrubbed, payload (LONGTEXT JSON), created_at
skips          -- skip_id, user_id, case_number, reason_code, reason_label,
                  cva_notes, created_at
flags          -- flag_id, user_id, case_number, flag_type, cva_notes, created_at
```

### Railway Environment Variables (FastAPI service)
| Variable | Source |
|----------|--------|
| `JWT_SECRET` | Set manually in Railway |
| `PORT` | Set manually (8080) |
| `TOGETHER_API_KEY` | Set manually in Railway |
| `MYSQLHOST` | `${{MySQL.MYSQLHOST}}` — reference variable |
| `MYSQLPORT` | `${{MySQL.MYSQLPORT}}` — reference variable |
| `MYSQLUSER` | `${{MySQL.MYSQLUSER}}` — reference variable |
| `MYSQLPASSWORD` | `${{MySQL.MYSQLPASSWORD}}` — reference variable |
| `MYSQLDATABASE` | `${{MySQL.MYSQLDATABASE}}` — reference variable |

**Important:** Railway does NOT auto-inject MySQL vars into other services. They must be added as reference variables manually (done — already wired).

---

## v1.9.0 Feature Plan

### Feature 1: "1 Flagged" / "1 Skipped" Pill Navigation
**Current behavior:** The sidebar pills ("1 Flagged", "2 Skipped", etc.) are display-only counters. Clicking them does nothing.

**Desired behavior:** Clicking a pill opens a review panel or navigates to a list of your flagged/skipped cases, allowing you to jump directly to any of them.

**Implementation sketch:**
- Add click handlers to the pill elements in `renderer/renderer.js`
- On click, call a new IPC handler (e.g., `get-flagged-cases` / `get-skipped-cases`)
- New FastAPI endpoints: `GET /flags?user_id=X` and `GET /skips?user_id=X` returning case lists
- Show a modal or sidebar drawer with the list; clicking a case number loads that case

### Feature 2: Flag Review Mode (from v1.9.0 roadmap)
A reviewer queue for flagged cases. CVA annotators flag cases; a reviewer (senior_review role) sees a queue of flagged cases with Cortex analysis pre-loaded.

**Implementation sketch:**
- New endpoint: `GET /review-queue` — returns flagged cases not yet reviewed, ordered by flag date
- New renderer mode: `review_mode = 'flag_review'` shows flagged case queue instead of normal queue
- Reviewer sees flag type, annotator notes, Cortex analysis
- Reviewer actions: Approve (remove flag), Escalate, Add note

---

## Pending Roadmap

| Version | Feature |
|---------|---------|
| v1.9.0 | **Pill navigation** (1 Flagged / 1 Skipped click-through) + **Flag Review Mode** |
| v1.9.x | Add Harvey as second user (generate bcrypt hash, INSERT into users table) |
| v2.0.0 | Electron packaging — electron-builder .exe installer |

### Adding Harvey (when ready)
```python
# Run in api/ dir (or anywhere passlib + bcrypt==3.2.2 installed)
from passlib.context import CryptContext
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
print(pwd.hash("harveys_chosen_password"))
```
Then insert directly via Railway's DB viewer or a seed script:
```sql
INSERT INTO users VALUES ('harvey_s', 'Harvey S', 'cva', '<hash>', NOW());
```

---

## Critical Technical Context

### bcrypt Pinning — DO NOT CHANGE
`api/requirements.txt` pins `bcrypt==3.2.2`. This is intentional and load-bearing:
- passlib 1.7.4 uses `_bcrypt.__about__.__version__` which does not exist in bcrypt >= 4.0
- bcrypt 4.x raises `ValueError: password cannot be longer than 72 bytes` which crashes `dummy_verify()`
- Never upgrade bcrypt past 3.2.2 without also upgrading passlib

### Dockerfile Source of Truth
The Dockerfile copies `api/requirements.txt`, NOT the root `requirements.txt`. The root file is a dev-only placeholder. Always update `api/requirements.txt`.

### Edit Tool Truncation on Windows Mount
The Edit tool silently truncates long files on the NTFS/SMB mount. Safe pattern:
1. Write a Python patch script to the outputs directory using the Write tool (Windows path)
2. Run via bash using the Linux mount path `/sessions/.../mnt/outputs/`
3. Verify Python files with `python3 -c "import ast; ast.parse(open('file.py').read())"`
4. Use `N = chr(33)` in scripts to avoid bash `!` history expansion
5. Use `'''` as outer string delimiter in patch scripts to avoid triple-quote collision with Python docstrings inside

### Git Commit Pattern for Windows Mount
`git add` on the NTFS mount has timestamp caching issues. Established workaround:
1. `cp -r $WDIR/.git /tmp/cvagit` (remove stale locks first: `rm -f /tmp/cvagit/index.lock`)
2. `git hash-object -w` + `git update-index --cacheinfo` for each changed file
3. `git write-tree` → `git commit-tree -p $PARENT -m "..."`
4. Write hash to `refs/heads/main`, copy new objects back (existing objects will give Permission Denied — that's OK, only new objects need copying)
5. Push from Windows terminal: `git push origin main`

### Railway MySQL Env Var Wiring
Railway does NOT auto-inject MySQL service variables into other services in the same project. You must manually add reference variables (e.g., `MYSQLHOST=${{MySQL.MYSQLHOST}}`) to the FastAPI service's Variables tab. This was done in this session and is already in place.

### JWT Architecture
- Token in Electron main process memory only (`_accessToken` in `main.js`)
- All API calls: `Authorization: Bearer <token>`
- Payload: `{ sub: user_id, name: display_name, role: role, exp: expiry }`
- 8-hour expiry; `JWT_SECRET` from Railway env var

### PyMySQL Pattern
New connection per call (`_exec` / `_run` helpers). Safe for FastAPI's low-concurrency async model. Do not switch to a connection pool without testing carefully.

---

## SemVer Reminder
- **Patch (Z):** bug fixes, no new features
- **Minor (Y):** new user-facing features, backward compatible
- **Major (X):** breaking changes

Before every commit: state "This is a [Patch/Minor/Major] bump — incrementing to X.Y.Z", then update `package.json`, `renderer/index.html` (config popup), and `renderer/login.html`.

---

*Written 2026-04-22 after v1.8.0 deployment and end-to-end test confirmation.*
