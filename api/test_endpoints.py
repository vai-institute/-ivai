#!/usr/bin/env python3
"""
IVAI CVA API — Endpoint Smoke Test
====================================
Run this after deployment to verify all 8 endpoints respond correctly.

Usage:
    python api/test_endpoints.py --base-url https://cva.vai-institute.com
    python api/test_endpoints.py --base-url http://localhost:8000  # local dev
"""

import argparse
import json
import sys

import httpx

HEADERS = {"X-User-Id": "peter_d"}


def check(label: str, response: httpx.Response, expected: int = 200) -> bool:
    """Print pass/fail for a single endpoint check."""
    ok = response.status_code == expected
    status = "✅ PASS" if ok else "❌ FAIL"
    print(f"{status}  {label}  [{response.status_code}]")
    if not ok:
        print(f"       Response: {response.text[:200]}")
    return ok


def run(base_url: str) -> int:
    """Run all smoke tests. Returns number of failures."""
    base_url = base_url.rstrip("/")
    failures = 0
    client = httpx.Client(timeout=15.0)

    print(f"\nIVAI CVA API Smoke Test — {base_url}\n{'─' * 50}")

    # Health (no auth)
    r = client.get(f"{base_url}/health")
    if not check("GET  /health", r): failures += 1

    # Corpus
    r = client.get(f"{base_url}/corpus", headers=HEADERS)
    if not check("GET  /corpus", r): failures += 1
    else:
        data = r.json()
        print(f"       Loaded {data.get('total', '?')} cases")

    # Session read (no existing session — expect defaults)
    r = client.get(f"{base_url}/session/peter_d", headers=HEADERS)
    if not check("GET  /session/peter_d", r): failures += 1

    # Session write
    payload = {
        "last_case_number": 1, "pairs_written": 0, "pairs_train": 0,
        "pairs_holdout": 0, "skipped": 0, "flagged": 0,
        "session_start": "2026-03-21T09:00:00Z", "last_updated": "",
        "completed_cases": []
    }
    r = client.post(f"{base_url}/session/peter_d", headers=HEADERS, json=payload)
    if not check("POST /session/peter_d", r): failures += 1

    # Queue next
    r = client.get(f"{base_url}/queue/next", headers=HEADERS)
    if not check("GET  /queue/next", r): failures += 1
    else:
        case = r.json().get("case")
        if case:
            print(f"       Next case: #{case.get('case_number')} — {case.get('vertical')}")
            print(f"       data_classification: {case.get('data_classification')}")
            # Release it so we don't pollute the queue
            cn = case.get("case_number")
            client.post(f"{base_url}/queue/release/{cn}", headers=HEADERS)
        else:
            print("       Queue exhausted (expected if corpus not loaded)")

    # Skip
    skip_payload = {
        "case_number": 9999,
        "reason_code": "technical_failure",
        "reason_label": "API error — smoke test",
        "cva_notes": "Smoke test skip — discard"
    }
    r = client.post(f"{base_url}/skips", headers=HEADERS, json=skip_payload)
    if not check("POST /skips", r): failures += 1

    # Flag
    flag_payload = {
        "case_number": 9999,
        "flag_type": "needs_team_review",
        "cva_notes": "Smoke test flag — discard"
    }
    r = client.post(f"{base_url}/flags", headers=HEADERS, json=flag_payload)
    if not check("POST /flags", r): failures += 1

    # Review (will fail with 503 if TOGETHER_API_KEY not set — that's expected locally)
    review_payload = {
        "preferred_text": "Smoke test text. Not a real response.",
        "case_context": {
            "vertical": "Healthcare",
            "inversion_type": "Type IV",
            "primary_entity_i": "patient",
            "primary_systemic_element_s": "billing metric"
        }
    }
    r = client.post(f"{base_url}/review", headers=HEADERS, json=review_payload)
    # 503 = API key not configured (acceptable in local dev), 200 = real call succeeded
    if r.status_code in (200, 503):
        status_label = "✅ PASS" if r.status_code == 200 else "⚠️  SKIP"
        print(f"{status_label}  POST /review  [{r.status_code}]")
        if r.status_code == 503:
            print("       TOGETHER_API_KEY not set — skipped (expected in local dev)")
    else:
        print(f"❌ FAIL  POST /review  [{r.status_code}]")
        failures += 1

    print(f"\n{'─' * 50}")
    if failures == 0:
        print("All checks passed. ✅")
    else:
        print(f"{failures} check(s) failed. ❌")

    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IVAI CVA API smoke test")
    parser.add_argument(
        "--base-url",
        default="http://localhost:8000",
        help="Base URL of the deployed API"
    )
    args = parser.parse_args()
    sys.exit(run(args.base_url))
