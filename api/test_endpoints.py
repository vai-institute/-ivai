#!/usr/bin/env python3
"""
IVAI CVA API — Endpoint Smoke Test (v1.9.0)
==============================================
Run after deployment to verify the core endpoints respond correctly.

v1.9.0 changes:
  - Auth is JWT Bearer now (pre-JWT X-User-Id header is gone).
  - Case identifier is `case_id` VARCHAR(12) in format YYMMDD-NNNNN
    (was `case_number` INT in v1.8.x).
  - Session fields use `last_case_id` (was `last_case_number`); counter
    fields are ignored by POST /session (server derives them).
  - /queue/release path uses `{case_id}` (was `{case_number}`).

Usage:
    python api/test_endpoints.py --base-url https://cva.vai-institute.com \\
        --user-id peter_d --password 'xxxxx'

    # Local dev
    python api/test_endpoints.py --base-url http://localhost:8000 \\
        --user-id peter_d --password 'xxxxx'
"""

import argparse
import sys

import httpx


def check(label: str, response: httpx.Response, expected: int = 200) -> bool:
    """Print pass/fail for a single endpoint check."""
    ok = response.status_code == expected
    status = "PASS" if ok else "FAIL"
    print(f"{status}  {label}  [{response.status_code}]")
    if not ok:
        print(f"       Response: {response.text[:200]}")
    return ok


def run(base_url: str, user_id: str, password: str) -> int:
    """Run all smoke tests. Returns number of failures."""
    base_url = base_url.rstrip("/")
    failures = 0
    client = httpx.Client(timeout=30.0)

    print(f"\nIVAI CVA API Smoke Test (v1.9.0) — {base_url}\n{'-' * 60}")

    # --- Health (no auth) ------------------------------------------------
    r = client.get(f"{base_url}/health")
    if not check("GET  /health", r):
        failures += 1

    # --- Login -> JWT ---------------------------------------------------
    login_payload = {"user_id": user_id, "password": password}
    r = client.post(f"{base_url}/auth/login", json=login_payload)
    if not check("POST /auth/login", r):
        failures += 1
        print("       Cannot continue without a token.")
        return failures

    token = r.json().get("access_token")
    if not token:
        print("FAIL  /auth/login returned no access_token in response")
        return failures + 1
    print(f"       access_token acquired ({len(token)} chars)")

    headers = {"Authorization": f"Bearer {token}"}

    # --- Corpus --------------------------------------------------------
    r = client.get(f"{base_url}/corpus", headers=headers)
    if not check("GET  /corpus", r):
        failures += 1
    else:
        data = r.json()
        total = data.get("total", "?")
        first_case = (data.get("cases") or [{}])[0]
        print(f"       Loaded {total} cases; first case_id = {first_case.get('case_id')}")

    # --- Session read (derived counters in v1.9.0) ---------------------
    r = client.get(f"{base_url}/session/{user_id}", headers=headers)
    if not check(f"GET  /session/{user_id}", r):
        failures += 1
    else:
        s = r.json()
        lc = s.get("last_case_id", "")
        print(
            "       last_case_id='{}' pairs={} skipped={} flagged={}".format(
                lc,
                s.get("pairs_written"),
                s.get("skipped"),
                s.get("flagged"),
            )
        )

    # --- Session write (counter fields will be ignored in v1.9.0) ------
    session_payload = {
        "last_case_id":    "",
        "pairs_written":   0,
        "pairs_train":     0,
        "pairs_holdout":   0,
        "skipped":         0,
        "flagged":         0,
        "session_start":   "2026-04-24T00:00:00Z",
        "last_updated":    "",
        "completed_cases": [],
        "layout_preset":   "wide",
        "review_mode":     "staged",
    }
    r = client.post(f"{base_url}/session/{user_id}", headers=headers, json=session_payload)
    if not check(f"POST /session/{user_id}", r):
        failures += 1

    # --- Queue next + release ------------------------------------------
    r = client.get(f"{base_url}/queue/next", headers=headers)
    if not check("GET  /queue/next", r):
        failures += 1
    else:
        case = r.json().get("case")
        if case:
            cid = case.get("case_id")
            print(f"       Next case: {cid} — {case.get('vertical')}")
            print(f"       data_classification: {case.get('data_classification')}")
            # Release so we don't pollute the queue for the real user
            rel = client.post(f"{base_url}/queue/release/{cid}", headers=headers)
            print(f"       Released {cid} [{rel.status_code}]")
        else:
            print("       Queue exhausted (expected if all cases completed)")

    # --- Skip (uses a synthetic case_id outside the seed batch) --------
    skip_payload = {
        "case_id":      "999999-99999",
        "reason_code":  "technical_failure",
        "reason_label": "API error - smoke test",
        "cva_notes":    "Smoke test skip - discard",
    }
    r = client.post(f"{base_url}/skips", headers=headers, json=skip_payload)
    if not check("POST /skips", r):
        failures += 1

    # --- Flag ----------------------------------------------------------
    flag_payload = {
        "case_id":   "999999-99998",
        "flag_type": "team_review",
        "cva_notes": "Smoke test flag - discard",
    }
    r = client.post(f"{base_url}/flags", headers=headers, json=flag_payload)
    if not check("POST /flags", r):
        failures += 1

    # --- Review (optional; 503 acceptable if TOGETHER_API_KEY not set) --
    review_payload = {
        "preferred_text": "Smoke test text. Not a real response.",
        "case_context": {
            "vertical": "Healthcare",
            "inversion_type": "Type IV",
            "primary_entity_i": "patient",
            "primary_systemic_element_s": "billing metric",
        },
    }
    r = client.post(f"{base_url}/review", headers=headers, json=review_payload)
    if r.status_code in (200, 503):
        label = "PASS" if r.status_code == 200 else "SKIP"
        print(f"{label}  POST /review  [{r.status_code}]")
        if r.status_code == 503:
            print("       TOGETHER_API_KEY not set - skipped (expected in local dev)")
    else:
        print(f"FAIL  POST /review  [{r.status_code}]")
        failures += 1

    print(f"\n{'-' * 60}")
    if failures == 0:
        print("All checks passed.")
    else:
        print(f"{failures} check(s) failed.")

    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IVAI CVA API smoke test (v1.9.0)")
    parser.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="Base URL of the deployed API",
    )
    parser.add_argument(
        "--user-id",
        default="peter_d",
        help="User ID to log in as",
    )
    parser.add_argument(
        "--password",
        required=True,
        help="Password for the given user",
    )
    args = parser.parse_args()
    sys.exit(run(args.base_url, args.user_id, args.password))
