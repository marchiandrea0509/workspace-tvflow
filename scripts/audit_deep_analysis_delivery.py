#!/usr/bin/env python3
"""Audit user-visible deep-analysis delivery chunks before Discord posting.

This is the deterministic counterpart to prompts/deep_analysis_delivery_auditor.md.
It catches the recurring first-shot delivery failures: internal marker leakage,
incomplete chunk sets, missing section family, and malformed ticket/gate tables.
"""
from __future__ import annotations

import argparse
import glob
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from validate_deep_analysis_report import validate  # noqa: E402

FORBIDDEN_VISIBLE_MARKERS = [
    "VERBATIM_DEEP_ANALYSIS_CHUNK",
    "paste/send this chunk exactly",
    "<<<BEGIN_",
    "<<<END_",
    "OPENCLAW_INTERNAL_CONTEXT",
    "session_key:",
    "tool call",
]

REQUIRED_VISIBLE_STRINGS = [
    "## Header / Classification",
    "## Context and State",
    "## Detected Level Map",
    "## Pullback Impulse Used",
    "## A — BEST QUALITY PULLBACK",
    "## B — BEST FILL-PROBABILITY PULLBACK",
    "## C — BREAKOUT / BREAKDOWN",
    "### C1 — Long breakout",
    "### C2 — Short breakdown",
    "## D — OC EXECUTION WRAPPER",
    "## Orderability / liquidity traffic-light table",
    "### A. Liquidity and executable orderability",
    "### B. Operational safety",
    "### C. Risk and feasibility",
    "## Risk sizing summary",
    "## Final verdict",
    "| Leg | Entry | Type | Qty | Notional | SL | Loss | TP | Profit | RR | Trigger |",
    "| Plan | Status | Risk | Reward | RR | Notional | Margin |",
    "| Gate | Value | Limit / rule | Traffic light |",
]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def audit(report: Path, reply: Path, chunk_dir: Path) -> dict:
    failures: list[str] = []
    warnings: list[str] = []

    if not report.exists():
        failures.append(f"missing report: {report}")
    if not reply.exists():
        failures.append(f"missing rendered reply: {reply}")
    if not chunk_dir.exists():
        failures.append(f"missing chunk dir: {chunk_dir}")
    if failures:
        return {"ok": False, "failures": failures, "warnings": warnings}

    chunk_paths = [Path(p) for p in sorted(glob.glob(str(chunk_dir / "chunk_*.md")))]
    if not chunk_paths:
        failures.append(f"no chunk_*.md files found in {chunk_dir}")
        return {"ok": False, "failures": failures, "warnings": warnings}

    # Require contiguous chunk numbering.
    expected = [f"chunk_{i:02d}.md" for i in range(1, len(chunk_paths) + 1)]
    actual = [p.name for p in chunk_paths]
    if actual != expected:
        failures.append(f"chunk files are not contiguous/in order: expected {expected}, got {actual}")

    chunk_texts = []
    for p in chunk_paths:
        text = read_text(p)
        chunk_texts.append(text)
        for marker in FORBIDDEN_VISIBLE_MARKERS:
            if marker.lower() in text.lower():
                failures.append(f"{p}: forbidden user-visible marker/control text: {marker}")
        if not text.strip():
            failures.append(f"{p}: empty chunk")

    first_nonblank = next((line.strip() for line in chunk_texts[0].splitlines() if line.strip()), "")
    if first_nonblank.startswith("[") or "VERBATIM" in first_nonblank.upper():
        failures.append(f"{chunk_paths[0]}: first visible line is not clean report content: {first_nonblank!r}")
    if not (first_nonblank.startswith("# ") or first_nonblank.startswith("## ")):
        warnings.append(f"{chunk_paths[0]}: first visible line is unusual: {first_nonblank!r}")

    combined = "\n".join(chunk_texts)
    for required in REQUIRED_VISIBLE_STRINGS:
        if required.lower() not in combined.lower():
            failures.append(f"combined chunks missing required visible content: {required}")

    if "## Final verdict".lower() not in chunk_texts[-1].lower():
        failures.append(f"{chunk_paths[-1]}: final chunk does not contain ## Final verdict")

    # Reuse structural validator on report/reply/combined chunks.
    for label, text in [
        ("report", read_text(report)),
        ("rendered reply", read_text(reply)),
        ("combined chunks", combined),
    ]:
        result = validate(text)
        if not result["ok"]:
            for f in result["failures"]:
                failures.append(f"{label}: {f['key']}: {f['message']}")

    manifest = chunk_dir / "manifest.json"
    if not manifest.exists():
        failures.append(f"missing manifest: {manifest}")
    else:
        try:
            data = json.loads(read_text(manifest))
            if data.get("chunkCount") != len(chunk_paths):
                failures.append(f"manifest chunkCount {data.get('chunkCount')} != actual {len(chunk_paths)}")
            if data.get("userVisibleChunksAreClean") is not True:
                failures.append("manifest userVisibleChunksAreClean is not true")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"manifest parse failed: {exc}")

    return {
        "ok": not failures,
        "failures": failures,
        "warnings": warnings,
        "chunkCount": len(chunk_paths),
        "chunks": [str(p) for p in chunk_paths],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Audit deep-analysis Discord delivery chunks")
    ap.add_argument("--report", required=True)
    ap.add_argument("--reply")
    ap.add_argument("--chunk-dir")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    report = Path(args.report)
    reply = Path(args.reply) if args.reply else report.with_suffix(report.suffix + ".discord_reply.md")
    chunk_dir = Path(args.chunk_dir) if args.chunk_dir else report.with_suffix(report.suffix + ".discord_chunks")
    result = audit(report, reply, chunk_dir)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif result["ok"]:
        print("AUDIT_PASS")
        print(f"- Clean user-visible chunks: {result['chunkCount']} chunk(s), contiguous and marker-free.")
        print("- Required 5-day swing-plan section family is present in combined chunks.")
        print("- Canonical ticket, orderability, and risk tables are present.")
        print("- Final chunk contains the Final verdict.")
    else:
        print("AUDIT_FAIL")
        for f in result["failures"]:
            print(f"- {f}")
        for w in result["warnings"]:
            print(f"- warning: {w}")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
