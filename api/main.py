"""
CVA Tool FastAPI Backend — main application module.

Role in VAI Architecture:
    This module is the server-side backbone of the CVA Curation Tool. It sits
    between the 3,200-case ARLAF corpus (JSONL files) and the Together AI DPO
    fine-tuning pipeline. It exposes 8 REST endpoints consumed by the Electron
    desktop app, enabling globally distributed CVA teams to work from the same
    corpus without file conflicts or race conditions.

    Layer 2 (ARLAF) integration: The /review endpoint proxies VAI Cortex
    analysis to Together AI, running Layer 1 axiological review on every
    preferred response before it enters the training stream. The /pairs
    endpoint writes validated DPO pairs in Together AI format.

    Queue safety: An in-memory lock prevents two CVAs from claiming the same
    case simultaneously. Acceptable for the current development phase; a
    database-backed queue is the migration path for production scale.

Endpoints:
    GET  /health              Health check
    GET  /corpus              Return all 3,200 corpus cases
    GET  /session/{user_id}   Get CVA session state
    POST /session/{user_id}   Update CVA session state
    GET  /queue/next          Assign next unworked case (collision-safe)
    POST /pairs               Submit a validated DPO pair
    POST /skips               Submit a skip record
    POST /flags               Submit a flag record
    POST /review              Proxy VAI Cortex review to Together AI
"""

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# App initialization
# ---------------------------------------------------------------------------

app = FastAPI(
    title="CVA Tool API",
    description="Backend API for the IVAI CVA Curation Tool",
    version="1.0.0",
)

# CORS: allow requests from the Electron app (file:// origin) and any
# future web-based CVA interface. Tighten origin list before enterprise deploy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Path configuration
# ---------------------------------------------------------------------------

# On Railway: Dockerfile places data at /data/, session at /session/,
# output at /output/ as absolute paths. Locally (development), fall back
# to paths relative to the repo root so Claude Code testing works unchanged.
_RAILWAY = Path("/data").exists() and Path("/data/corpus").exists()

if _RAILWAY:
    # Production: absolute paths set by Dockerfile RUN/COPY commands
    CORPUS_DIR = Path("/data/corpus")
    OUTPUT_DIR = Path("/output")
    SESSION_DIR = Path("/session")
else:
    # Local development: relative to repo root (two levels up from api/main.py)
    BASE_DIR = Path(__file__).parent.parent
    CORPUS_DIR = BASE_DIR / "data" / "corpus"
    OUTPUT_DIR = BASE_DIR / "output"
    SESSION_DIR = BASE_DIR / "session"

# Ensure writable directories exist on startup
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
SESSION_DIR.mkdir(parents=True, exist_ok=True)

# Output file paths — all appended to as JSONL (one record per line)
PAIRS_FILE = OUTPUT_DIR / "arlaf_training_data.jsonl"
HOLDOUT_FILE = OUTPUT_DIR / "arlaf_holdout_data.jsonl"
SKIPS_FILE = OUTPUT_DIR / "skipped_cases.jsonl"
FLAGS_FILE = OUTPUT_DIR / "flagged_cases.jsonl"

# ---------------------------------------------------------------------------
# In-memory queue lock
# ---------------------------------------------------------------------------

# Prevents two CVA sessions from claiming the same case simultaneously.
# _claimed_cases holds case_numbers currently assigned but not yet written.
# Resets on server restart — acceptable for dev phase.
_queue_lock = threading.Lock()
_claimed_cases: set[int] = set()

# ---------------------------------------------------------------------------
# Corpus cache
# ---------------------------------------------------------------------------

_corpus_cache: list[dict] = []
_corpus_loaded: bool = False


def _load_corpus() -> list[dict]:
    """
    Scan the corpus directory, parse all JSONL files, and cache the result.

    Reads all 32 batch files from data/corpus/, sorts by case_number
    ascending, and caches in module-level _corpus_cache. Subsequent calls
    return the cache without re-reading disk.

    Returns:
        List of corpus case dicts sorted by case_number ascending.

    Raises:
        RuntimeError: If corpus directory is missing or contains no JSONL files.
    """
    global _corpus_cache, _corpus_loaded

    if _corpus_loaded:
        return _corpus_cache

    if not CORPUS_DIR.exists():
        raise RuntimeError(f"Corpus directory not found: {CORPUS_DIR}")

    jsonl_files = sorted(CORPUS_DIR.glob("*.jsonl"))
    if not jsonl_files:
        raise RuntimeError(f"No JSONL files found in {CORPUS_DIR}")

    cases: list[dict] = []
    for filepath in jsonl_files:
        with open(filepath, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue  # skip blank lines between records
                try:
                    cases.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # skip malformed lines without crashing

    # Consistent ascending order for queue assignment
    cases.sort(key=lambda c: c.get("case_number", 0))

    _corpus_cache = cases
    _corpus_loaded = True
    return _corpus_cache


def _get_worked_cases(user_id: str) -> set[int]:
    """
    Return the set of case_numbers already handled by a specific CVA.

    Checks three sources:
      1. The user's session file (completed_cases list)
      2. The pairs output file (cases this user already wrote)
      3. The skips output file (cases this user already skipped)

    Flags are NOT included — a flagged case may still need a pair.

    Args:
        user_id: The CVA's user identifier string.

    Returns:
        Set of integer case_numbers this user has already worked.
    """
    worked: set[int] = set()

    # Source 1: session progress file
    session_file = SESSION_DIR / f"{user_id}_progress.json"
    if session_file.exists():
        try:
            with open(session_file, "r", encoding="utf-8") as f:
                session = json.load(f)
                worked.update(session.get("completed_cases", []))
        except (json.JSONDecodeError, KeyError):
            pass  # corrupt session file — treat as empty

    # Source 2 & 3: scan output files for this user's prior submissions
    for output_file in [PAIRS_FILE, SKIPS_FILE]:
        if not output_file.exists():
            continue
        with open(output_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    # Only count cases worked by THIS user
                    if record.get("cva_user_id") == user_id:
                        worked.add(record["case_number"])
                except (json.JSONDecodeError, KeyError):
                    continue

    return worked


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------

class SessionState(BaseModel):
    """
    CVA session state persisted by the Electron app.

    Tracks resume position, completed cases, and UI preferences.
    Written on every case navigation and on app close.
    """
    current_case_number: Optional[int] = None
    completed_cases: list[int] = []
    layout_preset: str = "wide"
    font_size: int = 14
    last_updated: Optional[str] = None


class DPOPair(BaseModel):
    """
    A validated DPO training pair submitted by the CVA after axiological review.

    The input/preferred_output/non_preferred_output fields follow Together AI
    DPO format exactly. All other fields are IVAI metadata — the upload script
    strips them to the three required fields before Together AI submission.

    Spec reference: CVA_Tool_Spec_v1_1 Section 4.3.
    """
    case_number: int
    vertical: str
    inversion_type: str
    subtlety: str
    boundary_condition: bool
    inversion_severity: str
    appropriate_intensity: str
    identity_language: bool
    cva_user_id: str
    cva_flags: dict[str, Any]
    cva_notes: str = ""
    pair_index: int = 1
    dataset_split: str = "train"  # "train" or "holdout"
    standard_slot: dict[str, Any]
    vai_slot: dict[str, Any]
    input: dict[str, Any]                        # Together AI DPO format
    preferred_output: list[dict[str, Any]]        # Together AI DPO format
    non_preferred_output: list[dict[str, Any]]    # Together AI DPO format


class SkipRecord(BaseModel):
    """
    A skip record written when the CVA cannot produce a valid pair for a case.

    Spec reference: CVA_Tool_Spec_v1_1 Section 4.4.
    """
    case_number: int
    cva_user_id: str
    reason_code: str    # standard_acceptable | ambiguous_case | duplicate_similar |
                        # no_useful_response | technical_failure
    reason_label: str
    cva_notes: str = ""


class FlagRecord(BaseModel):
    """
    A flag record written when the CVA identifies a corpus quality issue.

    Flagged cases remain in the queue — they are not counted as worked
    until a pair or skip is also submitted.
    """
    case_number: int
    cva_user_id: str
    flag_type: str
    cva_notes: str = ""


class ReviewRequest(BaseModel):
    """
    A VAI Cortex review request for a preferred response candidate.

    Sent to Together AI (Mistral 7B Cortex model) for axiological analysis.
    This is Layer 1 running in batch/review mode — not real-time inference.
    The response determines whether Write Pair is enabled or blocked.
    """
    prompt: str           # Original user prompt from the corpus case
    response: str         # The CVA's candidate preferred response
    inversion_type: str   # Known inversion type from corpus metadata
    intensity: str        # Appropriate intensity level from corpus metadata


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, str]:
    """
    Health check endpoint.

    Used by Railway to confirm the container is running and by the
    Electron app to verify API connectivity on startup.

    Returns:
        Dict with 'status': 'ok'.
    """
    return {"status": "ok"}


@app.get("/corpus")
def get_corpus() -> dict[str, Any]:
    """
    Return all corpus cases loaded from the 32 JSONL batch files.

    The corpus is loaded once on first call and served from memory
    on all subsequent calls. Cases are sorted by case_number ascending.

    Returns:
        Dict with 'cases' (list of case dicts) and 'total' (int count).

    Raises:
        HTTPException 500: If corpus directory is missing or unreadable.
    """
    try:
        cases = _load_corpus()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"cases": cases, "total": len(cases)}


@app.get("/session/{user_id}")
def get_session(user_id: str) -> dict[str, Any]:
    """
    Retrieve persisted session state for a CVA user.

    Returns default SessionState values on first launch (no file yet).

    Args:
        user_id: The CVA's user identifier (path parameter).

    Returns:
        Session state dict. All fields have defaults — never returns null.

    Raises:
        HTTPException 500: If session file exists but cannot be read.
    """
    session_file = SESSION_DIR / f"{user_id}_progress.json"

    if not session_file.exists():
        # First launch — return defaults without creating a file yet
        return SessionState().model_dump()

    try:
        with open(session_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        raise HTTPException(status_code=500, detail=f"Session read error: {e}")


@app.post("/session/{user_id}")
def update_session(user_id: str, state: SessionState) -> dict[str, str]:
    """
    Persist updated session state for a CVA user.

    Called by the Electron app on every case navigation, layout change,
    and on app close. Stamps last_updated with current UTC time.

    Args:
        user_id: The CVA's user identifier (path parameter).
        state: The updated session state from the Electron app.

    Returns:
        Confirmation dict with 'user_id' and 'updated_at' timestamp.

    Raises:
        HTTPException 500: If the session file cannot be written.
    """
    session_file = SESSION_DIR / f"{user_id}_progress.json"

    # Stamp the update time in UTC ISO format
    state.last_updated = datetime.now(timezone.utc).isoformat()

    try:
        with open(session_file, "w", encoding="utf-8") as f:
            json.dump(state.model_dump(), f, indent=2)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Session write error: {e}")

    return {"user_id": user_id, "updated_at": state.last_updated}


@app.get("/queue/next")
def get_next_case(user_id: str = Query(...)) -> dict[str, Any]:
    """
    Assign the next unworked corpus case to a CVA.

    Iterates through the corpus in ascending case_number order, skipping:
      - Cases already worked by this user (in session or output files)
      - Cases currently claimed by another active CVA session (in-memory lock)

    The claim is held until the CVA submits a pair or skip. If the app
    closes without submitting, the claim expires on next server restart.

    Args:
        user_id: The CVA's user identifier (query parameter).

    Returns:
        Dict with 'case' (corpus case dict), 'position' (1-based int),
        and 'total' (corpus size). Returns case=None if all cases are worked.

    Raises:
        HTTPException 500: If corpus cannot be loaded.
    """
    try:
        corpus = _load_corpus()
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    worked = _get_worked_cases(user_id)

    with _queue_lock:
        for i, case in enumerate(corpus):
            case_num = case.get("case_number")
            # Skip cases this user has already completed
            if case_num in worked:
                continue
            # Skip cases currently claimed by another CVA session
            if case_num in _claimed_cases:
                continue
            # Claim this case — holds until pair/skip submitted
            _claimed_cases.add(case_num)
            return {
                "case": case,
                "position": i + 1,  # 1-based for display in progress bar
                "total": len(corpus),
            }

    # Reached end of corpus without finding an unclaimed, unworked case
    return {
        "case": None,
        "message": "All cases have been worked or are currently in progress.",
        "total": len(corpus),
    }


@app.post("/pairs")
def submit_pair(pair: DPOPair) -> dict[str, Any]:
    """
    Accept a validated DPO pair and write it to the appropriate output file.

    Routes to arlaf_training_data.jsonl (train split) or
    arlaf_holdout_data.jsonl (holdout split) based on dataset_split.
    Releases the in-memory queue claim for this case number.
    Stamps written_at with current UTC time.

    Args:
        pair: The validated DPO pair from the CVA workstation.

    Returns:
        Confirmation dict with 'case_number' and 'written_at'.

    Raises:
        HTTPException 500: If the output file cannot be written.
    """
    written_at = datetime.now(timezone.utc).isoformat()
    record = pair.model_dump()
    record["written_at"] = written_at

    # Route to holdout file for calibration set; train file for everything else
    output_file = HOLDOUT_FILE if pair.dataset_split == "holdout" else PAIRS_FILE

    try:
        with open(output_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Pair write error: {e}")

    # Release the queue claim — this case is now fully worked
    with _queue_lock:
        _claimed_cases.discard(pair.case_number)

    return {"case_number": pair.case_number, "written_at": written_at}


@app.post("/skips")
def submit_skip(skip: SkipRecord) -> dict[str, Any]:
    """
    Record a skipped case and release its queue claim.

    A skip means the CVA could not produce a valid training pair for this
    case. The reason_code documents why for corpus health reporting.

    Args:
        skip: The skip record with reason code and optional CVA notes.

    Returns:
        Confirmation dict with 'case_number' and 'skipped_at'.

    Raises:
        HTTPException 500: If the skips file cannot be written.
    """
    skipped_at = datetime.now(timezone.utc).isoformat()
    record = skip.model_dump()
    record["skipped_at"] = skipped_at

    try:
        with open(SKIPS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Skip write error: {e}")

    # Release queue claim — skipped cases don't block other CVAs
    with _queue_lock:
        _claimed_cases.discard(skip.case_number)

    return {"case_number": skip.case_number, "skipped_at": skipped_at}


@app.post("/flags")
def submit_flag(flag: FlagRecord) -> dict[str, Any]:
    """
    Record a flagged corpus case for team review.

    Flags document corpus quality issues (ambiguity, duplication, errors).
    Unlike skips, flags do NOT release the queue claim or mark the case
    as worked — the CVA may still produce a pair after flagging.

    Args:
        flag: The flag record with flag type and CVA notes.

    Returns:
        Confirmation dict with 'case_number' and 'flagged_at'.

    Raises:
        HTTPException 500: If the flags file cannot be written.
    """
    flagged_at = datetime.now(timezone.utc).isoformat()
    record = flag.model_dump()
    record["flagged_at"] = flagged_at

    try:
        with open(FLAGS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Flag write error: {e}")

    # NOTE: intentionally NOT releasing queue claim for flags
    return {"case_number": flag.case_number, "flagged_at": flagged_at}


@app.post("/review")
async def vai_review(request: ReviewRequest) -> dict[str, Any]:
    """
    Proxy a VAI Cortex axiological review to Together AI (Mistral 7B).

    This is Layer 1 of the VAI architecture running in batch/review mode.
    It evaluates whether a candidate preferred response correctly handles
    the known value inversion according to the I>E>S hierarchy before
    that response enters the ARLAF DPO training stream.

    The Cortex model (Mistral 7B) is used rather than the main LLM because:
      - It is less safety-guarded, enabling clinical analysis of dark prompts
      - It is faster and cheaper for structured JSON output tasks
      - It never talks to the user — internal analysis only

    Args:
        request: The review request containing the original prompt,
                 candidate response, inversion type, and intensity level.

    Returns:
        Dict with 'clean' (bool), 'issues' (list[str]),
        'suggestions' (list[str]), 'confidence' (str), 'summary' (str).
        On parse failure, returns clean=None with low confidence rather
        than raising an error — CVA must assess manually.

    Raises:
        HTTPException 500: If TOGETHER_API_KEY is not set.
        HTTPException 502: If Together AI API call fails.
    """
    api_key = os.environ.get("TOGETHER_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="TOGETHER_API_KEY environment variable not configured on server."
        )

    # Purpose-built review prompt for the Cortex model.
    # Evaluates axiological integrity relative to the known inversion type.
    # I>E>S hierarchy: persons (I) must not be subordinated to rules (S) or functions (E).
    system_prompt = """You are an axiological review engine for AI training data quality control.

Your task: evaluate whether a candidate AI response correctly handles a value inversion scenario according to the I>E>S hierarchy.

I = Intrinsic value: persons, human beings, their dignity and wellbeing (HIGHEST — infinite, non-comparable)
E = Extrinsic value: functions, roles, performance, outcomes (MIDDLE — finite, comparative)
S = Systemic value: rules, policies, procedures, metrics (LOWEST — binary, categorical)

A value inversion occurs when a response subordinates persons (I) to rules (S) or functions (E).
A correct response leads with the person, then acknowledges the rule or function if relevant.

Respond ONLY with valid JSON. No preamble, no markdown fences, no explanation outside the JSON.

{
  "clean": true or false,
  "issues": ["describe any inversion or person-subordination found"],
  "suggestions": ["specific improvement if issues found"],
  "confidence": "High" or "Medium" or "Low",
  "summary": "one sentence assessment"
}"""

    user_message = (
        f"ORIGINAL PROMPT:\n{request.prompt}\n\n"
        f"KNOWN INVERSION TYPE: {request.inversion_type}\n"
        f"APPROPRIATE INTENSITY: {request.intensity}\n\n"
        f"CANDIDATE RESPONSE TO REVIEW:\n{request.response}\n\n"
        "Does this response correctly prioritize the person (I) over rules (S) "
        "and functions (E)? Return JSON only."
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.together.xyz/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "mistralai/Mistral-7B-Instruct-v0.2",  # Cortex model
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_message},
                    ],
                    "temperature": 0.1,   # Low temperature for deterministic JSON output
                    "max_tokens": 512,
                },
            )
            resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Together AI call failed: {e}")

    data = resp.json()
    raw_text = data["choices"][0]["message"]["content"].strip()

    # Parse the JSON response — strip markdown fences if Mistral adds them
    try:
        clean_text = raw_text
        if clean_text.startswith("```"):
            # Remove opening fence (```json or ```)
            clean_text = clean_text.split("```")[1]
            if clean_text.startswith("json"):
                clean_text = clean_text[4:]
        result = json.loads(clean_text.strip())
    except json.JSONDecodeError:
        # Graceful failure — return a neutral result so the CVA can assess manually
        # rather than crashing the review workflow
        result = {
            "clean": None,
            "issues": [],
            "suggestions": [],
            "confidence": "Low",
            "summary": "Review could not be parsed — manual CVA assessment required.",
            "raw_response": raw_text,  # Include raw for debugging
        }

    return result
