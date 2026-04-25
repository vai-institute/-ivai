# CVA Tool — Session Handoff
**Handoff date:** 2026-04-13  
**From version:** v1.7.2 (deployed, tested, pushed)  
**Next phase:** v1.8.0 — MySQL Migration

---

## Starting Prompt (paste this to open the next session)

> I'm continuing work on the IVAI CVA Tool, an Electron desktop app backed by a FastAPI service deployed on Railway. We just shipped v1.7.2 and everything is working. The next phase is **v1.8.0 — MySQL migration**: moving all data storage from Railway's ephemeral filesystem to a Railway MySQL plugin (same project, private network, auto-injected credentials).
>
> The project is at `C:\Users\peter\Documents\IVAI\Cowork\ivai-cva-tool`. The full context is in the handoff document at that same folder — `handoff-v1.7.2-to-v1.8.0-mysql.md` — please read it before we start.

---

## Current State

### What's Working (v1.7.2)
- JWT authentication end-to-end: login window → POST /auth/login → Bearer token → main window
- `CURRENT_USER_ID` is now dynamic — fetched from JWT at DOMContentLoaded (no more hardcoded `peter_d`)
- Session expiry wiring: all 8 authenticated IPC handlers return `{ success: false, status: 401 }` on token expiry; renderer has `checkAuth()` guards in 10 places that show the "Session Expired" overlay
- `peter_d` user in `config/users.json` with bcrypt hash of `ivai2026`
- Railway auto-deploys on every push to `main` branch of `https://github.com/vai-institute/-ivai.git`

### git log (recent)
```
059e4f6  v1.7.2 — dynamic user ID from JWT + wire checkAuth() on all IPC results
46f62e8  v1.7.1 — bump login.html footer to v1.7.1
bbf628d  v1.7.1 — bump package.json and config popup to v1.7.1
79d8556  v1.7.1 — Fix: declare _accessToken; apiHeaders() sends Bearer token
245870e  v1.7.1 — Fix: restore truncated tail of api/main.py
fe1d096  v1.7.1 — Fix: pin bcrypt==3.2.2 for passlib compat
```

---

## Architecture

```
[Electron app]  <--IPC-->  [main.js]  <--HTTPS-->  [Railway FastAPI]
  renderer.js               (Bearer JWT)              api/main.py
  preload.js                                          Dockerfile
  login.html                                          api/requirements.txt
```

### Key File Locations
| File | Purpose |
|------|---------|
| `main.js` | Electron main process; all IPC handlers; stores JWT in memory |
| `renderer/renderer.js` | Renderer logic; uses CURRENT_USER_ID (now dynamic) |
| `renderer/preload.js` | contextBridge; exposes `window.electronAPI` |
| `renderer/login.html` | Frameless login window |
| `api/main.py` | FastAPI backend (1163 lines); all endpoints |
| `api/requirements.txt` | **Dockerfile installs THIS, not root requirements.txt** |
| `config/users.json` | User store with bcrypt hashes |
| `config/api_keys.json` | API keys (never committed) |

### API Endpoints
```
POST /auth/login          -- returns JWT access_token
GET  /auth/me             -- validate token, return user info
GET  /health              -- liveness check
GET  /corpus              -- full 3200-case corpus (loads from data/corpus/*.jsonl)
GET  /session/{user_id}   -- read session state (from session/{user_id}.json)
POST /session/{user_id}   -- write session state
GET  /queue/next          -- next unworked case for user
POST /queue/release/{n}   -- release in-flight case
POST /pairs               -- write DPO pair (appends to output/arlaf_training_data.jsonl)
POST /skips               -- write skip record (appends to output/skipped_cases.jsonl)
POST /flags               -- write flag record (appends to output/flagged_cases.jsonl)
POST /review              -- Cortex review analysis (Together AI)
```

### Current Data Storage (ALL ON RAILWAY EPHEMERAL FS -- must migrate)
```
data/corpus/*.jsonl               -- source corpus (read-only, OK to stay as files)
output/arlaf_training_data.jsonl  -- DPO training pairs  (MUST migrate to DB)
output/arlaf_holdout_data.jsonl   -- holdout pairs       (MUST migrate to DB)
output/skipped_cases.jsonl        -- skip records        (MUST migrate to DB)
output/flagged_cases.jsonl        -- flagged cases       (MUST migrate to DB)
session/{user_id}.json            -- per-user session    (MUST migrate to DB)
config/users.json                 -- user store          (MUST migrate to DB)
```

---

## v1.8.0 MySQL Migration Plan

### Goal
Move all mutable data off Railway's ephemeral filesystem to Peter's MySQL database
on `vai-institute.com`. The corpus (`data/corpus/*.jsonl`) is read-only and can stay
as files.

### Target Database
- **Host:** Railway MySQL plugin — provisioned inside the existing `ivai-production` Railway project
- **Engine:** MySQL 8.0 (Railway managed)
- **Credentials:** Railway auto-injects `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE` as env vars — no manual credential management
- **Network:** same private Railway network as the FastAPI container — no public internet exposure, no SSL required
- **Decision rationale:** keeps IVAI completely separate from Axiogenics/Liquid Web infrastructure; managed backups; one-click provisioning

### Before Starting the Coding Session — One Manual Step Required
Peter must provision the MySQL plugin in Railway before the session:
1. Go to https://railway.app/dashboard → open the `ivai-production` project
2. Click **+ New** → **Database** → **MySQL**
3. Railway creates the DB and injects credentials automatically — nothing else to configure
4. Optionally open the MySQL plugin's **Data** tab to verify it's running

### Proposed Schema

```sql
-- Users (replaces config/users.json)
CREATE TABLE users (
  user_id       VARCHAR(64)  PRIMARY KEY,
  display_name  VARCHAR(128) NOT NULL,
  role          VARCHAR(32)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Per-user session state (replaces session/{user_id}.json)
CREATE TABLE sessions (
  user_id           VARCHAR(64) PRIMARY KEY,
  last_case_number  INT  DEFAULT 1,
  pairs_written     INT  DEFAULT 0,
  pairs_train       INT  DEFAULT 0,
  pairs_holdout     INT  DEFAULT 0,
  skipped           INT  DEFAULT 0,
  flagged           INT  DEFAULT 0,
  completed_cases   JSON,
  layout_preset     VARCHAR(32) DEFAULT 'wide',
  review_mode       VARCHAR(32) DEFAULT 'staged',
  session_start     DATETIME,
  last_updated      DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- In-flight queue tracking (replaces in-memory set)
CREATE TABLE queue_inflight (
  case_number  INT PRIMARY KEY,
  user_id      VARCHAR(64),
  claimed_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id)
);

-- DPO pairs (replaces arlaf_training_data.jsonl + arlaf_holdout_data.jsonl)
CREATE TABLE pairs (
  pair_id         VARCHAR(64) PRIMARY KEY,
  user_id         VARCHAR(64) NOT NULL,
  case_number     INT         NOT NULL,
  pair_index      INT         DEFAULT 0,
  dataset_split   VARCHAR(16) NOT NULL,
  prompt          TEXT,
  chosen          TEXT,
  rejected        TEXT,
  vertical        VARCHAR(64),
  inversion_type  VARCHAR(64),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id),
  INDEX idx_case (case_number)
);

-- Skips (replaces skipped_cases.jsonl)
CREATE TABLE skips (
  skip_id      VARCHAR(64) PRIMARY KEY,
  user_id      VARCHAR(64) NOT NULL,
  case_number  INT         NOT NULL,
  reason_code  VARCHAR(64),
  reason_label VARCHAR(128),
  cva_notes    TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id)
);

-- Flags (replaces flagged_cases.jsonl)
CREATE TABLE flags (
  flag_id      VARCHAR(64) PRIMARY KEY,
  user_id      VARCHAR(64) NOT NULL,
  case_number  INT         NOT NULL,
  flag_type    VARCHAR(64),
  cva_notes    TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user (user_id)
);
```

### Python Dependency to Add (api/requirements.txt only)
```
PyMySQL==1.1.1
```
Pure Python MySQL driver -- no compiled C extensions, works on Railway out of the box.
Do NOT use `mysqlclient` (requires system libs) or `aiomysql` (unnecessary complexity).

### Environment Variables
Railway auto-injects these when the MySQL plugin is in the same project — no manual setup needed:
```
MYSQLHOST      (Railway private network hostname)
MYSQLPORT      (typically 3306)
MYSQLUSER
MYSQLPASSWORD
MYSQLDATABASE
```
The one env var to set manually (keep existing value, do not regenerate):
```
JWT_SECRET=<existing value from Railway dashboard>
```

### Migration Sequence (recommended order)
1. Peter: provision Railway MySQL plugin (one manual step — see above)
2. Peter: confirm Harvey's user_id and desired password
3. Agent: add `PyMySQL==1.1.1` to `api/requirements.txt`
4. Agent: add `_get_db()` connection helper to `api/main.py` reading Railway's injected env vars
5. Agent: run CREATE TABLE statements via the connection at startup (auto-migrate pattern — no manual phpMyAdmin needed)
6. Agent: migrate endpoints one at a time, test each before moving to next:
   a. `/auth/login` -- read from `users` table instead of `users.json`
   b. `/session/{user_id}` GET + POST -- read/write `sessions` table
   c. `/queue/next` + `/queue/release` -- use `queue_inflight` table
   d. `/pairs` POST -- insert into `pairs` table
   e. `/skips` POST -- insert into `skips` table
   f. `/flags` POST -- insert into `flags` table
7. Seed `users` table at first startup: peter_d (hash from users.json) + Harvey (generate new hash)
8. Push → Railway redeploys → smoke test all endpoints

### Generating Harvey's bcrypt hash
```python
from passlib.context import CryptContext
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
print(pwd.hash("harveys_chosen_password"))
```
Run this in the api/ directory (or anywhere passlib + bcrypt==3.2.2 are installed).

---

## Critical Technical Context

### bcrypt Pinning -- DO NOT CHANGE
`api/requirements.txt` pins `bcrypt==3.2.2`. This is intentional and load-bearing:
- passlib 1.7.4 uses `_bcrypt.__about__.__version__` which does not exist in bcrypt >= 4.0
- bcrypt 4.x raises `ValueError: password cannot be longer than 72 bytes` which crashes `dummy_verify()`
- Never upgrade bcrypt past 3.2.2 without also upgrading passlib

### Dockerfile Source of Truth
The Dockerfile copies `api/requirements.txt`, NOT the root `requirements.txt`.
The root file is a dev-only placeholder. Always update `api/requirements.txt`.

### Edit Tool Truncation on Windows Mount
The Edit tool silently truncates long files on the NTFS/SMB mount. Safe pattern:
1. Write a Python patch script to the outputs directory using the Write tool (Windows path)
2. Run via bash using the Linux mount path `/sessions/bold-relaxed-pascal/mnt/outputs/`
3. Verify Python files with `python3 -c "import ast; ast.parse(open('file.py').read())"`
4. Use `N = chr(33)` in scripts to avoid bash `!` history expansion

### Git Commit Pattern for Windows Mount
`git add` on the NTFS mount has timestamp caching issues. Established workaround:
1. `cp -r $WDIR/.git /tmp/cvagit` (remove stale locks first if any)
2. `git hash-object -w` + `git update-index --cacheinfo` for each changed file
3. `git write-tree` then `git commit-tree -p $PARENT -m "..."` 
4. Write hash to `refs/heads/main`, copy objects + index back, push from Windows terminal

### JWT Architecture
- Token in Electron main process memory only (`_accessToken` in `main.js`)
- All API calls: `Authorization: Bearer <token>`
- Payload: `{ sub: user_id, name: display_name, role: role, exp: expiry }`
- 8-hour expiry; `JWT_SECRET` from Railway env var

---

## Pending Roadmap

| Version | Feature |
|---------|---------|
| v1.8.0 | **MySQL migration** -- next session |
| v1.9.0 | Flag Review Mode -- reviewer queue with Cortex analysis |
| v2.0.0 | Electron packaging -- electron-builder .exe installer |

---

## SemVer Reminder
- **Patch (Z):** bug fixes, no new features
- **Minor (Y):** new user-facing features, backward compatible
- **Major (X):** breaking changes

Before every commit: state "This is a [Patch/Minor/Major] bump -- incrementing to X.Y.Z",
then update `package.json`, `renderer/index.html` (config popup), and `renderer/login.html`.

---

*Written 2026-04-21 after v1.7.2 push and test confirmation. DB target updated from vai-institute.com to Railway MySQL plugin.*
