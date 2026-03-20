"""
IVAI CVA Tool — FastAPI Backend
================================
Serves the 8 API endpoints required by the CVA Curation Tool Electron app.

Compliance posture (built-in, not bolted on):
  - SOC 2 CC6:  Server-side role enforcement on every protected endpoint.
  - SOC 2 CC7:  Full audit log on every write — user_id, action, timestamp,
                resource_id, before/after state.
  - GDPR/HIPAA: PII scrubbing via Microsoft Presidio before any pair is
                written to disk.
  - FERPA:      data_classification field on all corpus cases; FERPA-tagged
                user sessions are firewalled from the ARLAF training pipeline.

Author: IVAI Engineering
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Presidio — PII scrubbing
# ---------------------------------------------------------------------------
try:
    from presidio_analyzer import AnalyzerEngine
    from presidio_anonymizer import AnonymizerEngine

    _analyzer = AnalyzerEngine()
    _anonymizer = AnonymizerEngine()
    PRESIDIO_AVAILABLE = True
except ImportError:  # pragma: no cover
    PRESIDIO_AVAILABLE = False
    print(
        "WARNING: presidio-analyzer / presidio-anonymizer not installed. "
        "PII scrubbing is DISABLED. Run: pip install presidio-analyzer "
        "presidio-anonymizer && python -m spacy download en_core_web_lg"
    )


def scrub_pii(text: str) -> str:
    """
    Remove personally identifiable information from text before it is
    written to the training corpus.

    Uses Microsoft Presidio to detect and replace PII entities
    (names, emails, phone numbers, dates of birth, locations, IDs, etc.)
    with type-labelled placeholders, e.g. <PERSON>, <EMAIL_ADDRESS>.

    If Presidio is unavailable (dev environment without the package),
    returns the original text and logs a warning — never silently drops data.

    Args:
        text: Raw text that may contain PII.

    Returns:
        Anonymised text safe for inclusion in training data.
    """
    if not PRESIDIO_AVAILABLE or not text:
        return text

    results = _analyzer.analyze(text=text, language="en")
    if not results:
        return text

    anonymized = _anonymizer.anonymize(text=text, analyzer_results=results)
    return anonymized.text


# ---------------------------------------------------------------------------
# Paths — resolve relative to this file so Railway can place repo anywhere
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent.parent  # repo root
CORPUS_DIR = BASE_DIR / "data" / "corpus"
OUTPUT_DIR = BASE_DIR / "output"
SESSION_DIR = BASE_DIR / "session"
USERS_FILE = BASE_DIR / "config" / "users.json"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
SESSION_DIR.mkdir(parents=True, exist_ok=True)

PAIRS_FILE = OUTPUT_DIR / "arlaf_training_data.jsonl"
HOLDOUT_FILE = OUTPUT_DIR / "arlaf_holdout_data.jsonl"
PENDING_FILE = OUTPUT_DIR / "arlaf_pending_review.jsonl"
SKIPS_FILE = OUTPUT_DIR / "skipped_cases.jsonl"
FLAGS_FILE = OUTPUT_DIR / "flagged_cases.jsonl"
AUDIT_FILE = OUTPUT_DIR / "audit_log.jsonl"

# ---------------------------------------------------------------------------
# Thread-safe file lock — prevents concurrent write corruption
# ---------------------------------------------------------------------------
_write_lock = threading.Lock()

# ---------------------------------------------------------------------------
# In-memory corpus + queue state
# ---------------------------------------------------------------------------
_corpus: list[dict] = []
_corpus_loaded = False
_corpus_lock = threading.Lock()

# Tracks which case numbers are currently being worked on by a CVA, so two
# CVAs cannot receive the same case from GET /queue/next simultaneously.
_in_flight: set[int] = set()
_queue_lock = threading.Lock()


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
app = FastAPI(
    title="IVAI CVA Tool API",
    description="Backend API for the IVAI CVA Curation Tool.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    # In production, restrict this to the Electron app origin.
    # Electron apps use 'null' origin by default.
    allow_origins=["null", "http://localhost", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# User / role model
# ---------------------------------------------------------------------------

def _load_users() -> dict[str, dict]:
    """
    Load users.json and return a flat dict keyed by user_id.

    Resolves each user's role to its full capabilities list so the
    rest of the API can do simple capability lookups without knowing
    the role/user separation in the source file.
    """
    if not USERS_FILE.exists():
        return {}
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    roles = data.get("roles", {})
    users_list = data.get("users", [])

    result = {}
    for user in users_list:
        user_id = user.get("user_id")
        role = user.get("role", "")
        role_def = roles.get(role, {})
        result[user_id] = {
            "user_id": user_id,
            "display_name": user.get("display_name", ""),
            "role": role,
            "capabilities": role_def.get("capabilities", []),
        }
    return result

def _get_user(user_id: str) -> dict:
    """
    Return the user record for user_id, or raise 401 if unknown.

    Args:
        user_id: The user identifier from the X-User-Id request header.

    Returns:
        User record dict containing at minimum 'capabilities' list.

    Raises:
        HTTPException 401: If user_id is not found in users.json.
    """
    users = _load_users()
    user = users.get(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Unknown user: {user_id}",
        )
    return user


def _require_capability(user: dict, capability: str) -> None:
    """
    Enforce that a user has a required capability.

    SOC 2 CC6 — Logical and Physical Access Controls:
    All capability checks are performed server-side. Client-side UI
    enforcement (hiding buttons) is UX convenience only — this is the
    authoritative gate.

    Args:
        user:       User record from users.json.
        capability: Required capability string, e.g. 'cva', 'reviewer', 'admin'.

    Raises:
        HTTPException 403: If the user lacks the required capability.
    """
    capabilities = user.get("capabilities", [])
    if capability not in capabilities and "admin" not in capabilities:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Capability '{capability}' required.",
        )


# ---------------------------------------------------------------------------
# Auth dependency — extracts X-User-Id header and validates
# ---------------------------------------------------------------------------

def get_current_user(x_user_id: str = Header(..., alias="X-User-Id")) -> dict:
    """
    FastAPI dependency: validate X-User-Id header and return user record.

    Every protected endpoint injects this dependency. The header value is
    the user_id string from users.json. In a future auth upgrade this will
    be replaced by a JWT bearer token — the capability check logic is
    identical either way.

    Args:
        x_user_id: Value of the X-User-Id request header.

    Returns:
        Validated user record dict.
    """
    user = _get_user(x_user_id)
    user["_user_id"] = x_user_id  # attach id for downstream use
    return user


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def _write_audit(
    user_id: str,
    action: str,
    resource_type: str,
    resource_id: str,
    detail: dict | None = None,
    before: dict | None = None,
    after: dict | None = None,
) -> None:
    """
    Append a structured audit record to audit_log.jsonl.

    SOC 2 CC7 — System Monitoring:
    Every write action (pair submitted, skip recorded, flag recorded,
    session updated) produces an audit record. Records are append-only
    and never modified.

    HIPAA §164.312(b) — Audit Controls:
    Record includes who (user_id), what (action), when (timestamp),
    and which resource (resource_type + resource_id). Before/after state
    is recorded for any mutation.

    Args:
        user_id:       ID of the user performing the action.
        action:        Action label, e.g. 'pair_submitted', 'case_skipped'.
        resource_type: Type of resource affected, e.g. 'pair', 'session'.
        resource_id:   Identifier of the specific resource.
        detail:        Optional additional context dict.
        before:        State of the resource before the action (mutations).
        after:         State of the resource after the action (mutations).
    """
    record = {
        "audit_id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "user_id": user_id,
        "action": action,
        "resource_type": resource_type,
        "resource_id": resource_id,
    }
    if detail:
        record["detail"] = detail
    if before is not None:
        record["before"] = before
    if after is not None:
        record["after"] = after

    with _write_lock:
        with open(AUDIT_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# Corpus loader
# ---------------------------------------------------------------------------

def _ensure_corpus_loaded() -> None:
    """
    Load all JSONL corpus files into memory on first call (lazy singleton).

    Scans CORPUS_DIR for *.jsonl files, parses every line, sorts by
    case_number ascending, and injects a data_classification field on any
    case whose vertical maps to a sensitive data category.

    The data_classification field enables the PII scrubber to apply
    appropriate anonymisation intensity and allows the training pipeline
    to enforce FERPA / HIPAA data firewalls.

    data_classification values:
        'general'           — standard case, no elevated sensitivity
        'health'            — Healthcare / Mental Health verticals (HIPAA)
        'financial'         — Fintech vertical (GLBA)
        'education_minor'   — Children's AI vertical (COPPA / FERPA)
        'education_adult'   — Education / university verticals (FERPA)
    """
    global _corpus, _corpus_loaded
    with _corpus_lock:
        if _corpus_loaded:
            return

        cases: list[dict] = []
        if CORPUS_DIR.exists():
            for jsonl_file in sorted(CORPUS_DIR.glob("*.jsonl")):
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                case = json.loads(line)
                                case["data_classification"] = _classify_case(
                                    case.get("vertical", "")
                                )
                                cases.append(case)
                            except json.JSONDecodeError:
                                pass  # skip malformed lines

        cases.sort(key=lambda c: c.get("case_number", 0))
        _corpus = cases
        _corpus_loaded = True
        print(f"Loaded {len(_corpus)} cases from {CORPUS_DIR}")


def _classify_case(vertical: str) -> str:
    """
    Map a corpus vertical label to a data_classification string.

    Args:
        vertical: The 'vertical' field value from a corpus case.

    Returns:
        data_classification string for downstream compliance enforcement.
    """
    v = vertical.lower()
    if "health" in v or "mental" in v or "medical" in v:
        return "health"
    if "fintech" in v or "financial" in v or "banking" in v:
        return "financial"
    if "children" in v or "child" in v or "parental" in v:
        return "education_minor"
    if "education" in v or "student" in v or "universit" in v:
        return "education_adult"
    return "general"


def _get_completed_cases() -> set[int]:
    """
    Return the set of case numbers already present in all output files.

    Scans training, holdout, pending, and skips files so the queue
    correctly excludes cases that have been processed in any path.

    Returns:
        Set of integer case numbers that are already complete.
    """
    completed: set[int] = set()
    for output_file in [PAIRS_FILE, HOLDOUT_FILE, PENDING_FILE, SKIPS_FILE]:
        if output_file.exists():
            with open(output_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            record = json.loads(line)
                            cn = record.get("case_number")
                            if cn is not None:
                                completed.add(int(cn))
                        except (json.JSONDecodeError, ValueError):
                            pass
    return completed


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class SessionState(BaseModel):
    """Mirrors the structure of session/progress.json."""
    last_case_number: int = 0
    pairs_written: int = 0
    pairs_train: int = 0
    pairs_holdout: int = 0
    skipped: int = 0
    flagged: int = 0
    session_start: str = ""
    last_updated: str = ""
    completed_cases: list[int] = Field(default_factory=list)


class PairSubmission(BaseModel):
    """DPO pair payload from the Electron app."""
    case_number: int
    vertical: str
    inversion_type: str
    subtlety: str
    boundary_condition: bool
    inversion_severity: str
    appropriate_intensity: str
    identity_language: bool
    cva_flags: dict[str, Any]
    cva_notes: Optional[str] = ""
    pair_index: int = 1
    standard_slot: dict[str, Any]
    vai_slot: dict[str, Any]
    input: dict[str, Any]
    preferred_output: list[dict[str, Any]]
    non_preferred_output: list[dict[str, Any]]
    dataset_split: str = "train"
    # Compliance fields
    data_classification: Optional[str] = "general"
    ferpa_consent: Optional[bool] = False


class SkipSubmission(BaseModel):
    """Skip record payload."""
    case_number: int
    reason_code: str
    reason_label: str
    cva_notes: Optional[str] = ""


class FlagSubmission(BaseModel):
    """Flag record payload."""
    case_number: int
    flag_type: str
    cva_notes: Optional[str] = ""


class ReviewRequest(BaseModel):
    """VAI review proxy payload — forwarded to Together AI."""
    preferred_text: str
    case_context: dict[str, Any]
    model: Optional[str] = "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health_check() -> dict:
    """
    Liveness check — no auth required.
    Railway and monitoring tools call this to confirm the service is up.
    """
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/corpus")
async def get_corpus(
    vertical: Optional[str] = None,
    inversion_type: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Return all corpus cases, optionally filtered by vertical or inversion_type.

    Requires: 'cva' or 'reviewer' capability.

    Args:
        vertical:       Optional filter — return only cases matching this vertical.
        inversion_type: Optional filter — return only cases matching this type.

    Returns:
        Dict with 'cases' list and 'total' count.
    """
    _require_capability(user, "cva")
    _ensure_corpus_loaded()

    cases = _corpus
    if vertical:
        cases = [c for c in cases if c.get("vertical") == vertical]
    if inversion_type:
        cases = [c for c in cases if c.get("inversion_type") == inversion_type]

    _write_audit(
        user_id=user["_user_id"],
        action="corpus_fetched",
        resource_type="corpus",
        resource_id="full",
        detail={"vertical": vertical, "inversion_type": inversion_type, "count": len(cases)},
    )

    return {"cases": cases, "total": len(cases)}


@app.get("/session/{user_id}")
async def get_session(
    user_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Return the session state for a given user_id.

    CVAs may only read their own session. Admins may read any session.

    Args:
        user_id: The CVA's user_id whose session to retrieve.

    Returns:
        SessionState dict. Returns defaults if no session file exists yet.
    """
    # CVAs can only read their own session
    if user["_user_id"] != user_id and "admin" not in user.get("capabilities", []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot read another user's session.",
        )

    session_file = SESSION_DIR / f"{user_id}.json"
    if not session_file.exists():
        return SessionState().model_dump()

    with open(session_file, "r", encoding="utf-8") as f:
        return json.load(f)


@app.post("/session/{user_id}")
async def update_session(
    user_id: str,
    state: SessionState,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Write updated session state for a given user_id.

    CVAs may only write their own session. Admins may write any session.

    Args:
        user_id: The CVA's user_id.
        state:   Updated SessionState payload.

    Returns:
        Confirmation dict with user_id and timestamp.
    """
    if user["_user_id"] != user_id and "admin" not in user.get("capabilities", []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot write another user's session.",
        )

    session_file = SESSION_DIR / f"{user_id}.json"

    # Read before state for audit
    before = {}
    if session_file.exists():
        with open(session_file, "r", encoding="utf-8") as f:
            before = json.load(f)

    state.last_updated = datetime.now(timezone.utc).isoformat()
    after = state.model_dump()

    with _write_lock:
        with open(session_file, "w", encoding="utf-8") as f:
            json.dump(after, f, indent=2)

    _write_audit(
        user_id=user["_user_id"],
        action="session_updated",
        resource_type="session",
        resource_id=user_id,
        before=before,
        after=after,
    )

    return {"user_id": user_id, "updated_at": state.last_updated}


@app.get("/queue/next")
async def get_next_case(
    vertical: Optional[str] = None,
    inversion_type: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Assign the next unworked case to the requesting CVA.

    Prevents two CVAs from being assigned the same case simultaneously
    by tracking in-flight case numbers in a thread-safe set.

    Args:
        vertical:       Optional filter — restrict queue to this vertical.
        inversion_type: Optional filter — restrict queue to this type.

    Returns:
        The next available corpus case dict, or {'case': None} if queue exhausted.
    """
    _require_capability(user, "cva")
    _ensure_corpus_loaded()

    completed = _get_completed_cases()

    with _queue_lock:
        for case in _corpus:
            cn = case.get("case_number")
            if cn in completed or cn in _in_flight:
                continue
            if vertical and case.get("vertical") != vertical:
                continue
            if inversion_type and case.get("inversion_type") != inversion_type:
                continue
            _in_flight.add(cn)
            _write_audit(
                user_id=user["_user_id"],
                action="case_assigned",
                resource_type="case",
                resource_id=str(cn),
            )
            return {"case": case}

    return {"case": None}


@app.post("/queue/release/{case_number}")
async def release_case(
    case_number: int,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Release a case number from the in-flight set without writing a record.

    Called when a CVA navigates away from a case without completing it,
    so other CVAs can pick it up.

    Args:
        case_number: The case number to release.
    """
    _require_capability(user, "cva")
    with _queue_lock:
        _in_flight.discard(case_number)
    return {"released": case_number}


@app.post("/pairs")
async def submit_pair(
    pair: PairSubmission,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Accept a completed DPO pair from a CVA and write it to the output file.

    Compliance steps applied in order:
      1. PII scrubbing — preferred and non-preferred response text is
         anonymised via Presidio before any write.
      2. FERPA firewall — if data_classification is 'education_adult' or
         'education_minor' AND ferpa_consent is False, the pair is written
         to arlaf_pending_review.jsonl (staging) rather than the training
         file, and is flagged for human review before ARLAF ingestion.
      3. Audit log — full record written after every successful pair write.
      4. In-flight release — case is removed from the in-progress set.

    Args:
        pair: PairSubmission payload from the Electron app.

    Returns:
        Confirmation dict with pair_id and destination file.
    """
    _require_capability(user, "cva")

    pair_id = str(uuid.uuid4())

    # --- Step 1: PII scrubbing ---
    def scrub_messages(messages: list[dict]) -> list[dict]:
        """Scrub PII from the 'content' field of each message in a list."""
        scrubbed = []
        for msg in messages:
            m = dict(msg)
            if "content" in m and isinstance(m["content"], str):
                m["content"] = scrub_pii(m["content"])
            scrubbed.append(m)
        return scrubbed

    pair.preferred_output = scrub_messages(pair.preferred_output)
    pair.non_preferred_output = scrub_messages(pair.non_preferred_output)

    # Also scrub the input prompt
    if "messages" in pair.input:
        pair.input["messages"] = scrub_messages(pair.input["messages"])

    # --- Step 2: Determine output destination ---
    is_education = pair.data_classification in ("education_adult", "education_minor")
    ferpa_blocked = is_education and not pair.ferpa_consent

    if ferpa_blocked:
        # Write to staging — human reviewer must approve before ARLAF ingestion
        destination = str(PENDING_FILE)
        destination_label = "pending_review"
    elif pair.dataset_split == "holdout":
        destination = str(HOLDOUT_FILE)
        destination_label = "holdout"
    else:
        destination = str(PAIRS_FILE)
        destination_label = "train"

    # --- Step 3: Build output record ---
    record = {
        "pair_id": pair_id,
        "case_number": pair.case_number,
        "vertical": pair.vertical,
        "inversion_type": pair.inversion_type,
        "subtlety": pair.subtlety,
        "boundary_condition": pair.boundary_condition,
        "inversion_severity": pair.inversion_severity,
        "appropriate_intensity": pair.appropriate_intensity,
        "identity_language": pair.identity_language,
        "cva_flags": pair.cva_flags,
        "cva_notes": pair.cva_notes,
        "pair_index": pair.pair_index,
        "written_by": user["_user_id"],
        "written_at": datetime.now(timezone.utc).isoformat(),
        "dataset_split": destination_label,
        "data_classification": pair.data_classification,
        "ferpa_consent": pair.ferpa_consent,
        "pii_scrubbed": PRESIDIO_AVAILABLE,
        "standard_slot": pair.standard_slot,
        "vai_slot": pair.vai_slot,
        "input": pair.input,
        "preferred_output": pair.preferred_output,
        "non_preferred_output": pair.non_preferred_output,
    }

    with _write_lock:
        with open(destination, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    # Release from in-flight
    with _queue_lock:
        _in_flight.discard(pair.case_number)

    # --- Step 4: Audit ---
    _write_audit(
        user_id=user["_user_id"],
        action="pair_submitted",
        resource_type="pair",
        resource_id=pair_id,
        detail={
            "case_number": pair.case_number,
            "destination": destination_label,
            "ferpa_blocked": ferpa_blocked,
            "pii_scrubbed": PRESIDIO_AVAILABLE,
        },
    )

    return {
        "pair_id": pair_id,
        "destination": destination_label,
        "ferpa_blocked": ferpa_blocked,
        "pii_scrubbed": PRESIDIO_AVAILABLE,
    }


@app.post("/skips")
async def submit_skip(
    skip: SkipSubmission,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Record a skipped case.

    Args:
        skip: SkipSubmission payload from the Electron app.

    Returns:
        Confirmation dict with skip_id.
    """
    _require_capability(user, "cva")

    skip_id = str(uuid.uuid4())
    record = {
        "skip_id": skip_id,
        "case_number": skip.case_number,
        "reason_code": skip.reason_code,
        "reason_label": skip.reason_label,
        "cva_notes": skip.cva_notes,
        "skipped_by": user["_user_id"],
        "skipped_at": datetime.now(timezone.utc).isoformat(),
    }

    with _write_lock:
        with open(SKIPS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    with _queue_lock:
        _in_flight.discard(skip.case_number)

    _write_audit(
        user_id=user["_user_id"],
        action="case_skipped",
        resource_type="skip",
        resource_id=skip_id,
        detail={"case_number": skip.case_number, "reason_code": skip.reason_code},
    )

    return {"skip_id": skip_id}


@app.post("/flags")
async def submit_flag(
    flag: FlagSubmission,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Record a flagged case for later review.

    Args:
        flag: FlagSubmission payload from the Electron app.

    Returns:
        Confirmation dict with flag_id.
    """
    _require_capability(user, "cva")

    flag_id = str(uuid.uuid4())
    record = {
        "flag_id": flag_id,
        "case_number": flag.case_number,
        "flag_type": flag.flag_type,
        "cva_notes": flag.cva_notes,
        "flagged_by": user["_user_id"],
        "flagged_at": datetime.now(timezone.utc).isoformat(),
    }

    with _write_lock:
        with open(FLAGS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    _write_audit(
        user_id=user["_user_id"],
        action="case_flagged",
        resource_type="flag",
        resource_id=flag_id,
        detail={"case_number": flag.case_number, "flag_type": flag.flag_type},
    )

    return {"flag_id": flag_id}


@app.post("/review")
async def vai_review(
    review: ReviewRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """
    Proxy a VAI review call to Together AI.

    Sends the preferred response text and case context to the VAIMA model
    for axiological review. Returns a structured JSON result indicating
    whether any value inversions are present and what corrections are
    suggested.

    Note: This endpoint does NOT use Presidio scrubbing because the text
    is being sent to Together AI for review, not written to training data.
    Ensure that review requests do not contain real patient / student PII
    before calling this endpoint.

    Args:
        review: ReviewRequest payload containing the preferred response
                text and case context metadata.

    Returns:
        Dict with 'issues' list, 'clean' bool, and 'suggestions' list.
    """
    _require_capability(user, "cva")

    together_api_key = os.environ.get("TOGETHER_API_KEY")
    if not together_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TOGETHER_API_KEY not configured on server.",
        )

    review_prompt = _build_review_prompt(review.preferred_text, review.case_context)

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.together.xyz/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {together_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": review.model,
                "max_tokens": 512,
                "temperature": 0.0,  # deterministic for review
                "messages": [
                    {"role": "user", "content": review_prompt}
                ],
                "response_format": {"type": "json_object"},
            },
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Together AI error: {response.text}",
        )

    result = response.json()
    content = result["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = {"raw": content, "parse_error": True}

    _write_audit(
        user_id=user["_user_id"],
        action="vai_review_called",
        resource_type="review",
        resource_id=str(uuid.uuid4()),
        detail={"model": review.model, "clean": parsed.get("clean", None)},
    )

    return parsed


def _build_review_prompt(preferred_text: str, case_context: dict) -> str:
    """
    Build the VAI review prompt for axiological evaluation of a preferred response.

    The prompt instructs the model to evaluate the response against the
    I > E > S hierarchy and return a structured JSON result.

    Args:
        preferred_text: The CVA's preferred response text to evaluate.
        case_context:   Metadata from the corpus case (inversion_type,
                        vertical, primary_entity_i, etc.)

    Returns:
        Formatted prompt string ready for the Together AI API.
    """
    return f"""You are an axiological review system trained on Formal Axiology (Hartman, 1967).
Evaluate the following AI response for value inversions using the I > E > S hierarchy:
  - I (Intrinsic): Persons and their inherent dignity — highest value
  - E (Extrinsic): Functions, outcomes, performance — secondary
  - S (Systemic): Rules, categories, policies — tertiary

A value inversion occurs when a lower-order value is prioritized over a higher-order one.

Case context:
  Vertical: {case_context.get('vertical', 'Unknown')}
  Inversion type expected: {case_context.get('inversion_type', 'Unknown')}
  Person at risk: {case_context.get('primary_entity_i', 'Unknown')}
  Systemic pressure: {case_context.get('primary_systemic_element_s', 'Unknown')}

Response to evaluate:
{preferred_text}

Return ONLY valid JSON in this exact structure:
{{
  "clean": true or false,
  "issues": [
    {{
      "inversion_type": "Type I | Type II | Type III | Type IV",
      "description": "Brief description of the inversion detected",
      "severity": "Low | Moderate | Severe",
      "location": "Quote the specific phrase where the inversion occurs"
    }}
  ],
  "suggestions": [
    "Concrete suggestion for how to correct the inversion"
  ],
  "confidence": "Low | Moderate | High"
}}

If no inversions are found, return clean: true with empty issues and suggestions arrays."""
