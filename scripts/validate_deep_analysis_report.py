#!/usr/bin/env python3
"""Validate deep-analysis markdown against Andrea's ARM-approved layout.

This is an anti-regression gate for Bitget deep-analysis reports/chat drafts.
It intentionally checks structure, not trading correctness.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def has_heading(text: str, pattern: str) -> bool:
    return re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE) is not None


def section_text(text: str, heading_pat: str) -> str:
    m = re.search(heading_pat, text, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    nxt = re.search(r"^##\s+", text[start:], flags=re.MULTILINE)
    end = start + nxt.start() if nxt else len(text)
    return text[start:end]


def validate(text: str) -> dict:
    checks: list[dict] = []

    def add(key: str, ok: bool, message: str):
        checks.append({"key": key, "ok": bool(ok), "message": message})

    # Canonical ARM-approved section family.
    required_sections = [
        ("header", r"^##\s+.*header\s*/\s*classification|^##\s+.*header.*classification", "Header / classification section"),
        ("context_state", r"^##\s+.*context\s+and\s+state", "Context and state section"),
        ("level_map", r"^##\s+.*(detected\s+level\s+map|structure\s+and\s+key\s+levels)", "Detected level map / structure levels section"),
        ("pullback_impulse", r"^##\s+.*pullback\s+impulse\s+used", "Pullback impulse used section"),
        ("a_section", r"^##\s+A\s+[—-].*BEST\s+QUALITY\s+PULLBACK", "A — BEST QUALITY PULLBACK section"),
        ("b_section", r"^##\s+B\s+[—-].*BEST\s+FILL-PROBABILITY\s+PULLBACK", "B — BEST FILL-PROBABILITY PULLBACK section"),
        ("c_section", r"^##\s+C\s+[—-].*(BREAKOUT|BREAKDOWN)", "C — BREAKOUT / BREAKDOWN section"),
        ("c1_subsection", r"^###\s+C1\s+[—-].*(Long\s+breakout|breakout)", "C1 long breakout subsection"),
        ("c2_subsection", r"^###\s+C2\s+[—-].*(Short\s+breakdown|breakdown)", "C2 short breakdown subsection"),
        ("d_section", r"^##\s+D\s+[—-].*(OC|VOCO|EXECUTION\s+WRAPPER)", "D / OC wrapper section"),
        ("orderability", r"^##\s+.*(Orderability|liquidity).*traffic-light|^##\s+.*Orderability\s*/\s*liquidity", "Orderability / liquidity traffic-light table"),
        ("risk_sizing", r"^##\s+.*Risk\s+sizing\s+summary", "Risk sizing summary section"),
        ("final_verdict", r"^##\s+.*Final\s+verdict", "Final verdict section"),
    ]
    for key, pat, msg in required_sections:
        add(key, has_heading(text, pat), msg)

    # Required tables/content markers.
    ticket_header = "| Leg | Entry | Type | Qty | Notional | SL | Loss | TP | Profit | RR | Trigger |"
    add("ticket_table", ticket_header.lower() in text.lower(), "At least one full ticket table with canonical columns")

    risk_header = "| Plan | Status | Risk | Reward | RR | Notional | Margin |"
    add("risk_table", risk_header.lower() in text.lower(), "Risk sizing table with plan/status/risk/reward/RR/notional/margin")

    add("traffic_lights", any(ch in text for ch in ["🟢", "🟡", "🔴", "⚪"]), "Traffic-light icons present")

    impulse = section_text(text, r"^##\s+.*pullback\s+impulse\s+used.*$")
    arrows = len(re.findall(r"→|->", impulse))
    add("impulse_alternatives", arrows >= 2, "Pullback impulse section compares at least two candidate impulses")
    add("broad_impulse", bool(re.search(r"broad|visible|parent", impulse, flags=re.IGNORECASE)), "Impulse section explicitly discusses broad/visible/parent impulse")

    orderability = section_text(text, r"^##\s+.*(Orderability|liquidity).*$")
    for key, label in [
        ("gate_existing", r"Existing.*(orders|position)"),
        ("gate_spread", "Spread"),
        ("gate_24h", "24h"),
        ("gate_dead", "Dead"),
        ("gate_volume_stress", "RWA|Volume stress|p10"),
        ("gate_stop_exit", "Stop-exit|stop-exit sim"),
        ("gate_depth", "Depth"),
    ]:
        add(key, bool(re.search(label, orderability, flags=re.IGNORECASE)), f"Orderability table includes {label} gate")

    # Valid/rejected statuses must be explicit for A/B/C/D.
    for key, pat in [
        ("a_status", r"^##\s+A\s+[—-].*?\n\*\*Status:\*\*"),
        ("b_status", r"^##\s+B\s+[—-].*?\n\*\*Status:\*\*"),
        ("c1_status", r"^###\s+C1\s+[—-].*?\n\*\*Status:\*\*"),
        ("c2_status", r"^###\s+C2\s+[—-].*?\n\*\*Status:\*\*"),
    ]:
        add(key, bool(re.search(pat, text, flags=re.IGNORECASE | re.DOTALL | re.MULTILINE)), f"{key.replace('_', ' ').upper()} is explicit")

    failed = [c for c in checks if not c["ok"]]
    return {
        "ok": not failed,
        "passed": len(checks) - len(failed),
        "failed": len(failed),
        "checks": checks,
        "failures": failed,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate deep-analysis report markdown against ARM-approved layout")
    ap.add_argument("--report", required=True, help="Markdown report path")
    ap.add_argument("--json", action="store_true", help="Print JSON result")
    args = ap.parse_args()

    path = Path(args.report)
    text = path.read_text(encoding="utf-8-sig")
    result = validate(text)
    result["report"] = str(path)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        status = "PASS" if result["ok"] else "FAIL"
        print(f"{status} {path} ({result['passed']} passed, {result['failed']} failed)")
        for f in result["failures"]:
            print(f"- {f['key']}: {f['message']}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
